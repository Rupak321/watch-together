import { SyncClock, DriftCorrector, targetPosition } from './sync.js';
import { identifySource, createSource, createStreamSource } from './adapters.js';
import { VoiceMesh } from './voice.js';
import { createBrowser } from './browser.js';

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
  if (browser.isOpen()) return;
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

      // A shared screen is playing by definition — there is no Play to press,
      // so `playing` stays false for it and the room used to sit in the foyer
      // with the controls bar hidden. That bar is where Full screen lives,
      // which is why a viewer watching a presented browser had no way to fill
      // their screen with it.
      const live = m.source?.kind === 'screen';
      el('room').dataset.live = String(live);
      setMode(m.playing || live ? 'house' : 'foyer');
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

    case 'browse':
      // Never bounce a navigation back at the person who sent it — and never
      // pull up an overlay over the very screen it would be covering.
      if (m.by !== myId && !(screenSharerId() && screenSharerId() !== myId)) {
        browser.followRemote(m.url, m.byName);
      }
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
    findSubtitles(s.id);
    startTicking();
  } catch (err) {
    loadedKey = null;
    el('stageEmpty').hidden = false;
    el('metaLabel').textContent = 'could not load';
    setPlayEnabled(false);
    showSrcError(err.message);
  }
}

/**
 * Look for subtitles sitting next to the film — movie.mp4 beside movie.vtt.
 *
 * Nobody wants to paste a second URL, and a Hindi film with English subs is
 * exactly the case worth handling without being asked.
 */
async function findSubtitles(videoUrl) {
  el('ccBtn').hidden = true;
  if (!source?.setSubtitles) return;

  let base;
  try {
    const u = new URL(videoUrl, location.href);
    u.pathname = u.pathname.replace(/\.[^./]+$/, '');
    u.search = '';
    base = u.toString();
  } catch {
    return;
  }

  for (const ext of ['.vtt', '.srt']) {
    if (await source.setSubtitles(base + ext)) {
      el('ccBtn').hidden = false;
      el('ccBtn').dataset.on = 'true';
      el('ccBtn').setAttribute('aria-pressed', 'true');
      el('ccBtn').textContent = 'Subtitles on';
      return;
    }
  }
}

el('ccBtn').addEventListener('click', (e) => {
  const on = e.currentTarget.dataset.on !== 'true';
  source?.showSubtitles?.(on);
  e.currentTarget.dataset.on = String(on);
  e.currentTarget.setAttribute('aria-pressed', String(on));
  e.currentTarget.textContent = on ? 'Subtitles on' : 'Subtitles';
});

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
  const at = source.getCurrentTime();
  const dur = source.getDuration ? source.getDuration() : 0;
  el('posLabel').textContent = fmt(at);
  el('durLabel').textContent = fmt(dur);

  // A live stream has no length to scrub through.
  const seekable = dur > 0 && !source.isLive;
  el('scrub').style.visibility = seekable ? 'visible' : 'hidden';
  if (!seekable) return;

  const pct = Math.max(0, Math.min(100, (at / dur) * 100));
  el('scrubPlayed').style.width = `${pct}%`;
  el('scrubKnob').style.left = `${pct}%`;
  el('scrub').setAttribute('aria-valuenow', String(Math.round(pct)));
  el('scrub').setAttribute('aria-valuetext', `${fmt(at)} of ${fmt(dur)}`);

  const ahead = source.getBufferedAhead();
  el('scrubBuffer').style.width = `${Math.min(100, ((at + ahead) / dur) * 100)}%`;
}

// ---------------------------------------------------------------- seeking

function scrubFraction(e) {
  const r = el('scrub').getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
}

function mayControl() {
  return roomState.pausePolicy !== 'host' || isHost;
}

function seekToFraction(f) {
  const dur = source?.getDuration?.() || 0;
  if (!dur || source.isLive || !mayControl()) return;
  send({ t: 'seek', time: f * dur });
}

