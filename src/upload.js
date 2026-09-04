/**
 * Uploading a film to R2, and serving it back.
 *
 * Multipart throughout, via the R2 binding rather than presigned S3 URLs —
 * the binding needs no access keys to manage, and a part that fails is one
 * 8 MB retry instead of restarting a four gigabyte upload.
 *
 * Parts pass through the Worker. That costs a request each but no egress, and
 * it keeps the browser talking to one origin with no CORS or signing to go
 * wrong.
 */

const PART_MIN = 5 * 1024 * 1024;        // R2's floor for a non-final part
const MAX_SIZE = 6 * 1024 * 1024 * 1024; // refuse what cannot fit the free tier
const KEEP_DAYS = 7;

/** Keep something human in the key without letting a filename become a path. */
function safeName(name) {
  return String(name || 'film')
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .slice(-80) || 'film';
}

function json(data, status = 200) {
  return Response.json(data, { status });
}

export async function handleUpload(request, env, url) {
  if (!env.MEDIA) {
    return json(
      { error: 'Storage is not set up yet. Run: npx wrangler r2 bucket create watch-together-media' },
      503
    );
  }

  // ---------------------------------------------------------------- create
  if (url.pathname === '/api/upload/create' && request.method === 'POST') {
    const { name, size, type, title } = await request.json();

    if (!Number.isFinite(size) || size <= 0) return json({ error: 'Missing file size.' }, 400);
    if (size > MAX_SIZE) {
      return json({ error: 'That file is larger than 6 GB — too big for this room.' }, 413);
    }

    const key = `${crypto.randomUUID().slice(0, 8)}/${safeName(name)}`;
    const mpu = await env.MEDIA.createMultipartUpload(key, {
      httpMetadata: {
        contentType: type || 'video/mp4',
        // Immutable: the key is unique per upload, so it can be cached hard.
        cacheControl: 'public, max-age=31536000, immutable'
      },
      customMetadata: {
        title: String(title || name || 'Film').slice(0, 120),
        uploadedAt: String(Date.now())
      }
    });

    return json({ key, uploadId: mpu.uploadId, partSize: 8 * 1024 * 1024 });
  }

  // ------------------------------------------------------------------ part
  if (url.pathname === '/api/upload/part' && request.method === 'PUT') {
    const key = url.searchParams.get('key');
    const uploadId = url.searchParams.get('uploadId');
    const partNumber = Number(url.searchParams.get('part'));

    if (!key || !uploadId || !partNumber) return json({ error: 'Bad part request.' }, 400);
    if (!request.body) return json({ error: 'Empty part.' }, 400);

    const mpu = env.MEDIA.resumeMultipartUpload(key, uploadId);
    const part = await mpu.uploadPart(partNumber, request.body);
    return json({ partNumber: part.partNumber, etag: part.etag });
  }

  // -------------------------------------------------------------- complete
  if (url.pathname === '/api/upload/complete' && request.method === 'POST') {
    const { key, uploadId, parts } = await request.json();
    if (!key || !uploadId || !Array.isArray(parts) || !parts.length) {
      return json({ error: 'Nothing to finish.' }, 400);
    }

    const mpu = env.MEDIA.resumeMultipartUpload(key, uploadId);
    // R2 rejects an out-of-order list, and a resumed upload can finish its
    // parts in any order.
    parts.sort((a, b) => a.partNumber - b.partNumber);
    await mpu.complete(parts);

    return json({ key, url: `/media/${key}` });
  }

  // ----------------------------------------------------------------- abort
  if (url.pathname === '/api/upload/abort' && request.method === 'POST') {
    const { key, uploadId } = await request.json();
    if (key && uploadId) {
      try {
        await env.MEDIA.resumeMultipartUpload(key, uploadId).abort();
      } catch {}
    }
    return json({ ok: true });
  }

  return null;
}

/**
 * Serve an uploaded film, honouring Range.
 *
 * Range is what makes seeking work at all — without it a browser must pull
 * the whole file to jump to the last ten minutes.
 */
export async function serveMedia(request, env, url) {
  if (!env.MEDIA) return new Response('Storage is not configured', { status: 503 });

  const key = decodeURIComponent(url.pathname.slice('/media/'.length));
  if (!key) return new Response('Not found', { status: 404 });

  const range = request.headers.get('range');
  const object = await env.MEDIA.get(key, range ? { range: request.headers } : undefined);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('accept-ranges', 'bytes');

  const expires = expiryOf(object);
  if (expires) headers.set('x-expires', String(expires));

  if (request.method === 'HEAD') {
    headers.set('content-length', String(object.size));
    return new Response(null, { headers });
  }

  // A ranged hit comes back with a `range` describing what was actually read,
  // and the browser needs that echoed as content-range or it will not seek.
  if (object.range && 'offset' in object.range) {
    const start = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - start;
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('content-length', String(object.size));
  return new Response(object.body, { headers });
}

function expiryOf(object) {
  const at = Number(object.customMetadata?.uploadedAt);
  if (!at) return null;
  return at + KEEP_DAYS * 24 * 60 * 60 * 1000;
}

export { KEEP_DAYS, PART_MIN };
