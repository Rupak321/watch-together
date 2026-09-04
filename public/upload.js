import { probeFile, fixCommand } from './probe.js';

/**
 * Browser side of the upload.
 *
 * A forty-minute upload has forty minutes in which to fail, so nothing here
 * assumes it will finish in one go: parts are tracked individually and their
 * receipts are kept, which turns a dropped connection into one 8 MB retry
 * rather than starting a four gigabyte file again.
 */

const CONCURRENCY = 3;  // enough to fill a domestic uplink, few enough to stay ordered
const STORE = 'wt:upload:';

function stateKey(file) {
  // Browsers cannot hand back a File across a reload, so the user has to pick
  // the same file again — name and size are what identify it when they do.
  return `${STORE}${file.name}:${file.size}`;
}

function loadState(file) {
  try {
    const raw = localStorage.getItem(stateKey(file));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveState(file, state) {
  try {
    localStorage.setItem(stateKey(file), JSON.stringify(state));
  } catch {}
}

function clearState(file) {
  try {
    localStorage.removeItem(stateKey(file));
  } catch {}
}

export function hasResumable(file) {
  const s = loadState(file);
  return s && s.parts?.length ? s : null;
}

export class Uploader {
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  /** @returns {Promise<{key, url, title} | null>} null if the file was rejected */
  async run(file, { title } = {}) {
    const probe = await probeFile(file);
    this.hooks.onProbe?.(probe, probe.ok ? null : fixCommand(file, probe));
    if (!probe.ok) return null;
    // A silent film is not worth forty minutes of uploading.
    if (probe.audio === false) return null;

    let state = loadState(file);
    if (!state) {
      const res = await fetch('/api/upload/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          type: file.type || 'video/mp4',
          title: title || file.name
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not start the upload.');
      state = { key: data.key, uploadId: data.uploadId, partSize: data.partSize, parts: [] };
      saveState(file, state);
    } else {
      this.hooks.onResume?.(state.parts.length);
    }

    const { key, uploadId, partSize } = state;
    const totalParts = Math.ceil(file.size / partSize);
    const done = new Map(state.parts.map((p) => [p.partNumber, p]));

    const pending = [];
    for (let n = 1; n <= totalParts; n++) if (!done.has(n)) pending.push(n);

    let uploadedBytes = done.size * partSize;
    const report = () =>
      this.hooks.onProgress?.(Math.min(1, uploadedBytes / file.size), done.size, totalParts);
    report();

    const worker = async () => {
      while (pending.length && !this.cancelled) {
        const n = pending.shift();
        const start = (n - 1) * partSize;
        const blob = file.slice(start, Math.min(start + partSize, file.size));

        const part = await this.putPart(key, uploadId, n, blob);
        done.set(n, part);
        state.parts = [...done.values()];
        saveState(file, state);

        uploadedBytes += blob.size;
        report();
      }
    };

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length || 1) }, worker));

    if (this.cancelled) {
      // Deliberately keeps the saved state — cancelling should leave the
      // upload resumable rather than throwing the work away.
      return null;
    }

    const res = await fetch('/api/upload/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, uploadId, parts: [...done.values()] })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not finish the upload.');

    clearState(file);
    return { key, url: data.url, title: title || file.name };
  }

  /** One part, retried a few times — a single blip should not cost the file. */
  async putPart(key, uploadId, partNumber, blob, attempt = 0) {
    try {
      const res = await fetch(
        `/api/upload/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${partNumber}`,
        { method: 'PUT', body: blob }
      );
      if (!res.ok) throw new Error(`part ${partNumber} failed`);
      return await res.json();
    } catch (err) {
      if (attempt >= 3 || this.cancelled) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      return this.putPart(key, uploadId, partNumber, blob, attempt + 1);
    }
  }
}

export function humanSize(bytes) {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}