el('scrub').addEventListener('pointerdown', (e) => {
  if (!mayControl()) return;
  e.preventDefault();
  seekToFraction(scrubFraction(e));
});

// Show the time under the cursor before committing to it — scrubbing blind
// through a two-hour film is guesswork.
el('scrub').addEventListener('pointermove', (e) => {
  const dur = source?.getDuration?.() || 0;
  if (!dur || source.isLive) return;
  const hint = el('scrubHint');
  hint.hidden = false;
  hint.textContent = fmt(scrubFraction(e) * dur);
  hint.style.left = `${scrubFraction(e) * 100}%`;
});
el('scrub').addEventListener('pointerleave', () => (el('scrubHint').hidden = true));

// Arrow keys nudge, as they do in every player.
el('scrub').addEventListener('keydown', (e) => {
  const dur = source?.getDuration?.() || 0;
  if (!dur || !mayControl()) return;
  const step = e.shiftKey ? 60 : 10;
  if (e.key === 'ArrowRight') send({ t: 'seek', time: source.getCurrentTime() + step });
  else if (e.key === 'ArrowLeft') send({ t: 'seek', time: Math.max(0, source.getCurrentTime() - step) });
  else return;
  e.preventDefault();
});

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
  // The sheet belongs to the house controls; it must not survive the lights
  // coming up, where its bar is hidden and nothing could dismiss it.
  setMoreOpen(false);
  // Same for a window-filling stage: its only exit is in that bar.
  if (mode !== 'house') setPseudoFull(false);
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
  const allowed = mayControl();
  for (const b of document.querySelectorAll('.js-play')) b.disabled = !source || !allowed;
  el('scrub').setAttribute('aria-disabled', String(!allowed));
  el('seekBtn') && (el('seekBtn').disabled = !mayControl);

  renderBrowseTab();
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

// The bar's height is not a constant — one row on a phone, wrapped on a
// narrow desktop window, taller with the enlarged touch knob — and the faces,
// the floating chat and the sync pill all have to clear it. A fixed 68px
// allowance was wrong in both directions: camera tiles landed on Join voice,
// and the sync pill sat under Full screen. Measure it instead and hand the
// number to CSS. The top padding is the transparent fade above the bar, so it
// is left out of what the overlays need to clear.
const controlsSizer = new ResizeObserver(() => {
  const c = el('controls');
  const fade = parseFloat(getComputedStyle(c).paddingTop) || 0;
  el('stageWrap').style.setProperty('--ctrl-h', `${Math.round(c.offsetHeight - fade)}px`);
});
controlsSizer.observe(el('controls'), { box: 'border-box' });

// The same for the faces, which the floating chat stacks on. Their height
// swings from a name tile to a row of cameras, and wraps on a narrow stage.
const railSizer = new ResizeObserver(() => {
  el('stageWrap').style.setProperty('--rail-h', `${el('rail').offsetHeight}px`);
});
railSizer.observe(el('rail'));

function wakeControls() {
  el('stageWrap').classList.add('awake');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => {
    // Not while the More sheet is open: it lives inside the bar, and fading
    // the bar would fade the sheet out from under someone mid-adjustment.
    if (el('room').dataset.mode === 'house' && el('ctrlMore').dataset.open !== 'true') {
      el('stageWrap').classList.remove('awake');
    }
  }, CONTROLS_IDLE_MS);
}

function sleepControls() {
  clearTimeout(controlsTimer);
  if (el('room').dataset.mode === 'house') el('stageWrap').classList.remove('awake');
}

// A mouse wakes the controls by moving. A finger cannot hover, and every
// touch used to count as "wake" — so once the bar was up on a phone, nothing
// short of waiting three seconds would put it away again, with the picture
// half covered the whole time. On touch a tap on the picture toggles the bar,
// as in any phone video player; a tap on a control itself only keeps it up,
// or pressing Pause would also hide the bar Pause is in.
el('stageWrap').addEventListener(
  'pointermove',
  (e) => {
    if (e.pointerType === 'mouse') wakeControls();
  },
  { passive: true }
);

