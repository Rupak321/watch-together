import { SyncClock, DriftCorrector, targetPosition } from './sync.js';
import { identifySource, createSource } from './adapters.js';
import { VoiceMesh } from './voice.js';

const TICK_MS = 250;
const READY_FALLBACK_MS = 7000;   // the room gives up at 8s; beat it
const CONTROLS_IDLE_MS = 3000;
const FLOAT_CHAT_MS = 8000;
const BEHIND_S = 1.0;             // when to tell the room someone is catching up

const el = (id) => document.getElementById(id);
const clock = new SyncClock();

let ws = null;
let source = null;
let corrector = null;
let ticker = null;

let roomCode = '';
let myName = 'guest';
let myId = null;
let voice = null;
let nudgeMs = 0;
let loadedKey = null;
let readyTimer = null;
let controlsTimer = null;

let roomState = { playing: false, anchorTime: 0, anchorClock: Date.now(), rate: 1, source: null, phase: 'idle' };
let pendingStart = null;
let desiredPlaying = false;

// ------------------------------------------------------------------- setup

roomCode = decodeURIComponent(location.pathname.split('/').filter(Boolean)[1] || '').toUpperCase();
el('gateCode').textContent = roomCode;
el('codeVal').textContent = roomCode;
document.title = `${roomCode} · Watch Together`;

try {
  const saved = localStorage.getItem('wt:name');
  if (saved) el('nameInput').value = saved;
} catch {}

el('enterBtn').addEventListener('click', enterRoom);
el('nameInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') enterRoom();
});

function enterRoom() {
  const name = el('nameInput').value.trim();
  if (!name) {
    el('gateNotice').textContent = 'Add a name so people know who joined.';
    el('gateNotice').hidden = false;
    el('nameInput').focus();
    return;
  }
  myName = name;
  try {
    localStorage.setItem('wt:name', name);
  } catch {}

  el('gate').hidden = true;
  el('room').hidden = false;
  setupVoice();
  connect();
}

// ------------------------------------------------------------------- voice

function setupVoice() {
  voice = new VoiceMesh(send, {
    onSpeaking: (id, on) => tiles.get(id)?.classList.toggle('speaking', on),

    // Remote voices dip the film, never your own. Every source implements
    // setVolume, so this works the same for a file and for YouTube.
    onDuck: (level) => source?.setVolume?.(level),

    onPeerStream: (id, stream) => {
      const tile = tiles.get(id);
      if (!tile) return;
      const hasVideo = stream.getVideoTracks().some((t) => t.readyState === 'live');
      tile.classList.toggle('has-video', hasVideo);
      if (!hasVideo) {
        tile.querySelector('video')?.remove();
        return;
      }
      let v = tile.querySelector('video');
      if (!v) {
        v = document.createElement('video');
        v.autoplay = true;
        v.playsInline = true;
        v.muted = true; // audio comes through the peer's own <audio> element
        tile.appendChild(v);
      }
      if (v.srcObject !== stream) v.srcObject = stream;
    },

    onPeerGone: (id) => {
      const tile = tiles.get(id);
      tile?.classList.remove('has-video', 'speaking');
      tile?.querySelector('video')?.remove();
    },

    onThrottle: (tight) => {
      if (tight) showBand('Cameras dimmed — protecting playback', '');
      else if (roomState.phase !== 'preparing') hideBand();
    },

    onError: (err) => {
      el('voiceNotice').textContent = err.message;
      el('voiceNotice').hidden = false;
    }
  });
  if (myId) voice.setMyId(myId);
}

function renderVoiceButtons() {
  const on = !!voice?.micOn;
  for (const b of document.querySelectorAll('.js-mic')) {
    b.dataset.on = String(on);
    b.textContent = on ? 'On voice' : 'Join voice';
  }
  for (const b of document.querySelectorAll('.js-cam')) {
    b.hidden = !on;
    b.dataset.on = String(!!voice?.camOn);
    b.textContent = voice?.camOn ? 'Camera on' : 'Camera';
  }
  el('voiceOpts').hidden = !on;
}

