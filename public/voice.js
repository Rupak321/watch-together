/**
 * Peer-to-peer voice (and optional camera) for small rooms.
 *
 * Full mesh, deliberately: with four people that is three connections each,
 * which costs nothing to run and adds no server hop to the audio path. Above
 * four it stops scaling — each extra person costs everyone another upstream —
 * and that is where an SFU has to take over.
 *
 * Signalling rides the room's existing WebSocket, so there is no second
 * service and no second thing to keep alive.
 */

const SPEAK_ON = 0.045;      // RMS to count as speech
const SPEAK_OFF = 0.022;     // lower bar to stop, so words don't flicker
const SPEAK_HANG_MS = 380;   // keep the light on through short gaps

const DUCK_TO = 0.25;        // how far the film drops while someone talks
const DUCK_DOWN_MS = 120;    // fast, so you don't miss the start of a sentence
const DUCK_UP_MS = 600;      // slow, so it doesn't pump between words

// A shared screen is the thing everyone is actually watching, so it gets real
// bitrate — unlike cameras, which are thumbnails.
//
// This is a ceiling, not a target. WebRTC's congestion control probes upward
// and backs off on its own, so a high cap costs nothing on a link that cannot
// carry it and buys everything on one that can. What it cannot escape is the
// mesh: the presenter sends a separate copy to every viewer, so their upload
// is divided by the number of people watching. Four viewers on a 20 Mbit
// upload is 5 Mbit each, and no setting here changes that arithmetic.
const SCREEN_BITRATE = 16_000_000;

/**
 * Ask the capture for the display's real pixels rather than a fixed 1080p.
 *
 * A constraint of 1920 on a high-DPI panel is a *downscale* — the tab is
 * already being painted at more than that, and asking for less throws the
 * detail away before the encoder ever sees it. Cropping makes this sharper
 * still: the crop keeps a rectangle of the captured frame, so the frame it
 * is cut from wants to be as large as the display can give.
 *
 * Capped at 4K because past there the bitrate is real and the visible gain
 * is not.
 */