el('stageWrap').addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType === 'mouse') return wakeControls();
    // With the sheet open, a tap outside it is a dismissal, not a request to
    // hide the whole bar — the document listener below closes the sheet.
    if (el('ctrlMore').dataset.open === 'true') return wakeControls();
    const onControl = e.target.closest('button, input, select, a, .scrub, .sync-panel, .vol-panel');
    if (onControl || !el('stageWrap').classList.contains('awake')) return wakeControls();
    sleepControls();
  },
  { passive: true }
);

document.querySelectorAll('.js-play').forEach((b) =>
  b.addEventListener('click', () => send({ t: roomState.playing ? 'pause' : 'play' }))
);
el('lightsBtn').addEventListener('click', () => {
  setMode(el('room').dataset.mode === 'house' ? 'foyer' : 'house');
});

// ------------------------------------------------------------ full screen

/**
 * Real fullscreen where the platform offers it for an element. An iPhone does
 * not: only a bare <video> may go fullscreen there, and it goes alone, leaving
 * the controls, the chat and everyone's faces behind — so requestFullscreen
 * was undefined, the optional call quietly did nothing, and the button looked
 * broken. There the stage fills the window instead.
 */
const nativeFullElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;

function renderFullBtn() {
  const full = !!nativeFullElement() || el('room').dataset.full === 'true';
  el('fullBtn').textContent = full ? 'Exit full screen' : 'Full screen';
}

function setPseudoFull(on) {
  el('room').dataset.full = String(!!on);
  // Stops the page scrolling underneath a stage that covers it.
  document.documentElement.classList.toggle('stage-full', !!on);
  renderFullBtn();
}

el('fullBtn').addEventListener('click', async () => {
  const wrap = el('stageWrap');
  if (nativeFullElement()) {
    (document.exitFullscreen || document.webkitExitFullscreen)?.call(document);
    return;
  }
  if (el('room').dataset.full === 'true') return setPseudoFull(false);

  const request = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
  const enabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled;
  if (request && enabled !== false) {
    try {
      await request.call(wrap);
      // Turn a phone held upright the film's way. Only allowed inside real
      // fullscreen, and only on Android; everywhere else it simply rejects.
      screen.orientation?.lock?.('landscape')?.catch(() => {});
      return;
    } catch {}
  }
  setPseudoFull(true);
});

document.addEventListener('fullscreenchange', renderFullBtn);
document.addEventListener('webkitfullscreenchange', renderFullBtn);

// ------------------------------------------------------------- more sheet

function setMoreOpen(open) {
  const sheet = el('ctrlMore');
  if (!sheet) return;
  sheet.dataset.open = String(!!open);
  el('moreBtn').setAttribute('aria-expanded', String(!!open));
  if (open) wakeControls();
}

el('moreBtn').addEventListener('click', () => {
  setMoreOpen(el('ctrlMore').dataset.open !== 'true');
});