document.querySelectorAll('.js-mic').forEach((b) =>
  b.addEventListener('click', async () => {
    el('voiceNotice').hidden = true;
    try {
      if (voice.micOn) voice.disableMic();
      else await voice.enableMic();
    } catch (err) {
      el('voiceNotice').textContent =
        err.name === 'NotAllowedError'
          ? 'Microphone access was blocked. Allow it in your browser’s site settings, then try again.'
          : 'No microphone found on this device.';
      el('voiceNotice').hidden = false;
    }
    renderVoiceButtons();
  })
);

document.querySelectorAll('.js-cam').forEach((b) =>
  b.addEventListener('click', async () => {
    el('voiceNotice').hidden = true;
    try {
      await voice.setCamera(!voice.camOn, roomState.playing);
    } catch {
      el('voiceNotice').textContent = 'Camera access was blocked or no camera was found.';
      el('voiceNotice').hidden = false;
    }
    renderVoiceButtons();
  })
);

el('pttToggle').addEventListener('change', (e) => voice.setPushToTalk(e.target.checked));
el('muteToggle').addEventListener('change', (e) => voice.setMuted(e.target.checked));

// Hold T to talk. Space is already playback, as it is in every player.
document.addEventListener('keydown', (e) => {
  if (e.repeat || e.target.matches('input, textarea')) return;
  if (e.code === 'KeyT') voice?.setPttHeld(true);
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'KeyT') voice?.setPttHeld(false);
});

