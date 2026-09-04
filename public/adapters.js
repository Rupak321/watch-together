/**
 * Source adapters.
 *
 * The sync engine talks only to this shape, never to a player directly:
 *
 *   play() pause() seek(t) getCurrentTime() getBufferedAhead()
 *   setPlaybackRate(r) setVolume(v) isReady() destroy()
 *   supportsFineRate: boolean
 *   kind: string
 *
 * Adding a source must never mean touching sync.js.
 *
 * setVolume takes 0..1 and exists so ducking works the same for every source.
 * Routing a <video> through Web Audio would be the richer approach, but the
 * YouTube player lives in a cross-origin iframe whose audio we can never
 * reach — its own API is the only handle. One method both can honour beats a
 * good mechanism that covers half the sources.
 */

const READY_BUFFER_S = 5;

// ---------------------------------------------------------------- YouTube

let ytApiPromise = null;

function loadYouTubeApi() {
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return ytApiPromise;
}

/**
 * YouTube reports position through getCurrentTime(), which is not timestamped —
 * there is no way to know when the value was sampled, and it moves in visible
 * steps. setPlaybackRate() only accepts discrete rates and is advisory. Both
 * are why this adapter declares supportsFineRate: false and lets the corrector
 * fall back to a wider deadband with micro-seeks.
 */
export function createYouTubeSource(mountEl, videoId) {
  return loadYouTubeApi().then(
    (YT) =>
      new Promise((resolve) => {
        const host = document.createElement('div');
        mountEl.innerHTML = '';
        mountEl.appendChild(host);

        const player = new YT.Player(host, {
          videoId,
          playerVars: {
            controls: 0,
            disablekb: 1,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            iv_load_policy: 3
          },
          events: {
            onReady: () => resolve(wrapYouTube(player, mountEl))
          }
        });
      })
  );
}

function wrapYouTube(player, mountEl) {
  return {
    kind: 'youtube',
    supportsFineRate: false,

    play() {
      player.playVideo();
    },
    pause() {
      player.pauseVideo();
    },
    seek(t) {
      player.seekTo(Math.max(0, t), true);
    },
    getCurrentTime() {
      const t = player.getCurrentTime();
      return typeof t === 'number' ? t : 0;
    },
    getDuration() {
      return player.getDuration() || 0;
    },
    getBufferedAhead() {
      const dur = player.getDuration() || 0;
      const frac = player.getVideoLoadedFraction() || 0;
      return Math.max(0, dur * frac - this.getCurrentTime());
    },
    setPlaybackRate(r) {
      // Only discrete rates are accepted, and the call is a suggestion.
      // Nothing here depends on it landing.
      const nearest = r > 1.02 ? 1.25 : r < 0.98 ? 0.75 : 1;
      if (player.getPlaybackRate() !== nearest) player.setPlaybackRate(nearest);
    },
    setVolume(v) {
      player.setVolume(Math.round(Math.max(0, Math.min(1, v)) * 100));
    },
    isReady() {
      const s = player.getPlayerState();
      return s === 1 || s === 2 || s === 5 || this.getBufferedAhead() >= READY_BUFFER_S;
    },
    destroy() {
      try {
        player.destroy();
      } catch {}
      mountEl.innerHTML = '';
    }
  };
}

// ------------------------------------------------------------- direct file

/**
 * Any direct video URL. Cross-origin works without CORS headers here — the
 * same-origin policy limits what JavaScript can read, not what a <video>
 * element can render. (An .m3u8 through hls.js is the case that does need
 * CORS, because that fetches segments via XHR.)
 */
export function createFileSource(mountEl, url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.src = url;
    video.playsInline = true;
    video.preload = 'auto';
    video.style.width = '100%';
    video.style.display = 'block';

    mountEl.innerHTML = '';
    mountEl.appendChild(video);

    const onLoaded = () => {
      cleanup();
      resolve(wrapFile(video, mountEl));
    };
    const onError = () => {
      cleanup();
      reject(new Error('That video could not be loaded. Check the URL is a direct file link.'));
    };
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
    };

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onError);
  });
}

function wrapFile(video, mountEl) {
  return {
    kind: 'file',
    supportsFineRate: true,
    el: video,

    play() {
      // Rejects without a user gesture; the join click primes the element.
      video.play().catch(() => {});
    },
    pause() {
      video.pause();
    },
    seek(t) {
      video.currentTime = Math.max(0, t);
    },
    getCurrentTime() {
      return video.currentTime || 0;
    },
    getDuration() {
      return isFinite(video.duration) ? video.duration : 0;
    },
    getBufferedAhead() {
      const t = video.currentTime;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= t && t <= video.buffered.end(i)) {
          return video.buffered.end(i) - t;
        }
      }
      return 0;
    },
    setPlaybackRate(r) {
      if (Math.abs(video.playbackRate - r) > 0.001) video.playbackRate = r;
    },
    setVolume(v) {
      video.volume = Math.max(0, Math.min(1, v));
    },
    isReady() {
      return video.readyState >= 3 && this.getBufferedAhead() >= READY_BUFFER_S;
    },
    destroy() {
      video.pause();
      video.removeAttribute('src');
      video.load();
      mountEl.innerHTML = '';
    }
  };
}

