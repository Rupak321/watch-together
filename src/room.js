/**
 * One Durable Object instance per room.
 *
 * Holds the authoritative playback state and answers clock pings. It never
 * broadcasts a bare position — always an anchor (movie time) plus the wall
 * clock that anchor was true at, so a client joining mid-gap still computes
 * the right target without polling.
 */

const READY_TIMEOUT_MS = 8000;
const START_LEAD_MS = 500;
const CHAT_KEEP = 50;      // enough for a late joiner to catch the thread
const CHAT_MAX_LEN = 300;
const REACTIONS = ['😂', '😭', '🔥', '😱', '❤️'];

function defaultState() {
  return {
    playing: false,
    anchorTime: 0,           // movie position in seconds
    anchorClock: Date.now(), // server wall clock that anchorTime was true at
    rate: 1,
    source: null,            // { kind, id } — set by whoever picks the video
    phase: 'idle',           // 'idle' | 'preparing' | 'playing'
    pendingTarget: 0,

    // Whoever opens the room. Keyed off a value the browser keeps, not the
    // connection id, so a refresh does not hand the room to someone else.
    hostKey: null,
    pausePolicy: 'anyone'    // 'anyone' | 'host'
  };
}

export class Room {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.state = defaultState();
    this.chat = [];

    ctx.blockConcurrencyWhile(async () => {
      const [stored, chat] = await Promise.all([ctx.storage.get('state'), ctx.storage.get('chat')]);
      if (stored) this.state = stored;
      if (Array.isArray(chat)) this.chat = chat;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Hibernation API: the object can sleep between messages without
      // dropping connections, which is what keeps us inside the free tier.
      this.ctx.acceptWebSocket(server);

      // A stable per-connection id. WebRTC signalling has to address one
      // specific peer, and names are neither unique nor stable enough.
      server.serializeAttachment({
        id: crypto.randomUUID().slice(0, 8),
        name: 'guest',
        ready: false,
        drift: null,
        buffered: 0,
        mesh: false,
        mic: false,
        live: false
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.t) {
      // Clock probe. Answered immediately with the client's own timestamp
      // echoed back so it can compute round-trip time itself.
      case 'ping':
        ws.send(JSON.stringify({ t: 'pong', c: msg.c, s: Date.now() }));
        return;

      case 'hello': {
        const att = ws.deserializeAttachment() || {};
        const named = !!att.named;
        att.name = String(msg.name || 'guest').slice(0, 24);
        att.named = true;
        att.key = String(msg.key || '').slice(0, 64);

        // First person through the door owns the room.
        if (!this.state.hostKey && att.key) {
          this.state.hostKey = att.key;
          await this.save();
        }
        ws.serializeAttachment(att);

        ws.send(JSON.stringify({ t: 'you', id: att.id, host: this.isHost(ws) }));
        ws.send(JSON.stringify({ t: 'state', ...this.publicState() }));
        ws.send(JSON.stringify({ t: 'history', messages: this.chat }));

        // Announce only if this person is not already in the room under
        // another socket. `named` was per-socket, so a reconnect — which is
        // always a fresh socket — re-announced them every time.
        if (!named && !this.hasOtherSocketFor(ws, att.key)) {
          this.broadcast({ t: 'system', text: `${att.name} joined` });
        }
        this.broadcastRoster();
        return;
      }

      case 'chat': {
        const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LEN);
        if (!text) return;
        const entry = { name: this.nameOf(ws), text, at: Date.now() };
        this.chat.push(entry);
        if (this.chat.length > CHAT_KEEP) this.chat = this.chat.slice(-CHAT_KEEP);
        await this.ctx.storage.put('chat', this.chat);
        this.broadcast({ t: 'chat', ...entry });
        return;
      }

      case 'react': {
        // Fixed set, so a client can't inject arbitrary content into the overlay.
        if (!REACTIONS.includes(msg.emoji)) return;
        this.broadcast({ t: 'react', emoji: msg.emoji, name: this.nameOf(ws) });
        return;
      }

      // WebRTC offer/answer/ICE, relayed to exactly one peer. The room never
      // inspects the payload — it only knows who it goes to.
      case 'signal': {
        const from = (ws.deserializeAttachment() || {}).id;
        for (const peer of this.ctx.getWebSockets()) {
          if ((peer.deserializeAttachment() || {}).id !== msg.to) continue;
          try {
            peer.send(JSON.stringify({ t: 'signal', from, data: msg.data }));
          } catch {}
          return;
        }
        return;
      }

      // `mesh` says a peer connection should exist; `mic` says they are
      // actually sending audio. Someone watching a shared screen needs the
      // first without the second.
      case 'presence': {
        const att = ws.deserializeAttachment() || {};
        att.mesh = !!msg.mesh;
        att.mic = !!msg.mic;
        att.live = !!msg.live;
        ws.serializeAttachment(att);
        this.broadcastRoster();
        return;
      }

      case 'source': {
        this.state.source = msg.source || null;
        this.state.playing = false;
        this.state.phase = 'idle';
        this.state.anchorTime = 0;
        this.state.anchorClock = Date.now();
        await this.save();
        this.broadcast({ t: 'state', ...this.publicState() });
        return;
      }

      /**
       * Shared browsing — an address, not a film.
       *
       * This moves everyone's embedded browser to the same page. It does not
       * and cannot synchronise what plays there: each viewer's iframe loads
       * its own copy of the page with its own player, and a cross-origin
       * frame exposes no position, no play and no seek to the page holding
       * it. So this is co-navigation, and the room's clock stays out of it.
       */
      case 'browse': {
        const url = String(msg.url || '').slice(0, 2000);
        if (!/^https?:\/\//i.test(url)) return;

        const att = ws.deserializeAttachment() || {};
        this.state.browseUrl = url;

        // Say who is driving, once, rather than on every navigation.
        if (this.state.browseBy !== att.id) {
          this.state.browseBy = att.id;
          this.broadcast({ t: 'system', text: `${att.name || 'guest'} is browsing together` });
        }
        await this.save();
        this.broadcast({ t: 'browse', url, by: att.id, byName: att.name || 'guest' });
        return;
      }

      case 'settings': {
        if (!this.isHost(ws)) return;
        if (msg.pausePolicy === 'anyone' || msg.pausePolicy === 'host') {
          this.state.pausePolicy = msg.pausePolicy;
          await this.save();
          this.broadcast({ t: 'state', ...this.publicState() });
          this.broadcast({
            t: 'system',
            text:
              msg.pausePolicy === 'host'
                ? 'Only the host can control playback now'
                : 'Anyone can control playback now'
          });
        }
        return;
      }

      case 'play':
        if (!this.canControl(ws)) return this.denied(ws);
        await this.beginReadyCheck(this.currentTarget());
        return;

      case 'pause': {
        if (!this.canControl(ws)) return this.denied(ws);
        this.state.anchorTime = this.currentTarget();
        this.state.anchorClock = Date.now();
        this.state.playing = false;
        this.state.phase = 'idle';
        await this.ctx.storage.deleteAlarm();
        await this.save();
        this.broadcast({ t: 'state', ...this.publicState(), by: this.nameOf(ws) });
        return;
      }

      case 'seek':
        if (!this.canControl(ws)) return this.denied(ws);
        await this.beginReadyCheck(Math.max(0, Number(msg.time) || 0));
        return;

      case 'ready': {
        const att = ws.deserializeAttachment() || {};
        att.ready = true;
        ws.serializeAttachment(att);
        this.broadcastRoster();
        if (this.state.phase === 'preparing' && this.everyoneReady()) {
          await this.startPlayback();
        }
        return;
      }

      // Telemetry for the roster — how far off each client is, and how much
      // runway it has buffered. Drives the "catching up" band in the UI.
      case 'status': {
        const att = ws.deserializeAttachment() || {};
        att.drift = typeof msg.drift === 'number' ? msg.drift : null;
        att.buffered = typeof msg.buffered === 'number' ? msg.buffered : 0;
        ws.serializeAttachment(att);
        this.broadcastRoster();
        return;
      }
    }
  }

  webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};

    // A reconnect closes the old socket after opening the new one, so only
    // call it a departure when nothing else of theirs is still connected.
    if (!this.hasOtherSocketFor(ws, att.key)) {
      this.broadcast({ t: 'system', text: `${att.name || 'guest'} left` });
    }

    let changed = false;

    // A shared screen dies with the person sharing it. Leaving the source in
    // place strands everyone else on "Connecting to the shared screen".
    if (this.state.source?.kind === 'screen' && this.state.source.id === att.id) {
      this.state.source = null;
      this.state.playing = false;
      this.state.phase = 'idle';
      changed = true;
    }

    // If the host walks out while only the host may control playback, the
    // room is left with nobody able to press play. Hand it to whoever is
    // still here rather than stranding them.
    if (att.key && att.key === this.state.hostKey && !this.hasOtherSocketFor(ws, att.key)) {
      const heir = this.ctx
        .getWebSockets()
        .map((s) => (s.deserializeAttachment() || {}).key)
        .find((k) => k && k !== att.key);

      if (heir) {
        this.state.hostKey = heir;
        this.broadcast({ t: 'system', text: 'The host left — you have the room now' });
      } else {
        // Nobody left to inherit it; do not leave a locked room behind.
        this.state.hostKey = null;
        this.state.pausePolicy = 'anyone';
      }
      changed = true;
    }

    if (changed) {
      this.ctx.waitUntil(this.save());
      this.broadcast({ t: 'state', ...this.publicState() });
    }

    this.broadcastRoster();
  }