// -------------------------------------------------------------- connection

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(roomCode)}`);

  ws.addEventListener('open', () => {
    setConn('connected');
    send({ t: 'hello', name: myName });
    schedulePing();
  });
  ws.addEventListener('message', (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    handle(m);
  });
  ws.addEventListener('close', () => {
    setConn('reconnecting');
    setTimeout(connect, 1500);
  });
  ws.addEventListener('error', () => setConn('connection trouble'));
}

function send(o) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o));
}

function schedulePing() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  send({ t: 'ping', c: Date.now() });
  setTimeout(schedulePing, clock.nextPingDelay());
}

function setConn(s) {
  el('connLabel').textContent = s;
}

// ---------------------------------------------------------------- messages

function handle(m) {
  switch (m.t) {
    case 'you':
      myId = m.id;
      voice?.setMyId(myId);
      return;

    case 'signal':
      voice?.onSignal(m.from, m.data);
      return;

    case 'pong':
      clock.addSample(m.c, m.s, Date.now());
      el('mOffset').textContent = `${Math.round(clock.offset)}ms`;
      el('mRtt').textContent = clock.rtt === null ? '—' : `${Math.round(clock.rtt)}ms`;
      return;

    case 'state':
      roomState = { ...roomState, ...m };
      if (m.source) loadSource(m.source);
      else clearSource();
      if (!m.playing) pendingStart = null;
      desiredPlaying = !!m.playing;
      setMode(m.playing ? 'house' : 'foyer');
      // Cameras run at a lower profile once the film starts, and relax again
      // when it stops.
      voice?.reprofileCamera(!!m.playing);
      renderState();
      return;

    case 'prepare':
      onPrepare(m.target);
      return;

    case 'playat':
      pendingStart = { clock: m.clock, time: m.time };
      if (source) source.seek(m.time);
      return;

    case 'roster':
      renderRoster(m.peers || []);
      return;

    case 'chat':
      addChat(m.name, m.text);
      return;

    case 'history':
      for (const c of m.messages || []) addChat(c.name, c.text, true);
      return;

    case 'react':
      popReaction(m.emoji);
      return;

    case 'system':
      addSystem(m.text);
      return;
  }
}

// ------------------------------------------------------------------ source

async function loadSource(s) {
  const key = `${s.kind}:${s.id}`;
  if (loadedKey === key) return;
  loadedKey = key;

  if (source) {
    source.destroy();
    source = null;
    corrector = null;
  }

  el('stageEmpty').hidden = true;
  el('titleLabel').textContent = s.title || labelFor(s);
  el('metaLabel').innerHTML = '<span class="spin"></span> loading';

  try {
    source = await createSource(el('stage'), s);
    corrector = new DriftCorrector(source);
    const bits = [s.kind];
    if (s.part) bits.push(`part ${s.part.index}${s.part.total ? ` of ${s.part.total}` : ''}`);
    if (!source.supportsFineRate) bits.push('coarse sync');
    el('metaLabel').textContent = bits.join(' · ');
    el('startBtn').disabled = false;
    el('srcNotice').hidden = true;
    startTicking();
  } catch (err) {
    loadedKey = null;
    el('stageEmpty').hidden = false;
    el('metaLabel').textContent = 'could not load';
    el('startBtn').disabled = true;
    showSrcError(err.message);
  }
}

function clearSource() {
  if (!source) return;
  source.destroy();
  source = null;
  corrector = null;
  loadedKey = null;
  el('stageEmpty').hidden = false;
  el('startBtn').disabled = true;
  el('titleLabel').textContent = 'No source yet';
  el('metaLabel').textContent = 'Pick something to watch';
}

function labelFor(s) {
  if (s.kind === 'youtube') return 'YouTube video';
  if (s.kind === 'test') return 'Sync test clock';
  try {
    return decodeURIComponent(new URL(s.id).pathname.split('/').pop()) || 'Video';
  } catch {
    return 'Video';
  }
}

function showSrcError(msg) {
  el('srcNotice').textContent = msg;
  el('srcNotice').hidden = false;
}

// ------------------------------------------------------------ ready check

function onPrepare(target) {
  if (!source) return;
  clearTimeout(readyTimer);

  desiredPlaying = false;
  pendingStart = null;
  source.pause();
  source.seek(target);
  if (corrector) corrector.reset();

  let reported = false;
  const report = () => {
    if (reported) return;
    reported = true;
    clearTimeout(readyTimer);
    send({ t: 'ready', time: target });
  };
  const poll = () => {
    if (reported) return;
    if (source.isReady()) return report();
    readyTimer = setTimeout(poll, 200);
  };

  poll();
  setTimeout(report, READY_FALLBACK_MS);
}

// -------------------------------------------------------------------- tick

function startTicking() {
  if (ticker) return;
  ticker = new Worker('/tick-worker.js');
  ticker.onmessage = tick;
  ticker.postMessage({ cmd: 'start', intervalMs: TICK_MS });
}

function tick() {
  if (!source || !corrector || !clock.locked) return;
  const now = clock.now();

  if (pendingStart) {
    if (now < pendingStart.clock) return;
    pendingStart = null;
    desiredPlaying = true;
    source.play();
  }

  if (!desiredPlaying) {
    source.pause();
    el('mAction').textContent = roomState.phase === 'preparing' ? 'buffering' : 'paused';
    renderPosition();
    return;
  }

  // The nudge is this device's own correction against what it can see on
  // another screen in the same room. It never leaves this browser.
  const target = targetPosition(roomState, now) + nudgeMs / 1000;
  const drift = corrector.correct(target);

  el('mDrift').textContent = `${drift >= 0 ? '+' : ''}${Math.round(drift * 1000)}ms`;
  el('mAction').textContent = corrector.lastAction;

  const off = Math.abs(drift) > 0.35;
  el('syncDot').classList.toggle('warn', off);
  el('syncLabel').textContent = off ? 'catching up' : 'in sync';

  renderPosition();

  if (tick.n === undefined) tick.n = 0;
  if (++tick.n % 8 === 0) {
    const buffered = source.getBufferedAhead();
    send({ t: 'status', drift, buffered });
    // Video is the first thing to give up when the film runs short of runway.
    voice?.applyBufferPressure(buffered, true);
  }
}

function renderPosition() {
  if (!source) return;
  el('posLabel').textContent = fmt(source.getCurrentTime());
  el('durLabel').textContent = fmt(source.getDuration ? source.getDuration() : 0);
}

function fmt(s) {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// ------------------------------------------------------------- houselights

function setMode(mode) {
  const room = el('room');
  if (room.dataset.mode === mode) return;
  room.dataset.mode = mode;
  el('lightsBtn').textContent = mode === 'house' ? 'Lights up' : 'Lights down';
  if (mode === 'house') wakeControls();
}

function renderState() {
  el('playBtn').textContent = roomState.playing ? 'Pause' : 'Play';
  el('startBtn').textContent = roomState.playing ? 'Playing' : 'Start';
  el('startBtn').disabled = !source || roomState.playing;
}

// ----------------------------------------------------------------- roster

// Tiles are kept and updated rather than rebuilt: a peer's <video> element
// lives inside its tile, and re-creating the row on every roster message
// would tear down the stream several times a second.
const tiles = new Map();

function renderRoster(peers) {
  const list = el('roster');
  list.innerHTML = '';
  const rail = el('rail');

  let behind = null;
  const seen = new Set();

  for (const p of peers) {
    seen.add(p.id);

    const li = document.createElement('li');
    const pip = document.createElement('span');
    pip.className = 'pip' + (p.voice ? '' : ' wait');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name + (p.id === myId ? ' (you)' : '');
    const st = document.createElement('span');
    st.className = 'st';

    // `ready` only carries meaning during a ready-check. Outside one, showing
    // "loading" for somebody who is simply sitting in the foyer is a lie.
    const lag = p.drift === null ? 0 : -p.drift;
    if (roomState.phase === 'preparing') st.textContent = p.ready ? 'ready' : 'buffering';
    else if (!roomState.playing) st.textContent = p.voice ? 'on voice' : 'here';
    else if (lag > BEHIND_S) st.textContent = `${lag.toFixed(1)}s behind`;
    else st.textContent = 'in sync';

    li.append(pip, nm, st);
    list.appendChild(li);

    let tile = tiles.get(p.id);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      const label = document.createElement('span');
      label.className = 'initials';
      tile.appendChild(label);
      tiles.set(p.id, tile);
      rail.appendChild(tile);
    }
    tile.title = p.name;
    tile.querySelector('.initials').textContent = p.name.slice(0, 2).toUpperCase();
    tile.classList.toggle('behind', lag > BEHIND_S);

    if (lag > BEHIND_S && (!behind || lag > behind.lag)) behind = { name: p.name, lag };
  }

  for (const [id, tile] of tiles) {
    if (!seen.has(id)) {
      tile.remove();
      tiles.delete(id);
    }
  }

  voice?.onRoster(peers);

  if (behind) showBand(`${behind.name} is catching up`, `${behind.lag.toFixed(1)}s behind`);
  else if (roomState.phase !== 'preparing') hideBand();
}

function showBand(text, right) {
  el('bandText').textContent = text;
  el('bandRight').textContent = right || '';
  el('band').classList.add('show');
}
function hideBand() {
  el('band').classList.remove('show');
}

// ------------------------------------------------------------------- chat

function addChat(name, text, quiet) {
  const line = document.createElement('div');
  line.className = 'msg';
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = name + ' ';
  line.append(who, document.createTextNode(text));
  el('chatLog').appendChild(line);
  el('chatLog').scrollTop = el('chatLog').scrollHeight;

  // While the lights are down, chat rises over the film and leaves again —
  // a persistent panel would either cover the picture or shrink it.
  if (!quiet && el('room').dataset.mode === 'house') {
    const f = document.createElement('div');
    f.className = 'line';
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = name + ' ';
    f.append(w, document.createTextNode(text));
    el('floatChat').appendChild(f);
    setTimeout(() => {
      f.classList.add('leaving');
      setTimeout(() => f.remove(), 700);
    }, FLOAT_CHAT_MS);
  }
}

function addSystem(text) {
  const line = document.createElement('div');
  line.className = 'msg sys';
  line.textContent = text;
  el('chatLog').appendChild(line);
  el('chatLog').scrollTop = el('chatLog').scrollHeight;
}

el('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = el('chatInput').value.trim();
  if (!text) return;
  send({ t: 'chat', text });
  el('chatInput').value = '';
});

// -------------------------------------------------------------- reactions

function popReaction(emoji) {
  const pop = document.createElement('div');
  pop.className = 'pop';
  pop.textContent = emoji;
  pop.style.left = `${8 + Math.random() * 78}%`;
  el('reactions').appendChild(pop);
  setTimeout(() => pop.remove(), 2500);
}

el('reactStrip').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-emoji]');
  if (b) send({ t: 'react', emoji: b.dataset.emoji });
});

// ---------------------------------------------------------------- controls

function wakeControls() {
  el('stageWrap').classList.add('awake');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => {
    if (el('room').dataset.mode === 'house') el('stageWrap').classList.remove('awake');
  }, CONTROLS_IDLE_MS);
}

['pointermove', 'pointerdown', 'touchstart'].forEach((ev) =>
  el('stageWrap').addEventListener(ev, wakeControls, { passive: true })
);

el('playBtn').addEventListener('click', () => send({ t: roomState.playing ? 'pause' : 'play' }));
el('startBtn').addEventListener('click', () => send({ t: 'play' }));
el('lightsBtn').addEventListener('click', () => {
  setMode(el('room').dataset.mode === 'house' ? 'foyer' : 'house');
});

el('fullBtn').addEventListener('click', () => {
  const wrap = el('stageWrap');
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap.requestFullscreen?.().catch(() => {});
});

el('copyBtn').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText(location.href);
    e.currentTarget.textContent = 'Copied';
    setTimeout(() => (e.currentTarget.textContent = 'Copy link'), 1600);
  } catch {
    e.currentTarget.textContent = 'Press ⌘C';
  }
});

el('leaveBtn').addEventListener('click', () => (location.href = '/'));

// Space toggles playback, the way it does in every player.
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    send({ t: roomState.playing ? 'pause' : 'play' });
  }
});

// --------------------------------------------------------------- sync panel

el('syncBtn').addEventListener('click', () => {
  const p = el('syncPanel');
  p.hidden = !p.hidden;
  el('syncBtn').setAttribute('aria-expanded', String(!p.hidden));
});

el('nudge').addEventListener('input', (e) => {
  nudgeMs = Number(e.target.value);
  el('nudgeVal').textContent = `${nudgeMs > 0 ? '+' : ''}${nudgeMs}ms`;
});

// ------------------------------------------------------------ source picker

function selectTab(which) {
  const link = which === 'link';
  el('tabLink').setAttribute('aria-selected', String(link));
  el('tabArchive').setAttribute('aria-selected', String(!link));
  el('paneLink').hidden = !link;
  el('paneArchive').hidden = link;
}
el('tabLink').addEventListener('click', () => selectTab('link'));
el('tabArchive').addEventListener('click', () => selectTab('archive'));

function setSourceFromInput() {
  const parsed = identifySource(el('srcInput').value);
  if (!parsed) {
    showSrcError('That does not look like a YouTube link or a direct video URL.');
    return;
  }
  el('srcNotice').hidden = true;
  send({ t: 'source', source: parsed });
  el('srcInput').value = '';
}
el('srcBtn').addEventListener('click', setSourceFromInput);
el('srcInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') setSourceFromInput();
});

async function searchArchive() {
  const q = el('arcInput').value.trim();
  if (!q) return;
  el('arcHint').innerHTML = '<span class="spin"></span> searching';
  el('arcResults').innerHTML = '';
  try {
    const res = await fetch(`/api/archive/search?q=${encodeURIComponent(q)}`);
    const { results } = await res.json();
    if (!results.length) {
      el('arcHint').textContent = 'Nothing found. Try a different title.';
      return;
    }
    el('arcHint').textContent = `${results.length} results`;
    for (const r of results) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.innerHTML = '';
      b.appendChild(document.createTextNode(r.title));
      const yr = document.createElement('span');
      yr.className = 'yr';
      yr.textContent = r.year ? `${r.year} · ${r.id}` : r.id;
      b.appendChild(yr);
      b.addEventListener('click', () => pickArchive(r, b));
      li.appendChild(b);
      el('arcResults').appendChild(li);
    }
  } catch {
    el('arcHint').textContent = 'Search is unavailable right now.';
  }
}

async function pickArchive(r, btn) {
  btn.disabled = true;
  el('arcHint').innerHTML = '<span class="spin"></span> finding a playable file';
  try {
    const res = await fetch(`/api/archive/pick?id=${encodeURIComponent(r.id)}`);
    if (!res.ok) throw new Error();
    const { url, title, part } = await res.json();
    send({ t: 'source', source: { kind: 'file', id: url, title: title || r.title, part } });

    // Some archive items only hold a feature cut into reels. Say so plainly
    // rather than letting people wonder why it ends after twenty minutes.
    el('arcHint').textContent = part
      ? `Loading part ${part.index}${part.total ? ` of ${part.total}` : ''} — this item is split into reels`
      : 'Loading for everyone';
  } catch {
    el('arcHint').textContent = 'That item has no file this browser can play. Try another.';
  } finally {
    btn.disabled = false;
  }
}

el('arcBtn').addEventListener('click', searchArchive);
el('arcInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') searchArchive();
});