// ---------------------------------------------------------- synthetic clock

/**
 * A source with no media behind it — position is pure arithmetic.
 *
 * This exists to test the sync engine on its own terms. Real video drags in
 * decoder timing, network stalls and coarse position reporting, all of which
 * mask whether the *clock* is right. Here playback rate genuinely moves the
 * position, so a nudge is measurable, and drift can be injected on demand to
 * prove the corrector recovers.
 */
export function createTestSource(mountEl) {
  let anchorPos = 0;
  let anchorAt = performance.now();
  let playing = false;
  let rate = 1;

  mountEl.innerHTML = '';
  const readout = document.createElement('div');
  readout.style.cssText =
    'height:100%;display:grid;place-content:center;text-align:center;gap:10px;' +
    'font:600 clamp(28px,7vw,64px)/1 ui-monospace,monospace;color:#E8A33D;' +
    'font-variant-numeric:tabular-nums';
  const time = document.createElement('div');
  const meta = document.createElement('div');
  meta.style.cssText = 'font:400 13px/1.4 ui-monospace,monospace;color:#8A7D74;letter-spacing:.1em';
  readout.append(time, meta);
  mountEl.appendChild(readout);

  const src = {
    kind: 'test',
    supportsFineRate: true,

    getCurrentTime() {
      if (!playing) return anchorPos;
      return anchorPos + ((performance.now() - anchorAt) / 1000) * rate;
    },
    /** Re-anchor on every state change so position stays continuous. */
    _reanchor() {
      anchorPos = this.getCurrentTime();
      anchorAt = performance.now();
    },
    play() {
      if (playing) return;
      this._reanchor();
      playing = true;
    },
    pause() {
      if (!playing) return;
      this._reanchor();
      playing = false;
    },
    seek(t) {
      anchorPos = Math.max(0, t);
      anchorAt = performance.now();
    },
    setPlaybackRate(r) {
      if (Math.abs(rate - r) < 0.0005) return;
      this._reanchor();
      rate = r;
    },
    getPlaybackRate() {
      return rate;
    },
    setVolume() {
      /* no audio to duck */
    },
    getDuration() {
      return 7200;
    },
    getBufferedAhead() {
      return 999;
    },
    isReady() {
      return true;
    },
    /** Shove the playhead off target to test recovery. */
    injectDrift(seconds) {
      this.seek(this.getCurrentTime() + seconds);
    },
    destroy() {
      cancelAnimationFrame(raf);
      mountEl.innerHTML = '';
    }
  };

  let raf;
  const paint = () => {
    const t = src.getCurrentTime();
    const m = Math.floor(t / 60);
    const s = t % 60;
    time.textContent = `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
    meta.textContent = `${playing ? 'playing' : 'paused'} · rate ${rate.toFixed(3)}`;
    raf = requestAnimationFrame(paint);
  };
  paint();

  return Promise.resolve(src);
}

// ------------------------------------------------------------------ router

const YT_PATTERNS = [
  /youtube\.com\/watch\?[^#]*\bv=([\w-]{11})/,
  /youtu\.be\/([\w-]{11})/,
  /youtube\.com\/embed\/([\w-]{11})/,
  /youtube\.com\/shorts\/([\w-]{11})/
];

/** Work out what a pasted string actually is. */
export function identifySource(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  if (raw.toLowerCase() === 'test') return { kind: 'test', id: 'clock' };

  for (const re of YT_PATTERNS) {
    const m = raw.match(re);
    if (m) return { kind: 'youtube', id: m[1] };
  }
  if (/^[\w-]{11}$/.test(raw)) return { kind: 'youtube', id: raw };

  if (/^https?:\/\//i.test(raw)) {
    if (/\.m3u8(\?|$)/i.test(raw)) return { kind: 'hls', id: raw };
    return { kind: 'file', id: raw };
  }
  return null;
}

export function createSource(mountEl, source) {
  if (!source) return Promise.reject(new Error('No source selected.'));
  if (source.kind === 'test') return createTestSource(mountEl);
  if (source.kind === 'youtube') return createYouTubeSource(mountEl, source.id);
  if (source.kind === 'file') return createFileSource(mountEl, source.id);
  if (source.kind === 'hls') {
    return Promise.reject(new Error('HLS arrives in phase 2 — paste a direct file or YouTube link for now.'));
  }
  return Promise.reject(new Error('Unknown source type: ' + source.kind));
}