  /** Is this person present under some other socket? (i.e. a reconnect) */
  hasOtherSocketFor(ws, key) {
    if (!key) return false;
    return this.ctx
      .getWebSockets()
      .some((s) => s !== ws && (s.deserializeAttachment() || {}).key === key);
  }

  webSocketError(ws) {
    this.broadcastRoster();
  }

  /** Ready-check timed out. Start anyway — stragglers get pulled in by drift correction. */
  async alarm() {
    if (this.state.phase === 'preparing') {
      await this.startPlayback();
    }
  }

  // ---------------------------------------------------------------- internals

  /** Where the movie should be right now, given the current anchor. */
  currentTarget() {
    if (!this.state.playing) return this.state.anchorTime;
    return this.state.anchorTime + ((Date.now() - this.state.anchorClock) / 1000) * this.state.rate;
  }

  publicState() {
    return {
      playing: this.state.playing,
      anchorTime: this.state.anchorTime,
      anchorClock: this.state.anchorClock,
      rate: this.state.rate,
      source: this.state.source,
      phase: this.state.phase,
      pausePolicy: this.state.pausePolicy,
      // So someone arriving late lands on the page the room is already on.
      browseUrl: this.state.browseUrl || null,
      serverClock: Date.now()
    };
  }

  async beginReadyCheck(target) {
    this.state.phase = 'preparing';
    this.state.playing = false;
    this.state.pendingTarget = target;
    this.state.anchorTime = target;
    this.state.anchorClock = Date.now();

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      att.ready = false;
      ws.serializeAttachment(att);
    }

