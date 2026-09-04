import { SyncClock, DriftCorrector, targetPosition } from './sync.js';
import { identifySource, createSource, createStreamSource } from './adapters.js';
import { VoiceMesh } from './voice.js';
import { Uploader, hasResumable, humanSize } from './upload.js';

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
let isHost = false;
let voice = null;
let nudgeMs = 0;

// Two separate volumes, because they are two separate problems: a film mixed
// too loud, and a friend who is too quiet. Ducking multiplies into the film's
// setting rather than replacing it, so dipping for speech never undoes the
// level someone chose.
let movieVolume = 1;
let duckLevel = 1;

function applyMovieVolume() {
  source?.setVolume?.(movieVolume * duckLevel);
}

function loadVolumes() {
  try {
    const m = parseFloat(localStorage.getItem('wt:vol:movie'));
    const v = parseFloat(localStorage.getItem('wt:vol:voice'));
    if (!isNaN(m)) movieVolume = m;
    if (!isNaN(v)) return v;
  } catch {}
  return 1;
}
let loadedKey = null;
let readyTimer = null;
let controlsTimer = null;

let roomState = {
  playing: false, anchorTime: 0, anchorClock: Date.now(), rate: 1,
  source: null, phase: 'idle', pausePolicy: 'anyone'
};
let pendingStart = null;
let desiredPlaying = false;
let playbackApplied = null; // what we last told the player, so we do not spam it

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

  // Restore whatever levels they last chose, and push them into the sliders
  // so the UI and the audio path never disagree.
  const savedVoice = loadVolumes();
  setMovieVolume(Math.round(movieVolume * 100));
  setVoiceVolume(Math.round(savedVoice * 100));
  renderVoiceButtons(); // drive the buttons from state, not from HTML defaults

  connect();
}

// ------------------------------------------------------------------- voice