// Dismiss on a tap anywhere outside the sheet. Judged by position rather than
// by target, because the dimmed backdrop is the sheet's own ::before — a tap
// on it reports the sheet as its target, and must still count as outside.
document.addEventListener('pointerdown', (e) => {
  const sheet = el('ctrlMore');
  if (sheet.dataset.open !== 'true' || e.target.closest('#moreBtn')) return;
  const r = sheet.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  if (!inside) setMoreOpen(false);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  setMoreOpen(false);
  if (el('room').dataset.full === 'true') setPseudoFull(false);
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
  // Not while the browser is over the room — there, space is the page's.
  if (browser.isOpen()) return;
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

const TABS = { link: 'paneLink', archive: 'paneArchive', browse: 'paneBrowse', screen: 'paneScreen' };

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

/**
 * Phones cannot share their screen at all. getDisplayMedia exists only in
 * desktop browsers — every browser on iOS is WebKit and exposes none, and
 * Chrome on Android leaves it out too. The button used to sit there looking
 * available and fail with a generic error after the tap.
 */
const canShareScreen = () => !!navigator.mediaDevices?.getDisplayMedia;

function renderScreenButton() {
  const on = !!voice?.screenStream;
  const can = canShareScreen();
  for (const b of document.querySelectorAll('.js-screen')) {
    b.dataset.on = String(on);
    b.disabled = !can;
    b.textContent = !can ? 'Not available on this device' : on ? 'Stop sharing' : 'Share my screen';
  }
}

if (!canShareScreen()) {
  const hint = el('paneScreen').querySelector('.src-hint');
  if (hint) {
    hint.textContent =
      'Phones and tablets cannot share their screen — no browser on them allows it. ' +
      'You can still watch a screen someone shares from a computer.';
  }
}

/**
 * The browser is one person's, but what it finds is everyone's — a pick from
 * it travels the same path as one typed into the Link box, so the room sees
 * no difference and sync is unchanged.
 */
const browser = createBrowser({
  onPlay(source) {
    el('srcNotice').hidden = true;
    send({ t: 'source', source });
  },
  onNavigate(url) {
    send({ t: 'browse', url });
  },
  /**
   * Closing the browser ends the showing, rather than leaving the room
   * staring at a shared tab nobody is driving any more.
   */
  onClose() {
    if (voice?.screenStream && screenSharerId() === myId) {
      voice.stopScreenShare();
      send({ t: 'source', source: null });
      renderScreenButton();
    }
  }
});

/**
 * Who, if anyone, is putting a screen into the room right now.
 *
 * This is the whole basis of browser mode: while it is someone else, this
 * client is a viewer and has no business driving anything.
 */
function screenSharerId() {
  return roomState.source?.kind === 'screen' ? roomState.source.id : null;
}

/**
 * The host opens the browser, and the room watches it.
 *
 * Sharing the picture rather than the address is what makes this work at all.
 * Everyone lands on the same *frame* — not the same URL to load separately —
 * so there is nothing to drift and nothing to synchronise. The room's clock
 * stays out of it, exactly as it does for any live source.
 *
 * The capture has to be asked for inside this click. Browsers only grant a
 * display capture on a real user gesture, and an await before the ask spends
 * it — so the overlay is opened first (synchronous, keeps the gesture alive)
 * and the picker comes up over it, which also makes the tab being chosen the
 * one already on screen.
 */
el('openBrowserBtn').addEventListener('click', async () => {
  const sharer = screenSharerId();
  if (sharer && sharer !== myId) {
    showSrcError(`${roomState.source.title || 'The host'} is showing their browser — it is on the stage.`);
    return;
  }

  browser.open(roomState.browseUrl || undefined);
  if (!isHost || voice?.screenStream) return;

  try {
    // Crop the capture to the browser's own pane, so what goes out is the
    // page and nothing else — not the address bar, not the roster, not the
    // chat. Where the browser cannot do that, the whole tab still goes.
    const stream = await voice.startScreenShare({ cropTo: el('brBody') });
    send({
      t: 'source',
      source: { kind: 'screen', id: myId, streamId: stream.id, title: `${myName}'s browser` }
    });

    browser.setPresenting(voice.screenCropped);
  } catch (err) {
    // Dismissing the picker is a decision, not a fault. The browser stays
    // open and private; the button in the chrome starts the share later.
    if (err.name !== 'NotAllowedError') {
      showSrcError('Screen sharing is not available in this browser.');
    }
  }
  renderScreenButton();
});

/**
 * In browser mode the address bar, the navigation and the share toggle belong
 * to whoever is presenting. Everyone else is watching a video of it, where a
 * back button would be a lie.
 */
function renderBrowseTab() {
  const sharer = screenSharerId();
  const watching = !!sharer && sharer !== myId;

  el('openBrowserBtn').disabled = watching;
  el('openBrowserBtn').textContent = isHost ? 'Open the browser and show it' : 'Open the browser';
  el('browseWatching').hidden = !watching;
  browser.setDriving(!watching);
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
