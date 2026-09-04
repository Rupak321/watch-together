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

// Camera during playback is capped hard. WebRTC's congestion control adapts in
// milliseconds while an HTTP video fetch is passive, so an uncapped camera
// wins the bandwidth fight and starves the film — which then presents as a
// sync bug rather than a camera problem.
const CAM_PLAYING = { width: 320, height: 180, frameRate: 15, bitrate: 150_000 };
const CAM_IDLE = { width: 640, height: 360, frameRate: 24, bitrate: 500_000 };

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

  // ------------------------------------------------------------- lifecycle

  async enableMic() {
    if (this.micOn) return;

    // Ask for the browser's own echo cancellation. It only cancels audio
    // WebRTC itself rendered, never the film coming out of the speakers —
    // which is why the room still recommends headphones.
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });

    this.micOn = true;
    this.applyMicGate();

    await this.loadIceServers();
    this.ensureAudioContext();
    this.meterLocal();
    this.startLoop();

    for (const track of this.localStream.getTracks()) {
      for (const { pc } of this.peers.values()) pc.addTrack(track, this.localStream);
    }

    this.send({ t: 'voice', on: true });
    this.dialKnownPeers();
  }

  disableMic() {
    if (!this.micOn) return;
    this.micOn = false;
    this.camOn = false;

    for (const id of [...this.peers.keys()]) this.dropPeer(id);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;

    this.speaking.clear();
    this.duckTarget = 1;
    this.send({ t: 'voice', on: false });
    this.hooks.onSpeaking?.(this.myId, false);
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
  }

  // ---------------------------------------------------------------- camera

  async setCamera(on, playing) {
    if (!this.micOn || this.camOn === on) return;

    if (!on) {
      const track = this.localStream.getVideoTracks()[0];
      if (track) {
        for (const { pc } of this.peers.values()) {
          const sender = pc.getSenders().find((s) => s.track === track);
          if (sender) pc.removeTrack(sender);
        }
        track.stop();
        this.localStream.removeTrack(track);
      }
      this.camOn = false;
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
    this.localStream.addTrack(track);

    for (const { pc } of this.peers.values()) {
      const sender = pc.addTrack(track, this.localStream);
      this.capSender(sender, profile.bitrate);
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
        if (sender.track?.kind === 'video') this.capSender(sender, profile.bitrate);
      }
    }
  }

  async capSender(sender, bitrate) {
    try {
      const params = sender.getParameters();
      params.encodings = params.encodings?.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = bitrate;
      await sender.setParameters(params);
    } catch {}
  }

  /**
   * The buffer-aware throttle. When the film is running out of runway, video
   * is the first thing to go and voice is the last — a stalled picture ruins
   * the evening, a frozen thumbnail does not.
   */
  applyBufferPressure(bufferedAhead, playing) {
    if (!this.camOn || !playing) return;
    const bitrate =
      bufferedAhead < 5 ? 0 : bufferedAhead < 10 ? 60_000 : CAM_PLAYING.bitrate;
    for (const { pc } of this.peers.values()) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === 'video') this.capSender(sender, bitrate || 1000);
      }
    }
    this.hooks.onThrottle?.(bufferedAhead < 10);
  }

  // ----------------------------------------------------------------- peers

  onRoster(peers) {
    this.known.clear();
    for (const p of peers) if (p.id && p.id !== this.myId) this.known.set(p.id, p);

    for (const id of [...this.peers.keys()]) {
      if (!this.known.has(id)) this.dropPeer(id);
    }
    if (this.micOn) this.dialKnownPeers();
  }

  dialKnownPeers() {
    for (const [id, p] of this.known) {
      if (p.voice && !this.peers.has(id)) this.openPeer(id);
    }
  }

  openPeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    // Perfect negotiation: exactly one side must yield when both offer at
    // once. Comparing ids gives both ends the same answer without a round trip.
    const entry = { pc, polite: this.myId < id, makingOffer: false, ignoreOffer: false, meter: null };
    this.peers.set(id, entry);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) pc.addTrack(track, this.localStream);
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
    if (!this.micOn) return;
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
    if (audio.srcObject !== stream) audio.srcObject = stream;
    audio.play().catch(() => {});

    const entry = this.peers.get(id);
    if (entry && !entry.meter && stream.getAudioTracks().length) {
      this.ensureAudioContext();
      entry.meter = this.makeMeter(stream);
    }

    this.hooks.onPeerStream?.(id, stream);
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