function captureSize() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round((window.screen?.width || 1920) * dpr);
  const h = Math.round((window.screen?.height || 1080) * dpr);
  const scale = Math.min(1, 3840 / w, 2160 / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/**
 * Put the efficient codecs first.
 *
 * VP9 carries noticeably more picture per bit than VP8 or H.264, which is the
 * single largest quality lever left once the bitrate ceiling is high enough
 * to be irrelevant. AV1 is better still on paper and much heavier to encode
 * in real time, so it sits behind VP9 rather than in front of it.
 *
 * This only reorders a preference. Negotiation still has to find a codec both
 * ends support, so a peer without VP9 quietly gets what it can decode — and
 * every entry is kept, including the retransmission and FEC ones, because a
 * list that drops them breaks more than it tunes.
 */
function preferEfficientCodec(pc, sender) {
  try {
    const tr = pc.getTransceivers?.().find((t) => t.sender === sender);
    const caps = window.RTCRtpSender?.getCapabilities?.('video');
    if (!tr?.setCodecPreferences || !caps?.codecs) return;

    const rank = (c) => {
      const m = c.mimeType.toLowerCase();
      if (m.endsWith('/vp9')) return 0;
      if (m.endsWith('/av1') || m.endsWith('/av01')) return 1;
      return 2;
    };
    tr.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
  } catch {}
}

// Film soundtracks through an Opus track that defaults to speech bitrate is
// where a shared film actually sounds bad — the picture is usually fine and
// the audio is thin. This is the one place worth spending on audio.
const SCREEN_AUDIO_BITRATE = 256_000;

// Camera during playback is capped hard. WebRTC's congestion control adapts in
// milliseconds while an HTTP video fetch is passive, so an uncapped camera
// wins the bandwidth fight and starves the film — which then presents as a
// sync bug rather than a camera problem.
const CAM_PLAYING = { width: 320, height: 180, frameRate: 15, bitrate: 150_000 };
const CAM_IDLE = { width: 640, height: 360, frameRate: 24, bitrate: 500_000 };

/**
 * Can this browser send a rectangle of the page rather than the whole tab?
 *
 * Two Chromium APIs do it, and they are not the same thing:
 *
 *   Element Capture (RestrictionTarget) sends *that element*. Anything drawn
 *   over it — a dialog, a notification, the browser's own sharing bar — is
 *   absent from the capture rather than covering it.
 *
 *   Region Capture (CropTarget) sends that element's *rectangle*. Whatever
 *   happens to be on top within those bounds is still in the picture.
 *
 * Element Capture is the better answer and the newer one, so it is tried
 * first. Neither exists in Firefox or Safari, where this degrades to sharing
 * the tab — which works, it just shows more than was asked for.
 */
function canNarrowCapture() {
  return typeof window !== 'undefined' && ('RestrictionTarget' in window || 'CropTarget' in window);
}

/**
 * Narrow a self-capture down to one element. Returns whether it took.
 *
 * Every step here is allowed to fail without taking the share with it: a
 * refused crop leaves a perfectly good full-tab capture, and losing the
 * whole picture to keep it tidy would be a bad trade.
 */
async function narrowToElement(track, element) {
  if (!track || !element) return false;

  if ('RestrictionTarget' in window && track.restrictTo) {
    try {
      await track.restrictTo(await window.RestrictionTarget.fromElement(element));
      return true;
    } catch {
      // Element Capture is fussy about what it will target. Region Capture
      // takes elements it refuses, so this is worth continuing from.
    }
  }

  if ('CropTarget' in window && track.cropTo) {
    try {
      await track.cropTo(await window.CropTarget.fromElement(element));
      return true;
    } catch {}
  }

  return false;
}

export class VoiceMesh {
  /**
   * @param {(msg: object) => void} send      room socket sender
   * @param {object} hooks  onSpeaking, onPeerStream, onPeerGone, onDuck, onError
   */
  constructor(send, hooks = {}) {
    this.send = send;
    this.hooks = hooks;

    this.myId = null;
    this.peers = new Map();      // id -> { pc, polite, makingOffer, ignoreOffer, meter }
    this.known = new Map();      // id -> name, from the roster

    this.localStream = null;
    this.screenStream = null;
    this.screenCropped = false;  // true when only the browser pane is going out
    this.screenStreamId = null;   // the id we expect a shared screen to arrive under
    this.onMesh = false;
    this.audioCtx = null;
    this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

    this.micOn = false;
    this.camOn = false;
    this.pttMode = false;
    this.pttHeld = false;

    this.duckLevel = 1;
    this.duckTarget = 1;
    this.speaking = new Set();
    this.rafId = null;
    this.lastFrame = 0;
  }

  setMyId(id) {
    this.myId = id;
  }

  /**
   * How loud everyone else is, independent of the film's own volume.
   *
   * Applied to the <audio> elements rather than to a gain node, so it keeps
   * working for peers whose stream never went through Web Audio.
   */
  setPeerVolume(v) {
    this.peerVolume = Math.max(0, Math.min(1, v));
    for (const id of this.peers.keys()) {
      const audio = document.getElementById(`peer-audio-${id}`);
      if (audio) audio.volume = this.peerVolume;
    }
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Bring up the mesh itself, independent of what will be sent over it.
   *
   * Screen sharing has to be able to start this without a microphone —
   * "turn your mic on before you can share your screen" is not a real
   * requirement, just an artefact of bundling the two together.
   */
  async joinMesh() {
    if (this.onMesh) return;
    this.onMesh = true;
    await this.loadIceServers();
    this.ensureAudioContext();
    this.startLoop();
    this.announce();
    this.dialKnownPeers();
  }

  /**
   * Two separate facts, deliberately.
   *
   * `mesh` is whether a peer connection should exist at all; `mic` is whether
   * they are actually sending audio. Someone watching a shared screen needs
   * the first and not the second, and conflating them meant a viewer with no
   * microphone silently dropped every incoming offer.
   */
  announce() {
    this.send({
      t: 'presence',
      mesh: this.onMesh,
      mic: this.micOn,
      // Live means the gate is actually open — not muted, and either
      // push-to-talk is off or the key is down. Without this nobody can tell
      // a muted person from a quiet one.
      live: this.micOn && !this.muted && (!this.pttMode || this.pttHeld)
    });
  }

  /** True while this client has anything to contribute to the mesh. */
  get sharing() {
    return this.micOn || !!this.screenStream;
  }

  async enableMic() {
    if (this.micOn) return;

    // Before anything is awaited. The level meter below needs the audio
    // context, which was only created later, in joinMesh — so the meter hit a
    // null context and threw. Whoever joined voice first in a room was shown
    // "On voice", told no microphone was found, and never connected. Creating
    // it here, inside the tap, is also what a phone requires to start one.
    this.ensureAudioContext();

    // Ask for the browser's own echo cancellation. It only cancels audio
    // WebRTC itself rendered, never the film coming out of the speakers —
    // which is why the room still recommends headphones.
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });

    // Add to the existing stream rather than replacing it. Overwriting
    // orphaned a camera track that was already running and split this
    // client's media across two MediaStreams, which receivers then had to
    // reconcile — and mostly got wrong.
    if (!this.localStream) this.localStream = new MediaStream();
    const added = mic.getAudioTracks();
    for (const t of added) this.localStream.addTrack(t);

    this.micOn = true;
    try {
      this.applyMicGate();
      this.meterLocal();
      await this.joinMesh();
    } catch (err) {
      // Never leave the button saying On voice for a microphone that is not
      // reaching anyone.
      for (const t of added) {
        this.localStream.removeTrack(t);
        t.stop();
      }
      this.micOn = false;
      throw err;
    }
    this.announce();

    for (const track of added) {
      for (const { pc } of this.peers.values()) pc.addTrack(track, this.localStream);
    }
  }

  // ---------------------------------------------------------- screen share

  /**
   * Capture a screen or tab and push it to every peer.
   *
   * `audio: true` matters more than it looks: on Chromium, sharing a tab can
   * carry that tab's audio, which is the difference between sharing a film
   * and sharing a silent film.
   *
   * Pass `cropTo` — an element — to send only that rectangle instead of the
   * whole tab. See narrowToElement for what that costs and where it works.
   */
  async startScreenShare({ cropTo = null } = {}) {
    if (this.screenStream) return this.screenStream;

    const wantCrop = !!cropTo && canNarrowCapture();
    const size = captureSize();

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        // Ideal, never exact: an exact constraint the display cannot meet
        // fails the whole call rather than degrading, and the one surface
        // nobody can change is someone else's monitor.
        // 30, not 60: the content is 24fps film, so the second half of a
        // 60fps budget buys duplicate frames instead of picture. Spending it
        // on resolution instead is the whole trade.
        frameRate: { ideal: 30 },
        width: { ideal: size.width },
        height: { ideal: size.height },
        // Opens the picker on the tab list, which is the right answer here
        // and also the only surface that can carry audio. Cropping needs the
        // capture to be *this* tab specifically, so preferCurrentTab below
        // takes over the job of choosing and this hint would only fight it.
        ...(wantCrop ? {} : { displaySurface: 'browser' })
      },
      // Tab audio, and without the processing meant for a talking head —
      // echo cancellation and noise suppression wreck a film's soundtrack.
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      },
      // Cropping only works on a self-capture, so the picker has to be
      // pointed at the tab we are already in.
      ...(wantCrop ? { preferCurrentTab: true } : {})
    });
    this.screenStream = stream;
    this.screenCropped = false;

    if (wantCrop) {
      this.screenCropped = await narrowToElement(stream.getVideoTracks()[0], cropTo);
    }

    // Tell the encoder this is moving pictures, not a slide of text. Without
    // it the default assumption is a shared document, and it holds detail at
    // the cost of frame rate — which is exactly backwards for a film.
    const vid = stream.getVideoTracks()[0];
    if (vid) vid.contentHint = 'motion';

    await this.joinMesh();

    for (const { pc } of this.peers.values()) {
      for (const track of stream.getTracks()) {
        const sender = pc.addTrack(track, stream);
        if (track.kind === 'video') {
          // Detail before motion. The source is 24fps film, so frames given up
          // under strain cost far less than the sharpness they buy back.
          this.capSender(sender, SCREEN_BITRATE, 'maintain-resolution');
          preferEfficientCodec(pc, sender);
        } else {
          this.capSender(sender, SCREEN_AUDIO_BITRATE);
        }
      }
    }

    // The browser draws its own "Stop sharing" bar, and people use it — so
    // that has to end the share properly rather than leave a dead source.
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      this.stopScreenShare();
      this.hooks.onScreenEnded?.();
    });

    return stream;
  }

  stopScreenShare() {
    const stream = this.screenStream;
    if (!stream) return;
    this.screenStream = null;
    this.screenCropped = false;

    for (const { pc } of this.peers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track && stream.getTracks().includes(sender.track)) {
          try {
            pc.removeTrack(sender);
          } catch {}
        }
      }
    }
    stream.getTracks().forEach((t) => t.stop());
  }

  /**
   * Which incoming stream is the shared screen.
   *
   * A MediaStream's id travels in the SDP, so the presenter can announce it
   * through the room and every receiver can tell a screen apart from a
   * webcam without guessing from track order or resolution.
   */
  setExpectedScreenStream(streamId) {
    this.screenStreamId = streamId || null;
    if (!streamId) return;
    // A stream that already arrived may only now be identifiable.
    for (const [id, entry] of this.peers) {
      const found = entry.streams?.find((s) => s.id === streamId);
      if (found) this.hooks.onScreenStream?.(id, found);
    }
  }

  disableMic() {
    if (!this.micOn) return;
    this.micOn = false;

    // Audio tracks only. Tearing down the peer connections would kill a
    // screen share running over them, and pulling every track would switch
    // off a camera the person never asked to turn off.
    for (const track of this.localStream?.getAudioTracks() || []) {
      for (const { pc } of this.peers.values()) {
        const sender = pc.getSenders().find((s) => s.track === track);
        if (sender) {
          try {
            pc.removeTrack(sender);
          } catch {}
        }
      }
      track.stop();
      this.localStream.removeTrack(track);
    }
    if (!this.localStream?.getTracks().length) this.localStream = null;
    this.localMeter?.disconnect();
    this.localMeter = null;

    this.speaking.delete(this.myId);
    this.hooks.onSpeaking?.(this.myId, false);

    // Stay on the mesh if anything else is still using it — a screen share, a
    // camera, or simply receiving one. Just stop claiming a live mic.
    if (this.screenStream || this.camOn || this.receiveOnly) this.announce();
    else this.leaveMesh();
  }

  /** Join purely to receive — no microphone, no camera, nothing sent. */
  async watchOnly() {
    this.receiveOnly = true;
    await this.joinMesh();
  }

  leaveMesh() {
    if (!this.onMesh) return;
    this.onMesh = false;
    this.receiveOnly = false;
    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.speaking.clear();
    this.duckTarget = 1;
    this.duckLevel = 1;
    this.hooks.onDuck?.(1);
    this.send({ t: 'presence', mesh: false, mic: false });
  }

  async loadIceServers() {
    try {
      const res = await fetch('/api/ice');
      const { iceServers } = await res.json();
      if (Array.isArray(iceServers) && iceServers.length) this.iceServers = iceServers;
    } catch {
      // Public STUN alone still connects most people; only symmetric NAT
      // strictly needs a relay.
    }
  }

  ensureAudioContext() {
    if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {});
  }

  // -------------------------------------------------------------- mic gate

  setMuted(muted) {
    this.muted = muted;
    this.applyMicGate();
  }

  setPushToTalk(on) {
    this.pttMode = on;
    this.applyMicGate();
  }

  setPttHeld(held) {
    this.pttHeld = held;
    this.applyMicGate();
  }

  applyMicGate() {
    const live = this.micOn && !this.muted && (!this.pttMode || this.pttHeld);
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = live));
    if (!live) {
      this.speaking.delete(this.myId);
      this.hooks.onSpeaking?.(this.myId, false);
    }
    // Push-to-talk flips this several times a sentence, so only tell the room
    // when the answer actually changed.
    if (this.onMesh && live !== this.lastLive) {
      this.lastLive = live;
      this.announce();
    }
  }

  // ---------------------------------------------------------------- camera

  /**
   * Camera is independent of the microphone — plenty of people want to be
   * seen without being heard. Gated on the mesh, never on `micOn`.
   */
  async setCamera(on, playing) {
    if (this.camOn === on) return;
    if (on) await this.joinMesh();
    else if (!this.onMesh) return;

    if (!on) {
      const track = this.localStream?.getVideoTracks()[0];
      if (track) {
        for (const { pc } of this.peers.values()) {
          const sender = pc.getSenders().find((s) => s.track === track);
          if (sender) pc.removeTrack(sender);
        }
        track.stop();
        this.localStream?.removeTrack(track);
      }
      this.camOn = false;
      this.hooks.onPeerStream?.(this.myId, null); // clear the local preview
      // Nothing left to contribute: stop claiming a place on the mesh unless
      // something else is still using it.
      if (!this.micOn && !this.screenStream && !this.receiveOnly) this.leaveMesh();
      return;
    }

    const profile = playing ? CAM_PLAYING : CAM_IDLE;
    const cam = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: profile.width },
        height: { ideal: profile.height },
        frameRate: { ideal: profile.frameRate }
      }
    });
    const track = cam.getVideoTracks()[0];

    // A camera-only client has no microphone stream to hang this on.
    if (!this.localStream) this.localStream = new MediaStream();
    this.localStream.addTrack(track);

    for (const { pc } of this.peers.values()) {
      const sender = pc.addTrack(track, this.localStream);
      this.capSender(sender, profile.bitrate, 'maintain-framerate');
    }
    this.camOn = true;
    this.hooks.onPeerStream?.(this.myId, this.localStream);
  }

  /** Re-cap every camera when playback starts or stops. */
  async reprofileCamera(playing) {
    if (!this.camOn) return;
    const profile = playing ? CAM_PLAYING : CAM_IDLE;
    const track = this.localStream?.getVideoTracks()[0];
    try {
      await track?.applyConstraints({
        width: { ideal: profile.width },
        height: { ideal: profile.height },
        frameRate: { ideal: profile.frameRate }
      });
    } catch {}
    for (const { pc } of this.peers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === 'video') this.capSender(sender, profile.bitrate, 'maintain-framerate');
      }
    }
  }

  /**
   * @param degrade  what to give up first when the link cannot keep up:
   *                 'maintain-resolution' holds detail and lets frames go,
   *                 'maintain-framerate' holds motion and lets detail go.
   */
  async capSender(sender, bitrate, degrade) {
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = bitrate;
      if (degrade) {
        params.degradationPreference = degrade;
        // Never send a downscaled copy of something this size on purpose.
        delete params.encodings[0].scaleResolutionDownBy;
      }
      await sender.setParameters(params);
    } catch {}
  }

  /**
   * The buffer-aware throttle. When the film is running out of runway, video
   * is the first thing to go and voice is the last — a stalled picture ruins
   * the evening, a frozen thumbnail does not.
   */
  applyBufferPressure(bufferedAhead, playing) {
    if (!this.onMesh) return;

    // Not playing: there is no film to protect, so cameras come straight back.
    // They used to stay off after a stall until the film played on and
    // refilled, so a pause to talk it over left everyone's camera blank.
    if (!playing) {
      this.setIncomingVideo(true);
      this.hooks.onThrottle?.(false);
      return;
    }

    // Under three seconds of runway, stop receiving video altogether. Voice
    // survives — a frozen thumbnail is a far smaller loss than a stalled film.
    // Back on only past eight: a single threshold made a buffer hovering near
    // it switch cameras off and on every two seconds, renegotiating every
    // connection each time.
    const on = this.incomingVideo !== false ? bufferedAhead >= 3 : bufferedAhead >= 8;
    this.setIncomingVideo(on);
    this.hooks.onThrottle?.(!on);
  }

  /**
   * Stop or resume *incoming* video across every peer.
   *
   * This used to walk pc.getSenders() and cap the outgoing camera, which
   * could never have worked: a draining film buffer is a shortage on this
   * client's DOWNLINK, and throttling its upload frees nothing. Flipping the
   * transceiver direction is what actually stops the bytes arriving.
   *
   * Only ever called for a buffered source — a shared screen reports an
   * effectively infinite buffer, so a live stream never gets switched off
   * underneath the person watching it.
   */
  setIncomingVideo(enabled) {
    if (this.incomingVideo === enabled) return;
    this.incomingVideo = enabled;

    for (const { pc } of this.peers.values()) {
      for (const tr of pc.getTransceivers()) {
        if (tr.receiver?.track?.kind !== 'video') continue;
        const now = tr.direction;
        // Preserve whatever this client is sending; only drop the receive half.
        const next = enabled
          ? now === 'sendonly' ? 'sendrecv' : now === 'inactive' ? 'recvonly' : now
          : now === 'sendrecv' ? 'sendonly' : now === 'recvonly' ? 'inactive' : now;
        if (next === now) continue;
        try {
          tr.direction = next; // fires negotiationneeded; perfect negotiation handles it
        } catch {}
      }
    }
  }

  // ----------------------------------------------------------------- peers

  onRoster(peers) {
    this.known.clear();
    for (const p of peers) if (p.id && p.id !== this.myId) this.known.set(p.id, p);

    for (const id of [...this.peers.keys()]) {
      if (!this.known.has(id)) this.dropPeer(id);
    }

    // If anyone else is on the mesh, join it so their camera, voice or screen
    // can actually reach this client. Waiting for them to turn something on
    // first meant a camera lit up on the sender's laptop and arrived nowhere.
    if (!this.onMesh && [...this.known.values()].some((p) => p.mesh)) {
      this.watchOnly().catch(() => {});
      return;
    }
    if (this.onMesh) this.dialKnownPeers();
  }

  dialKnownPeers() {
    for (const [id, p] of this.known) {
      if (p.mesh && !this.peers.has(id)) this.openPeer(id);
    }
  }

  openPeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    // Perfect negotiation: exactly one side must yield when both offer at
    // once. Comparing ids gives both ends the same answer without a round trip.
    const entry = {
      pc,
      polite: this.myId < id,
      makingOffer: false,
      ignoreOffer: false,
      meter: null,
      streams: []
    };
    this.peers.set(id, entry);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
    }
    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) {
        const sender = pc.addTrack(track, this.screenStream);
        if (track.kind === 'video') {
          // Detail before motion. The source is 24fps film, so frames given up
          // under strain cost far less than the sharpness they buy back.
          this.capSender(sender, SCREEN_BITRATE, 'maintain-resolution');
          preferEfficientCodec(pc, sender);
        } else {
          this.capSender(sender, SCREEN_AUDIO_BITRATE);
        }
      }
    }

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        this.send({ t: 'signal', to: id, data: { description: pc.localDescription } });
      } catch (err) {
        this.hooks.onError?.(err);
      } finally {
        entry.makingOffer = false;
      }
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.send({ t: 'signal', to: id, data: { candidate } });
    };

    pc.ontrack = ({ streams }) => {
      const stream = streams[0];
      if (!stream) return;

      if (!entry.streams.some((s) => s.id === stream.id)) entry.streams.push(stream);

      // A shared screen goes to the stage, not to a face tile in the rail.
      if (this.screenStreamId && stream.id === this.screenStreamId) {
        this.hooks.onScreenStream?.(id, stream);
        return;
      }
      this.attachRemote(id, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // Almost always a symmetric NAT with no relay available.
        this.hooks.onError?.(
          new Error('Could not reach one person directly. A TURN relay is needed for that network.')
        );
      }
    };

    return entry;
  }

  async onSignal(from, data) {
    // Gated on being on the mesh, never on having a microphone. This check
    // used to read `!this.micOn`, which meant anyone who had not clicked
    // "Join voice" silently discarded every incoming offer — so a shared
    // screen reached nobody but the person sharing it.
    if (!this.onMesh) return;
    const entry = this.peers.get(from) || this.openPeer(from);
    const { pc } = entry;

    try {
      if (data.description) {
        const offerCollision =
          data.description.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');

        entry.ignoreOffer = !entry.polite && offerCollision;
        if (entry.ignoreOffer) return;

        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          this.send({ t: 'signal', to: from, data: { description: pc.localDescription } });
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!entry.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.hooks.onError?.(err);
    }
  }

  attachRemote(id, stream) {
    const entry = this.peers.get(id);
    if (!entry) return;
    if (!entry.streams.some((s) => s.id === stream.id)) entry.streams.push(stream);

    // A camera switched on after the connection exists arrives as a new track
    // on a stream we already hold, which fires no fresh ontrack.
    if (!stream.__wired) {
      stream.__wired = true;
      const again = () => this.refreshPeerMedia(id);
      stream.addEventListener('addtrack', again);
      stream.addEventListener('removetrack', again);
    }

    this.refreshPeerMedia(id);
  }

  /**
   * Bind a peer's audio and video from whichever of their streams carries it.
   *
   * A peer can send audio and video under two different MediaStreams. This
   * used to assume one stream per peer and point the <audio> element at
   * whichever arrived last — so an audio-only stream landing second replaced
   * the video and the camera vanished at the far end.
   */
  refreshPeerMedia(id) {
    const entry = this.peers.get(id);
    if (!entry) return;

    const live = (t) => t.readyState === 'live';

    /**
     * The shared screen is not this peer's microphone or camera, and must be
     * left out of both.
     *
     * ontrack sends it to the stage and returns early, but it was still being
     * pushed onto entry.streams first — so the search below found the screen's
     * *tab audio* and pointed the hidden per-peer <audio> element at it. The
     * stage <video> was already playing that same track, so the film's
     * soundtrack was decoded twice, a few tens of milliseconds apart. That is
     * the echo: not the room, not the microphone, one film playing against
     * itself. The video half was worse in its own way — a peer's face tile
     * would fill with the film.
     */
    const own = entry.streams.filter((s) => s.id !== this.screenStreamId);
    const audioStream = own.find((s) => s.getAudioTracks().some(live));
    const videoStream = own.find((s) => s.getVideoTracks().some(live));

    if (audioStream) {
      // A WebRTC stream needs a media element attached before audio flows,
      // even when Web Audio is also reading it.
      let audio = document.getElementById(`peer-audio-${id}`);
      if (!audio) {
        audio = document.createElement('audio');
        audio.id = `peer-audio-${id}`;
        audio.autoplay = true;
        audio.hidden = true;
        document.body.appendChild(audio);
      }
      if (audio.srcObject !== audioStream) audio.srcObject = audioStream;
      audio.volume = this.peerVolume ?? 1;
      audio.play().catch(() => {});

      if (!entry.meter) {
        this.ensureAudioContext();
        entry.meter = this.makeMeter(audioStream);
      }
    }

    this.hooks.onPeerStream?.(id, videoStream || null);
  }

  dropPeer(id) {
    const entry = this.peers.get(id);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch {}
    entry.meter?.disconnect();
    this.peers.delete(id);
    this.speaking.delete(id);
    document.getElementById(`peer-audio-${id}`)?.remove();
    this.hooks.onPeerGone?.(id);
  }

  // ------------------------------------------------------- level metering

  makeMeter(stream) {
    const src = this.audioCtx.createMediaStreamSource(stream);
    const analyser = this.audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.35;
    src.connect(analyser);
    // Deliberately not connected to the destination — the <audio> element
    // does the playing; this branch only measures.
    return {
      analyser,
      buf: new Uint8Array(analyser.fftSize),
      lastLoud: 0,
      on: false,
      disconnect: () => {
        try {
          src.disconnect();
        } catch {}
      }
    };
  }

  meterLocal() {
    if (!this.localStream?.getAudioTracks().length) return;
    this.localMeter = this.makeMeter(this.localStream);
  }

  static rms(meter) {
    meter.analyser.getByteTimeDomainData(meter.buf);
    let sum = 0;
    for (let i = 0; i < meter.buf.length; i++) {
      const v = (meter.buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / meter.buf.length);
  }

  /** Hysteresis plus a hangover, so the light tracks speech not syllables. */
  judge(meter, now) {
    const level = VoiceMesh.rms(meter);
    if (level > SPEAK_ON) {
      meter.lastLoud = now;
      meter.on = true;
    } else if (meter.on && level < SPEAK_OFF && now - meter.lastLoud > SPEAK_HANG_MS) {
      meter.on = false;
    }
    return meter.on;
  }

  startLoop() {
    if (this.rafId !== null) return;
    this.lastFrame = performance.now();

    const frame = (now) => {
      const dt = Math.min(100, now - this.lastFrame);
      this.lastFrame = now;

      if (this.localMeter && this.localStream?.getAudioTracks()[0]?.enabled) {
        this.flag(this.myId, this.judge(this.localMeter, now));
      }

      let remoteTalking = false;
      for (const [id, entry] of this.peers) {
        if (!entry.meter) continue;
        const on = this.judge(entry.meter, now);
        this.flag(id, on);
        if (on) remoteTalking = true;
      }

      // Only remote voices duck the film. Ducking for your own voice would
      // drop the audio every time you laughed.
      this.duckTarget = remoteTalking ? DUCK_TO : 1;
      const tau = this.duckTarget < this.duckLevel ? DUCK_DOWN_MS : DUCK_UP_MS;
      this.duckLevel += (this.duckTarget - this.duckLevel) * Math.min(1, dt / tau);
      if (Math.abs(this.duckLevel - this.duckTarget) < 0.005) this.duckLevel = this.duckTarget;
      this.hooks.onDuck?.(this.duckLevel);

      this.rafId = requestAnimationFrame(frame);
    };

    this.rafId = requestAnimationFrame(frame);
  }

  flag(id, on) {
    const had = this.speaking.has(id);
    if (on === had) return;
    if (on) this.speaking.add(id);
    else this.speaking.delete(id);
    this.hooks.onSpeaking?.(id, on);
  }
}
