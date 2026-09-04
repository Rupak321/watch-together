/**
 * Decide whether this browser can actually play a file, before uploading it.
 *
 * This matters more than it sounds. Most films people have are .mkv holding
 * H.265 video and AC3 or DTS audio, and no browser plays that combination:
 * Chrome and Firefox will never decode AC3, and Matroska is supported nowhere.
 * Without this check the file uploads perfectly over forty minutes and then
 * plays as video with no sound, which looks like a bug in the room.
 *
 * There is no metadata API for this in the browser, so the test is empirical:
 * hand the file to a <video> element and see what comes back.
 */

const CONTAINERS = {
  mkv: 'Matroska (.mkv)',
  avi: 'AVI',
  wmv: 'Windows Media',
  flv: 'Flash Video',
  rmvb: 'RealMedia',
  vob: 'DVD VOB',
  ts: 'MPEG transport stream',
  m2ts: 'Blu-ray transport stream',
  mpg: 'MPEG program stream',
  mpeg: 'MPEG program stream'
};

const PROBE_TIMEOUT_MS = 20000;
const AUDIO_SETTLE_MS = 900;

export function extensionOf(name) {
  return (String(name).match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
}

/** A container no browser opens — worth refusing before any bytes move. */
export function unsupportedContainer(name) {
  return CONTAINERS[extensionOf(name)] || null;
}

/**
 * @returns {Promise<{ok, video, audio, width, height, duration, reason}>}
 *   `audio` is true, false, or null when the browser gives us no way to tell.
 */
export function probeFile(file) {
  return new Promise((resolve) => {
    const container = unsupportedContainer(file.name);
    if (container) {
      return resolve({
        ok: false,
        video: false,
        audio: false,
        reason: `${container} files do not play in any browser. Convert it to MP4 first.`
      });
    }

    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true; // so the probe is silent, and so play() is allowed
    v.playsInline = true;

    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        v.pause();
        v.removeAttribute('src');
        v.load();
      } catch {}
      URL.revokeObjectURL(url);
      resolve(r);
    };

    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          video: false,
          audio: null,
          reason: 'This file took too long to open. It may be damaged, or in a format this browser cannot read.'
        }),
      PROBE_TIMEOUT_MS
    );

    v.addEventListener('error', () =>
      finish({
        ok: false,
        video: false,
        audio: false,
        reason: 'This browser cannot decode that file. An MP4 with H.264 video and AAC audio plays everywhere.'
      })
    );

    v.addEventListener('loadedmetadata', async () => {
      const width = v.videoWidth;
      const height = v.videoHeight;
      const duration = isFinite(v.duration) ? v.duration : 0;

      if (!width) {
        return finish({
          ok: false,
          video: false,
          audio: null,
          reason: 'The video track will not decode here — most likely H.265/HEVC. Re-encode to H.264.'
        });
      }

      // Roll it briefly and ask how many audio bytes actually decoded. A file
      // with AC3 or DTS opens happily and decodes nothing, which is exactly
      // the silent-film failure this exists to catch.
      try {
        await v.play();
      } catch {}
      await new Promise((r) => setTimeout(r, AUDIO_SETTLE_MS));

      let audio = null;
      if (typeof v.webkitAudioDecodedByteCount === 'number') {
        audio = v.webkitAudioDecodedByteCount > 0;
      } else if (typeof v.mozHasAudio === 'boolean') {
        audio = v.mozHasAudio;
      }

      finish({
        ok: true,
        video: true,
        audio,
        width,
        height,
        duration,
        reason:
          audio === false
            ? 'The picture plays but the audio track will not decode — usually AC3 or DTS. Everyone would watch it silently.'
            : ''
      });
    });

    v.src = url;
  });
}

/** `ffmpeg -i in.mkv -c:v copy -c:a aac out.mp4` style advice, per problem. */
export function fixCommand(file, result) {
  const out = String(file.name).replace(/\.[^.]+$/, '') + '.mp4';
  // Copying the video stream is seconds; re-encoding it is most of an hour.
  const v = result.video ? '-c:v copy' : '-c:v libx264 -crf 20 -preset fast';
  const a = result.audio === false || !result.video ? '-c:a aac -b:a 192k' : '-c:a copy';
  return `ffmpeg -i "${file.name}" ${v} ${a} "${out}"`;
}
