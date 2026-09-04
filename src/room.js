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
    pendingTarget: 0
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
        voice: false
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
        ws.serializeAttachment(att);

        ws.send(JSON.stringify({ t: 'you', id: att.id }));
        ws.send(JSON.stringify({ t: 'state', ...this.publicState() }));
        ws.send(JSON.stringify({ t: 'history', messages: this.chat }));

        // Only on a first hello — a reconnect shouldn't re-announce them.
        if (!named) this.broadcast({ t: 'system', text: `${att.name} joined` });
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

      // Voice presence, so peers know who to dial and the rail knows who is live.
      case 'voice': {
        const att = ws.deserializeAttachment() || {};
        att.voice = !!msg.on;
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

      case 'play':
        await this.beginReadyCheck(this.currentTarget());
        return;

      case 'pause': {
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
    // The socket is already closing; roster goes out to whoever is left.
    const name = this.nameOf(ws);
    this.broadcast({ t: 'system', text: `${name} left` });
    this.broadcastRoster();
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

  broadcastRoster() {
    const peers = this.ctx.getWebSockets().map((ws) => {
      const a = ws.deserializeAttachment() || {};
      return {
        id: a.id,
        name: a.name || 'guest',
        ready: !!a.ready,
        drift: a.drift ?? null,
        buffered: a.buffered || 0,
        voice: !!a.voice
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