function setupVoice() {
  voice = new VoiceMesh(send, {
    onSpeaking: (id, on) => tiles.get(id)?.classList.toggle('speaking', on),

    // Remote voices dip the film, never your own. Every source implements
    // setVolume, so this works the same for a file and for YouTube.
    onDuck: (level) => {
      duckLevel = level;
      applyMovieVolume();
    },

    onPeerStream: (id, stream) => {
      const tile = tiles.get(id);
      if (!tile) return;
      const hasVideo = !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
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

    onScreenStream: (_id, stream) => mountStream(stream),

    onScreenEnded: () => {
      // They hit the browser's own "Stop sharing" bar. Clear the room's
      // source too, or everyone stares at a frozen last frame.
      send({ t: 'source', source: null });
      renderScreenButton();
    },

    onThrottle: (tight) => {
      if (tight) showBand('Video paused — protecting playback', 'voice still on');
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
  // Camera stands on its own — being seen without being heard is a normal
  // thing to want, so this button is never gated behind the microphone.
  for (const b of document.querySelectorAll('.js-cam')) {
    b.hidden = false;
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

/**
 * A stable per-browser id, so host survives a refresh.
 *
 * Connection ids change on every reconnect — keying the host off one would
 * hand the room to whoever happened to be connected when the host reloaded.
 */
function clientKey() {
  try {
    let k = localStorage.getItem('wt:key');
    if (!k) {
      k = crypto.randomUUID();
      localStorage.setItem('wt:key', k);
    }
    return k;
  } catch {
    // Private browsing with storage blocked: host simply won't persist.
    if (!clientKey.fallback) clientKey.fallback = crypto.randomUUID();
    return clientKey.fallback;
  }
}

// -------------------------------------------------------------- connection

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?room=${encodeURIComponent(roomCode)}`);

  ws.addEventListener('open', () => {
    setConn('connected');
    send({ t: 'hello', name: myName, key: clientKey() });
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
      isHost = !!m.host;
      voice?.setMyId(myId);
      renderHostControls();
      return;

    case 'denied':
      el('voiceNotice').textContent = m.reason;
      el('voiceNotice').hidden = false;
      setTimeout(() => (el('voiceNotice').hidden = true), 4000);
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
      // History is authoritative and arrives on every hello — including the
      // hello after a reconnect. Appending it would print the whole
      // conversation again each time the socket dropped.
      el('chatLog').innerHTML = '';
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
  const key = `${s.kind}:${s.id}:${s.streamId || ''}`;
  if (loadedKey === key) return;
  loadedKey = key;
  playbackApplied = null;

  // A shared screen arrives over WebRTC, not from a URL. The presenter mounts
  // their own capture; everyone else waits for the track to land and the
  // onScreenStream hook takes it from there.
  if (s.kind === 'screen') {
    if (source) {
      source.destroy();
      source = null;
      corrector = null;
    }
    el('titleLabel').textContent = s.title || 'Shared screen';
    el('metaLabel').textContent = 'live · no sync needed';
    voice?.setExpectedScreenStream(s.streamId);

    if (s.id === myId && voice?.screenStream) {
      mountStream(voice.screenStream);
    } else {
      el('stageEmpty').hidden = false;
      el('stageEmpty').querySelector('h2').textContent = 'Connecting to the shared screen';
      el('stageEmpty').querySelector('p').textContent = 'This starts as soon as the video reaches you.';
      // Receiving a screen needs a peer connection, which needs this client
      // on the mesh — but it does not need a microphone. Join to listen.
      voice?.watchOnly().catch(() => {});
    }
    return;
  }

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
    setPlayEnabled(true);
    el('srcNotice').hidden = true;
    applyMovieVolume(); // a fresh player starts at full, ignoring the chosen level
    startTicking();
  } catch (err) {
    loadedKey = null;
    el('stageEmpty').hidden = false;
    el('metaLabel').textContent = 'could not load';
    setPlayEnabled(false);
    showSrcError(err.message);
  }
}

/** Put a live MediaStream on the stage, reusing the player if one is already up. */
function mountStream(stream) {
  el('stageEmpty').hidden = true;
  if (source?.isLive) {
    source.replaceStream(stream);
  } else {
    source?.destroy();
    source = createStreamSource(el('stage'), stream);
    corrector = null; // a live stream has nothing to correct
  }
  setPlayEnabled(false);
  applyMovieVolume();
  startTicking();
}

function clearSource() {
  loadedKey = null;
  voice?.setExpectedScreenStream(null);

  source?.destroy();
  source = null;
  corrector = null;

  el('stageEmpty').hidden = false;
  // Restore the default copy — the screen-share path rewrites it in place.
  el('stageEmpty').querySelector('h2').textContent = 'Nothing playing yet';
  el('stageEmpty').querySelector('p').textContent =
    "Pick something from the panel — a YouTube link, a direct video URL, the public-domain archive, or share your screen.";
  setPlayEnabled(false);
  el('titleLabel').textContent = 'No source yet';
  el('metaLabel').textContent = 'Pick something to watch';
  renderScreenButton();
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
  // Keep the applied-state flag honest. Pausing here without recording it
  // left it reading "playing", so the tick after PLAY_AT saw nothing to do
  // and never started the player again.
  playbackApplied = false;
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
  if (!source) return;

  // A live stream is already the same moment for everyone — there is one
  // origin producing frames in real time. Correcting it would only shove
  // this viewer away from the presenter with no way back.
  if (source.isLive) {
    el('mDrift').textContent = 'live';
    el('mAction').textContent = 'no sync needed';
    el('syncDot').classList.remove('warn');
    el('syncLabel').textContent = 'live';
    renderPosition();
    return;
  }

  if (!corrector || !clock.locked) return;
  const now = clock.now();

  if (pendingStart) {
    if (now < pendingStart.clock) return;
    pendingStart = null;
    desiredPlaying = true;
  }

  if (!desiredPlaying) {
    if (playbackApplied !== false) {
      source.pause();
      playbackApplied = false;
    }
    el('mAction').textContent = roomState.phase === 'preparing' ? 'buffering' : 'paused';
    renderPosition();
    return;
  }

  // Drive the player from the desired state rather than only from the start
  // message. Someone joining a room that is already playing never receives a
  // `playat`, so nothing else would ever call play() for them — they used to
  // sit on a frozen frame while the corrector seeked it around underneath.
  if (playbackApplied !== true) {
    source.play();
    playbackApplied = true;
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

function setPlayEnabled(on) {
  for (const b of document.querySelectorAll('.js-play')) b.disabled = !on;
}

function renderState() {
  // One control, shown in two places. They used to disagree: the foyer button
  // only ever sent "play" and was disabled while playing, so pressing "Lights
  // up" mid-film hid the controls bar and left nothing that could pause.
  const label = roomState.playing ? 'Pause' : 'Play';
  for (const b of document.querySelectorAll('.js-play')) b.textContent = label;

  // A control you are not allowed to use should look that way, rather than
  // silently doing nothing when pressed.
  const mayControl = roomState.pausePolicy !== 'host' || isHost;
  for (const b of document.querySelectorAll('.js-play')) b.disabled = !source || !mayControl;
  el('seekBtn') && (el('seekBtn').disabled = !mayControl);

  renderHostControls();
}

function renderHostControls() {
  el('hostOpts').hidden = !isHost;
  el('policyNote').hidden = isHost || roomState.pausePolicy !== 'host';
  if (el('pausePolicy').value !== roomState.pausePolicy) {
    el('pausePolicy').value = roomState.pausePolicy || 'anyone';
  }
}

// ------------------------------------------------------------------ mixer

// The same two controls appear in the foyer panel and in the popover over the
// film. Driving every copy from one setter keeps them from disagreeing.
function paintVol(which, pct) {
  for (const s of document.querySelectorAll(`[data-vol="${which}"]`)) s.value = String(pct);
  for (const l of document.querySelectorAll(`[data-volval="${which}"]`)) l.textContent = `${pct}%`;
}

function setMovieVolume(pct) {
  movieVolume = pct / 100;
  paintVol('movie', pct);
  applyMovieVolume();
  try {
    localStorage.setItem('wt:vol:movie', String(movieVolume));
  } catch {}
}

function setVoiceVolume(pct) {
  const v = pct / 100;
  paintVol('voice', pct);
  voice?.setPeerVolume(v);
  try {
    localStorage.setItem('wt:vol:voice', String(v));
  } catch {}
}

document.addEventListener('input', (e) => {
  const which = e.target.dataset?.vol;
  if (which === 'movie') setMovieVolume(Number(e.target.value));
  else if (which === 'voice') setVoiceVolume(Number(e.target.value));
});

el('volBtn').addEventListener('click', () => {
  const p = el('volPanel');
  p.hidden = !p.hidden;
  el('volBtn').setAttribute('aria-expanded', String(!p.hidden));
});

el('pausePolicy').addEventListener('change', (e) => {
  send({ t: 'settings', pausePolicy: e.target.value });
});

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

    // Host can change mid-session — it passes on when the host leaves — so
    // track it from the roster rather than only from the hello reply.
    if (p.id === myId && p.host !== isHost) {
      isHost = !!p.host;
      renderHostControls();
    }

    const li = document.createElement('li');
    const pip = document.createElement('span');
    pip.className = 'pip' + (p.live ? '' : ' wait');
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = p.name + (p.id === myId ? ' (you)' : '');
    const st = document.createElement('span');
    st.className = 'st';

    // `ready` only carries meaning during a ready-check. Outside one, showing
    // "loading" for somebody who is simply sitting in the foyer is a lie.
    const lag = p.drift === null ? 0 : -p.drift;
    if (roomState.phase === 'preparing') st.textContent = p.ready ? 'ready' : 'buffering';
    else if (!roomState.playing) st.textContent = p.mic ? (p.live ? 'on voice' : 'muted') : p.mesh ? 'watching' : 'here';
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
    tile.classList.toggle('muted', p.mic && !p.live);

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

document.querySelectorAll('.js-play').forEach((b) =>
  b.addEventListener('click', () => send({ t: roomState.playing ? 'pause' : 'play' }))
);
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

const TABS = { link: 'paneLink', archive: 'paneArchive', screen: 'paneScreen', upload: 'paneUpload' };

function selectTab(which) {
  for (const [name, pane] of Object.entries(TABS)) {
    const on = name === which;
    el('tab' + name[0].toUpperCase() + name.slice(1)).setAttribute('aria-selected', String(on));
    el(pane).hidden = !on;
  }
}
for (const name of Object.keys(TABS)) {
  el('tab' + name[0].toUpperCase() + name.slice(1)).addEventListener('click', () => selectTab(name));
}

document.querySelectorAll('.js-screen').forEach((b) =>
  b.addEventListener('click', async () => {
    el('srcNotice').hidden = true;
    try {
      if (voice.screenStream) {
        voice.stopScreenShare();
        send({ t: 'source', source: null });
      } else {
        const stream = await voice.startScreenShare();
        // The stream id travels in the SDP, so announcing it here is what
        // lets every receiver tell this apart from a webcam.
        send({ t: 'source', source: { kind: 'screen', id: myId, streamId: stream.id, title: `${myName}'s screen` } });
      }
    } catch (err) {
      if (err.name !== 'NotAllowedError') {
        showSrcError('Screen sharing is not available in this browser.');
      }
    }
    renderScreenButton();
  })
);

function renderScreenButton() {
  const on = !!voice?.screenStream;
  for (const b of document.querySelectorAll('.js-screen')) {
    b.dataset.on = String(on);
    b.textContent = on ? 'Stop sharing' : 'Share my screen';
  }
}

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

// ----------------------------------------------------------------- upload

let uploader = null;

async function startUpload(file) {
  if (!file || uploader) return;

  el('upError').hidden = true;
  el('upFix').hidden = true;
  el('upStatus').hidden = false;
  el('upName').textContent = `${file.name} · ${humanSize(file.size)}`;
  el('upPct').textContent = hasResumable(file) ? 'resuming…' : 'checking the file…';
  el('upFill').style.width = '0%';

  uploader = new Uploader({
    onProbe: (probe, fix) => {
      if (probe.ok && probe.audio !== false) return;
      el('upStatus').hidden = true;
      el('upError').textContent = probe.reason;
      el('upError').hidden = false;
      if (fix) {
        // The exact command, with the working stream copied rather than
        // re-encoded — that difference is seconds against most of an hour.
        el('upFix').textContent = fix;
        el('upFix').hidden = false;
      }
    },
    onResume: (parts) => (el('upPct').textContent = `resuming from part ${parts + 1}`),
    onProgress: (frac, done, total) => {
      el('upFill').style.width = `${Math.round(frac * 100)}%`;
      el('upPct').textContent = `${Math.round(frac * 100)}% · part ${done} of ${total}`;
    }
  });

  try {
    const result = await uploader.run(file, { title: file.name.replace(/\.[^.]+$/, '') });
    if (result) {
      send({ t: 'source', source: { kind: 'file', id: result.url, title: result.title } });
      el('upPct').textContent = 'ready';
      setTimeout(() => (el('upStatus').hidden = true), 2500);
    }
  } catch (err) {
    el('upError').textContent = `${err.message} Your progress is saved — pick the same file again to carry on.`;
    el('upError').hidden = false;
  } finally {
    uploader = null;
    el('fileInput').value = '';
  }
}

el('fileInput').addEventListener('change', (e) => startUpload(e.target.files?.[0]));

el('upCancel').addEventListener('click', () => {
  uploader?.cancel();
  el('upPct').textContent = 'stopped — pick the same file to carry on';
});

// Dropping a file is how most people expect to do this.
const drop = el('dropZone');
for (const ev of ['dragenter', 'dragover']) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
}
for (const ev of ['dragleave', 'drop']) {
  drop.addEventListener(ev, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  startUpload(e.dataTransfer?.files?.[0]);
});

// A half-finished upload is worth more than a stray click on the page.
window.addEventListener('beforeunload', (e) => {
  if (!uploader) return;
  e.preventDefault();
  e.returnValue = '';
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
