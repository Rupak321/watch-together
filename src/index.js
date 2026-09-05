export { Room } from './room.js';

/**
 * Room codes avoid characters people misread aloud over the phone:
 * no 0/O, no 1/I/L. 31 symbols, 6 places — about 900 million codes.
 */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function normalizeCode(raw) {
  const code = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (code.length < 4 || code.length > 12) return null;
  for (const ch of code) if (!ALPHABET.includes(ch)) return null;
  return code;
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * Internet Archive is proxied rather than called from the page: it keeps the
 * browser off a third-party origin, sidesteps CORS entirely, and means one
 * place to fix when their API shifts.
 */
async function archiveSearch(query) {
  const url = new URL('https://archive.org/advancedsearch.php');
  url.searchParams.set('q', `(${query}) AND mediatype:(movies)`);
  url.searchParams.set('rows', '20');
  url.searchParams.set('page', '1');
  url.searchParams.set('output', 'json');
  url.search += '&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=year&sort%5B%5D=downloads+desc';

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('archive search failed');

  const data = await res.json();
  const docs = data?.response?.docs || [];
  return docs
    .filter((d) => d.identifier)
    .map((d) => ({
      id: d.identifier,
      title: Array.isArray(d.title) ? d.title[0] : d.title || d.identifier,
      year: d.year || null
    }));
}

/** Browsers play H.264 in MP4. Everything else in an item is noise here. */
const PLAYABLE = /\.(mp4|m4v)$/i;

/** "reel-2of5.mp4", "feature_part3.mp4", "film-cd1.mp4" — a split feature. */
const PART_RE = /(?:^|[^a-z0-9])(?:(\d{1,2})\s*of\s*(\d{1,2})|(?:part|pt|cd|disc|reel)[\s_.-]*(\d{1,2}))(?![0-9])/i;

function partOf(name) {
  const m = name.match(PART_RE);
  if (!m) return null;
  return { index: Number(m[1] || m[3]), total: m[2] ? Number(m[2]) : null };
}

async function archivePick(id) {
  const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error('archive metadata failed');

  const meta = await res.json();
  const files = meta?.files || [];

  const candidates = files
    .filter((f) => f.name && PLAYABLE.test(f.name))
    .map((f) => ({ name: f.name, size: Number(f.size) || 0, format: f.format || '' }));

  if (!candidates.length) return null;

  // Bigger is better among equivalent files: many items carry several
  // bitrates of the same content, and the largest is the best copy.
  const byQuality = (a, b) => {
    const aD = /264|MPEG4/i.test(a.format) ? 1 : 0;
    const bD = /264|MPEG4/i.test(b.format) ? 1 : 0;
    if (aD !== bD) return bD - aD;
    return b.size - a.size;
  };

  // Plenty of archive items hold no complete copy at all — only a feature cut
  // into reels. There is no single right file then, so take the FIRST part
  // and say so, rather than silently dropping people into the middle of the
  // film. Sorting by size alone lands on whichever reel happens to be
  // biggest, which is arbitrary.
  const parts = candidates.map((c) => ({ ...c, part: partOf(c.name) })).filter((c) => c.part);
  let file;
  let partInfo = null;

  if (parts.length && parts.length === candidates.length) {
    const first = Math.min(...parts.map((p) => p.part.index));
    const firstParts = parts.filter((p) => p.part.index === first).sort(byQuality);
    file = firstParts[0].name;
    partInfo = {
      index: first,
      total: parts.find((p) => p.part.total)?.part.total ?? new Set(parts.map((p) => p.part.index)).size
    };
  } else {
    // A complete copy exists alongside any reels — prefer it.
    const whole = candidates.filter((c) => !partOf(c.name));
    file = (whole.length ? whole : candidates).sort(byQuality)[0].name;
  }

  const server = meta.server || 'archive.org';
  const dir = meta.dir || '';

  return {
    url: `https://${server}${dir}/${encodeURIComponent(file)}`,
    title: meta?.metadata?.title || id,
    part: partInfo
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/new-room') {
      return Response.json({ code: newCode() });
    }

    /**
     * ICE configuration. Public STUN alone connects most people; the roughly
     * one in six behind a symmetric NAT needs a relay, and a relay always
     * costs someone money, so it needs real credentials.
     *
     * To turn TURN on, create a Realtime TURN key in the Cloudflare dashboard
     * and set both secrets:
     *   npx wrangler secret put TURN_TOKEN_ID
     *   npx wrangler secret put TURN_API_TOKEN
     * Cloudflare's free tier covers 1,000 GB/month of relayed traffic.
     */
    if (url.pathname === '/api/ice') {
      const stun = [{ urls: 'stun:stun.l.google.com:19302' }];

      if (!env.TURN_TOKEN_ID || !env.TURN_API_TOKEN) {
        return Response.json({ iceServers: stun, relay: false });
      }

      try {
        const res = await fetch(
          `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_TOKEN_ID}/credentials/generate-ice-servers`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${env.TURN_API_TOKEN}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ttl: 3600 })
          }
        );
        if (!res.ok) throw new Error('turn credentials rejected');
        const data = await res.json();
        return Response.json({ iceServers: data.iceServers || stun, relay: true });
      } catch {
        // A relay outage must not take voice down for everyone who doesn't
        // need one.
        return Response.json({ iceServers: stun, relay: false });
      }
    }

    if (url.pathname === '/api/archive/search') {
      const q = (url.searchParams.get('q') || '').slice(0, 120);
      if (!q) return Response.json({ results: [] });
      try {
        return Response.json({ results: await archiveSearch(q) });
      } catch {
        return Response.json({ error: 'Search is unavailable right now.' }, { status: 502 });
      }
    }

    if (url.pathname === '/api/archive/pick') {
      const id = (url.searchParams.get('id') || '').slice(0, 200);
      if (!id) return Response.json({ error: 'Missing id' }, { status: 400 });
      try {
        const picked = await archivePick(id);
        if (!picked) return Response.json({ error: 'No playable file' }, { status: 404 });
        return Response.json(picked);
      } catch {
        return Response.json({ error: 'Could not reach the archive.' }, { status: 502 });
      }
    }

    if (url.pathname === '/ws') {
      const code = normalizeCode(url.searchParams.get('room'));
      if (!code) return new Response('bad room code', { status: 400 });

      // idFromName is deterministic: the same code always reaches the same
      // object, anywhere in the world, with no lookup table.
      const id = env.ROOM.idFromName(code);
      return env.ROOM.get(id).fetch(request);
    }

    // /r/CODE is a real page, served from the room document without a redirect.
    //
    // Asking the asset handler for "/room.html" makes it 301 to "/room", and
    // the browser follows that — replacing /r/CODE in the address bar and
    // losing the room code the page needs. So request the extensionless path,
    // and if a redirect still comes back, follow it here rather than letting
    // it reach the client.
    if (url.pathname.startsWith('/r/')) {
      const code = normalizeCode(url.pathname.slice(3));
      if (!code) return Response.redirect(new URL('/', request.url).toString(), 302);

      let res = await env.ASSETS.fetch(new Request(new URL('/room', request.url), request));
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc) res = await env.ASSETS.fetch(new Request(new URL(loc, request.url), request));
      }
      return new Response(res.body, { status: res.status, headers: res.headers });
    }

    return env.ASSETS.fetch(request);
  }
};
