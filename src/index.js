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

/**
 * The embedded browser's preflight.
 *
 * Framing is the whole problem. Most of the web sets `X-Frame-Options` or a
 * CSP `frame-ancestors`, and a blocked frame fails *silently* — no error
 * event, no readable status, just a blank rectangle, because the response
 * never becomes a document this origin can see. So the answer has to be
 * fetched server-side and reported before the iframe is ever pointed at it.
 *
 * The same fetch is worth more than a yes/no. While the HTML is in hand it
 * costs nothing to pull out the title, any video files the page references
 * and its outgoing links — which means a page that refuses to be framed
 * still yields the one thing this app actually wants from it.
 */

/**
 * A subtitle file beside a film, fetched for the page. A page can read another
 * site's file only when that site sends CORS headers, and most hosts do not,
 * so the room's lookup for movie.vtt beside movie.mp4 failed — and logged an
 * error — on nearly every film. Only .vtt and .srt, only small ones, and never
 * an HTML error page passed off as subtitles.
 */
const SUBTITLE_MAX_BYTES = 2 * 1024 * 1024;

async function fetchSubtitles(target) {
  if (!/\.(vtt|srt)$/i.test(target.pathname)) return null;
  const res = await fetch(target, { redirect: 'follow' });
  if (!res.ok) return null;
  if (Number(res.headers.get('content-length') || 0) > SUBTITLE_MAX_BYTES) return null;
  const text = await res.text();
  if (text.length > SUBTITLE_MAX_BYTES || /^\s*</.test(text)) return null;
  return text;
}

/** Blocks the request from being aimed back inside the network fetching it. */
function safeUrl(raw) {
  let u;
  try {
    u = new URL(String(raw));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) return null;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return null;
    if (a === 169 && b === 254) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 192 && b === 168) return null;
    if (a === 100 && b >= 64 && b <= 127) return null;
    if (a >= 224) return null;
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return null;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return null;
  }
  return u;
}

/**
 * `frame-ancestors *` allows anyone; anything else names specific origins,
 * and this Worker is not going to be among them in any realistic case.
 * X-Frame-Options has no allow-list worth honouring — ALLOW-FROM is dead in
 * every current browser.
 */
function framingVerdict(res) {
  const xfo = (res.headers.get('x-frame-options') || '').trim();
  if (/deny|sameorigin/i.test(xfo)) return { embeddable: false, blockedBy: `X-Frame-Options: ${xfo}` };

  const csp = res.headers.get('content-security-policy') || '';
  const m = csp.match(/frame-ancestors([^;]*)/i);
  if (m) {
    const list = m[1].trim();
    if (!/(^|\s)\*(\s|$)/.test(list)) {
      return { embeddable: false, blockedBy: `Content-Security-Policy: frame-ancestors ${list}` };
    }
  }
  return { embeddable: true, blockedBy: null };
}

/**
 * Statuses that mean "this check was turned away", not "this page is broken".
 * A bot challenge, a rate limit and a login wall all answer here, and none of
 * them say anything about the page a real browser would be served.
 */
const CHALLENGE_STATUS = new Set([401, 403, 405, 406, 429, 503]);