    await this.save();
    this.broadcast({ t: 'prepare', target });
    this.broadcastRoster();

    // An alarm, not setTimeout — a hibernating object has no live timers.
    await this.ctx.storage.setAlarm(Date.now() + READY_TIMEOUT_MS);
  }

  async startPlayback() {
    const startClock = Date.now() + START_LEAD_MS;
    this.state.playing = true;
    this.state.phase = 'playing';
    this.state.anchorTime = this.state.pendingTarget;
    this.state.anchorClock = startClock;

    await this.ctx.storage.deleteAlarm();
    await this.save();

    // Everyone starts on the same *future* timestamp rather than on receipt,
    // which absorbs the spread in message delivery.
    this.broadcast({ t: 'playat', clock: startClock, time: this.state.pendingTarget });
    this.broadcast({ t: 'state', ...this.publicState() });
  }

  everyoneReady() {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return false;
    return sockets.every((ws) => (ws.deserializeAttachment() || {}).ready === true);
  }

  nameOf(ws) {
    return (ws.deserializeAttachment() || {}).name || 'guest';
  }

  isHost(ws) {
    const key = (ws.deserializeAttachment() || {}).key;
    return !!key && key === this.state.hostKey;
  }

  canControl(ws) {
    return this.state.pausePolicy !== 'host' || this.isHost(ws);
  }

  /** Say why, rather than letting a dead button look broken. */
  denied(ws) {
    try {
      ws.send(JSON.stringify({ t: 'denied', reason: 'Only the host can control playback in this room.' }));
    } catch {}
  }

  broadcastRoster() {
    const peers = this.ctx.getWebSockets().map((ws) => {
      const a = ws.deserializeAttachment() || {};
      return {
        id: a.id,
        name: a.name || 'guest',
        ready: !!a.ready,
        drift: a.drift ?? null,
        buffered: a.buffered || 0,
        mesh: !!a.mesh,
        mic: !!a.mic,
        live: !!a.live,
        host: !!a.key && a.key === this.state.hostKey
      };
    });
    this.broadcast({ t: 'roster', peers });
  }

  broadcast(obj) {
    const payload = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Socket died between getWebSockets() and send; the close handler will tidy up.
      }
    }
  }

  async save() {
    await this.ctx.storage.put('state', this.state);
  }
}
