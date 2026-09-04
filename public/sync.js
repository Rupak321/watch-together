/**
 * Clock estimation and drift correction — the core of the whole product.
 */

const MAX_RATE_ADJ = 0.07; // past ~10% the pitch shift becomes audible
const HARD_SEEK_AT = 1.0;  // seconds of drift beyond which nudging is hopeless
const SEEK_LEAD = 0.15;    // land slightly ahead; the seek itself costs time

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * NTP-style offset estimation against the room's Durable Object.
 *
 * Deliberately keeps the lowest-RTT sample rather than averaging: a sample
 * delayed by a congested hop carries that delay straight into its offset
 * estimate, so averaging drags the result toward whatever was slowest.
 */
export class SyncClock {
  constructor() {
    this.samples = [];
    this.offset = 0;
    this.rtt = null;
    this.locked = false;
  }

  addSample(sentAt, serverTime, receivedAt) {
    const rtt = receivedAt - sentAt;
    const offset = serverTime - (sentAt + rtt / 2);

    this.samples.push({ rtt, offset });
    if (this.samples.length > 8) this.samples.shift();

    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;

    this.offset = best.offset;
    this.rtt = best.rtt;
    this.locked = this.samples.length >= 4;
  }

  /** Server wall clock, as best we can tell. */
  now() {
    return Date.now() + this.offset;
  }

  /** Ping often while converging, then back off to protect the request budget. */
  nextPingDelay() {
    if (this.samples.length < 8) return 400;
    if (this.samples.length < 20) return 10000;
    return 30000;
  }
}

/**
 * Holds one video source against a target position.
 *
 * Correction is by playback rate, not seeking. A seek is visible and audible;
 * a 7% rate change for a few seconds is neither. Sources that can't take fine
 * rate changes (YouTube only accepts discrete rates, and treats them as
 * advisory) get a wider deadband and micro-seeks instead.
 */
export class DriftCorrector {
  constructor(source) {
    this.source = source;
    this.deadband = source.supportsFineRate ? 0.05 : 0.4;
    this.lastDrift = 0;
    this.lastAction = 'idle';
  }

  correct(target) {
    const drift = this.source.getCurrentTime() - target;
    const mag = Math.abs(drift);
    this.lastDrift = drift;

    if (mag >= HARD_SEEK_AT) {
      this.source.setPlaybackRate(1);
      this.source.seek(target + SEEK_LEAD);
      this.lastAction = 'seek';
    } else if (mag < this.deadband) {
      this.source.setPlaybackRate(1);
      this.lastAction = 'hold';
    } else if (this.source.supportsFineRate) {
      this.source.setPlaybackRate(1 - clamp(drift * 0.5, -MAX_RATE_ADJ, MAX_RATE_ADJ));
      this.lastAction = 'nudge';
    } else {
      this.source.seek(target + SEEK_LEAD);
      this.lastAction = 'microseek';
    }

    return drift;
  }

  reset() {
    this.source.setPlaybackRate(1);
    this.lastAction = 'idle';
  }
}

/** Where the movie should be right now, from an anchor plus a clock. */
export function targetPosition(state, syncedNow) {
  if (!state.playing) return state.anchorTime;
  return state.anchorTime + ((syncedNow - state.anchorClock) / 1000) * (state.rate || 1);
}