const VIDEO_FILE = /\.(mp4|m4v|webm|ogv|mov|m3u8)(\?|#|$)/i;

/**
 * Enough of the document to find the head and the players. Generous on
 * purpose: YouTube puts its own <title> 700KB into the response, and a cap
 * tight enough to feel safe is a cap that misses the name of the page.
 */
const HTML_SCAN_BYTES = 1_600_000;

function absolute(href, base) {
  try {
    const u = new URL(href, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function decodeEntities(s) {
  return s
    .replace(/&(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|#39|apos);/gi, (all, e) => {
      if (e[0] === '#') return String.fromCodePoint(Number(e[1] === 'x' || e[1] === 'X' ? '0' + e.slice(1) : e.slice(1)));
      return { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" }[e.toLowerCase()] || all;
    })
    .trim();
}

function scrapePage(html, base) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ')) : null;

  const videos = new Map();
  const addVideo = (href, label) => {
    const abs = href && absolute(decodeEntities(href), base);
    if (!abs || videos.has(abs)) return;
    if (!VIDEO_FILE.test(abs)) return;
    videos.set(abs, { url: abs, label, name: decodeURIComponent(abs.split('/').pop().split(/[?#]/)[0]).slice(0, 90) });
  };

  // A <video src>, a <source> inside one, and og:video are where a page
  // states its own film. Everything else is a guess from the extension.
  for (const m of html.matchAll(/<(?:video|source|embed)\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    addVideo(m[1], 'player');
  }
  for (const m of html.matchAll(
    /<meta\b[^>]*\b(?:property|name)\s*=\s*["']og:video(?::url|:secure_url)?["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/gi
  )) {
    addVideo(m[1], 'og:video');
  }
  for (const m of html.matchAll(/\b(?:href|src|data-src)\s*=\s*["']([^"']+)["']/gi)) {
    addVideo(m[1], 'link');
  }

  const links = new Map();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const abs = absolute(decodeEntities(m[1]), base);
    if (!abs || links.has(abs) || videos.has(abs)) continue;
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
    if (text.length < 2) continue;
    links.set(abs, { url: abs, text: text.slice(0, 80) });
    if (links.size >= 60) break;
  }

  return { title, videos: [...videos.values()].slice(0, 20), links: [...links.values()] };
}

async function inspectForEmbedding(target) {
  const res = await fetch(target, {
    redirect: 'follow',
    headers: {
      // Sent as a browser because a page that thinks it is talking to a
      // crawler serves something different from what the iframe will get.
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const finalUrl = res.url || String(target);
  const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const { embeddable, blockedBy } = framingVerdict(res);

  const base = {
    ok: true,
    url: finalUrl,
    status: res.status,
    contentType,
    // Three-valued, and the third value is the important one.
    //
    // This check runs from a datacenter IP with no cookies and no browser
    // behind it, which is exactly what bot protection exists to turn away. A
    // challenge page's headers describe the challenge, not the site — so a
    // 403 here says nothing about whether the page can be framed, and
    // reporting `false` would condemn a page that loads perfectly well from
    // the viewer's own address. Unknown is the honest answer, and the frame
    // itself is the only thing that can settle it.
    embeddable: res.ok ? embeddable : CHALLENGE_STATUS.has(res.status) ? null : false,
    blockedBy: res.ok ? blockedBy : null,
    title: null,
    videos: [],
    links: []
  };

  // A URL that *is* the video needs no scraping — it is already the answer.
  if (contentType.startsWith('video/') || (!contentType.startsWith('text/html') && VIDEO_FILE.test(finalUrl))) {
    res.body?.cancel();
    return {
      ...base,
      embeddable: false,
      blockedBy: null,
      isMedia: true,
      videos: [{ url: finalUrl, label: 'direct file', name: decodeURIComponent(finalUrl.split('/').pop().split(/[?#]/)[0]).slice(0, 90) }]
    };
  }

  if (!contentType.startsWith('text/html') && contentType !== '') {
    res.body?.cancel();
    return base;
  }

  // Scraping a challenge page harvests the interstitial — "Just a moment..."
  // and the scripts behind it — and then presents that as the site. Return
  // nothing instead, and let the client say the check was blocked.
  if (!res.ok) {
    res.body?.cancel();
    return base;
  }

  const html = (await res.text()).slice(0, HTML_SCAN_BYTES);
  return { ...base, ...scrapePage(html, finalUrl) };
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

    /**
     * Ask, before framing, whether a page can be framed at all — and bring
     * back the video files it references either way. See the notes above
     * inspectForEmbedding for why the browser cannot answer this itself.
     */
    if (url.pathname === '/api/embed-check') {
      const target = safeUrl(url.searchParams.get('url') || '');
      if (!target) {
        return Response.json({ ok: false, error: 'That is not a public http or https address.' }, { status: 400 });
      }
      try {
        return Response.json(await inspectForEmbedding(target));
      } catch {
        return Response.json(
          { ok: false, error: 'That site could not be reached. Check the address, or open it in a tab.' },
          { status: 502 }
        );
      }
    }

    // 204 rather than 404 when there is no file: the room asks for movie.vtt
    // and movie.srt on every film, and each 404 is an error in the console
    // even though nothing went wrong.
    if (url.pathname === '/api/subtitles') {
      const target = safeUrl(url.searchParams.get('url') || '');
      if (!target) return new Response(null, { status: 204 });
      try {
        const text = await fetchSubtitles(target);
        if (text === null) return new Response(null, { status: 204 });
        return new Response(text, {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' }
        });
      } catch {
        return new Response(null, { status: 204 });
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
