/**
 * The embedded browser.
 *
 * It is personal, not shared. Everyone in the room can be looking for
 * something at once without fighting over one address bar, and the moment
 * someone finds a film they push *that* into the room — a source, which the
 * room already knows how to synchronise. Sharing the browsing itself is what
 * screen share is for.
 *
 * Two things a page inside an iframe will never tell us, and the design has
 * to be honest about both:
 *
 *   1. Whether it loaded. A frame refused by X-Frame-Options or CSP fails
 *      silently — no error event, no status, just a blank rectangle. So every
 *      navigation asks the Worker first (/api/embed-check) and the answer is
 *      shown *instead of* the frame when the answer is no.
 *
 *   2. Where it went. Following a link inside a cross-origin frame is
 *      invisible from out here; there is no readable location and no
 *      navigation event. The address bar therefore tracks the pages opened
 *      *through* it, and says so, rather than quietly going stale.
 *
 * The preflight pays for itself twice: the same fetch that answers "can this
 * be framed" also brings back the page's title, its video files and its
 * links. So a page that refuses to be framed still gives up the thing this
 * app wants from it, and can still be walked through link by link.
 */

import { identifySource } from './adapters.js';

const el = (id) => document.getElementById(id);

/** Search rather than navigate, when what was typed is plainly not an address. */
const SEARCH = 'https://html.duckduckgo.com/html/?q=';

function toUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[^\s/@]+\.[a-z]{2,}([/:?#]|$)/i.test(raw)) return 'https://' + raw;
  return SEARCH + encodeURIComponent(raw);
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function createBrowser({ onPlay }) {
  const root = el('browser');
  const frame = el('brFrame');
  const addr = el('brUrl');

  const history = [];
  let at = -1;
  let current = null;   // the last inspection result
  let seq = 0;          // a late reply from an abandoned navigation must not paint

  // -------------------------------------------------------------- painting

  function setBusy(on) {
    el('brBusy').hidden = !on;
    el('brReload').disabled = on;
  }

  function renderNav() {
    el('brBack').disabled = at <= 0;
    el('brFwd').disabled = at < 0 || at >= history.length - 1;
    el('brTab').disabled = !current;
  }

  function clearBody() {
    el('brIntro').hidden = true;
    el('brCard').hidden = true;
    el('brFound').hidden = true;
    el('brFallback').hidden = true;
    el('brFoundList').innerHTML = '';
    el('brLinks').innerHTML = '';
    frame.hidden = true;
  }

  /**
   * Everything on this page the room could actually play — including the
   * address itself, since a YouTube watch page refuses to be framed but
   * carries its video id right there in the URL.
   */
  function playableFrom(info) {
    const out = [];
    const seen = new Set();

    const push = (url, name, note) => {
      const parsed = identifySource(url);
      if (!parsed || seen.has(url)) return;
      seen.add(url);
      out.push({ url, name, note, parsed, playable: parsed.kind !== 'hls' });
    };

    // Every https address parses as a "file", so the page itself only counts
    // when it is something more specific — or when the fetch proved it really
    // is a media file rather than a document.
    const self = identifySource(info.url);
    if (self && (self.kind !== 'file' || info.isMedia)) {
      push(info.url, info.title || hostOf(info.url), 'this page');
    }

    for (const v of info.videos || []) push(v.url, v.name || hostOf(v.url), v.label);
    return out;
  }

  function renderFound(info) {
    const found = playableFrom(info);
    const list = el('brFoundList');
    list.innerHTML = '';

    if (!found.length) {
      el('brFound').hidden = true;
      return;
    }

    for (const f of found) {
      const li = document.createElement('li');

      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = f.name;
      name.title = f.url;

      const note = document.createElement('span');
      note.className = 'yr';
      note.textContent = f.playable ? f.note || '' : 'HLS — not supported yet';

      const text = document.createElement('div');
      text.className = 'br-found-text';
      text.append(name, note);

      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'Play in room';
      btn.disabled = !f.playable;
      btn.addEventListener('click', () => {
        onPlay({ ...f.parsed, title: f.name });
        btn.textContent = 'Sent';
        btn.disabled = true;
      });

      li.append(text, btn);
      list.appendChild(li);
    }
    el('brFound').hidden = false;
  }

  /** What is left of a page that will not be framed: its name, and its links. */
  function renderCard(info) {
    el('brCard').hidden = false;
    el('brCardTitle').textContent = info.title || hostOf(info.url);

    const host = hostOf(info.url);
    const why = el('brCardWhy');
    why.innerHTML = '';

    // Unknown is not the same as no, and the difference decides what to offer.
    const unknown = info.embeddable === null;

    if (info.isMedia) {
      why.textContent = 'This address is a video file, not a page — play it in the room below.';
    } else if (unknown) {
      why.append(
        document.createTextNode(
          `${host} turned the check away — it answered ${info.status} to this site's server, ` +
            `which is what bot protection does to anything that is not a person at a browser. ` +
            `That says nothing about whether the page works for you: your browser loads it from ` +
            `your own address. Try it.`
        )
      );
    } else if (info.status >= 400) {
      why.textContent = `${host} answered ${info.status}. The address may be wrong, or the page may be gone.`;
    } else if (info.blockedBy) {
      why.append(
        document.createTextNode(`${host} does not allow itself to be shown inside another site. `),
        Object.assign(document.createElement('span'), { className: 'mono', textContent: info.blockedBy })
      );
    } else {
      why.textContent = 'There was nothing here to display.';
    }

    // Offer the frame only where it might actually paint. A site whose own
    // headers said DENY will render a blank rectangle every time, and a
    // button that reliably does nothing is worse than no button.
    el('brAnyway').hidden = !unknown;
    el('brCardTab').hidden = false;
    el('brCardHint').hidden = !(unknown || info.blockedBy);

    const links = el('brLinks');
    links.innerHTML = '';
    for (const l of info.links || []) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.appendChild(document.createTextNode(l.text));
      const h = document.createElement('span');
      h.className = 'yr';
      h.textContent = hostOf(l.url);
      b.appendChild(h);
      b.addEventListener('click', () => go(l.url));
      li.appendChild(b);
      links.appendChild(li);
    }
    el('brLinksWrap').hidden = !(info.links || []).length;
  }

  function renderError(message) {
    el('brCard').hidden = false;
    el('brCardTitle').textContent = 'Could not open that';
    el('brCardWhy').textContent = message;
    el('brLinksWrap').hidden = true;
    el('brAnyway').hidden = true;
    el('brCardTab').hidden = true;
    el('brCardHint').hidden = true;
  }

  /**
   * Point the frame at it regardless of what the check said.
   *
   * Reachable only when the check came back unknown. The frame loads from the
   * viewer's own address with their cookies and a real browser behind it, so
   * it routinely succeeds where a datacenter fetch was challenged — and when
   * it does fail there is nothing to see, which is why the card stays
   * underneath rather than being replaced.
   */
  function loadAnyway() {
    if (!current) return;
    frame.src = current.url;
    frame.hidden = false;
    el('brCard').hidden = true;
    el('brFallback').hidden = false;
  }

  // ------------------------------------------------------------ navigating

  async function go(input, { push = true } = {}) {
    const url = toUrl(input);
    if (!url) return;

    const mine = ++seq;
    addr.value = url;
    setBusy(true);
    clearBody();

    let info;
    try {
      const res = await fetch('/api/embed-check?url=' + encodeURIComponent(url));
      info = await res.json();
    } catch {
      info = { ok: false, error: 'The check could not be reached. Are you still online?' };
    }
    if (mine !== seq) return;   // a newer navigation already owns the view
    setBusy(false);

    if (push) pushHistory(info.ok ? info.url : url);

    if (!info.ok) {
      current = { url };
      renderError(info.error || 'That address could not be opened.');
      renderNav();
      return;
    }

    current = info;
    addr.value = info.url;

    // Only a positive yes goes straight into the frame. Unknown gets the card
    // with a way through it; a refusal gets the card and the reader view.
    if (info.embeddable === true) {
      frame.src = info.url;
      frame.hidden = false;
    } else {
      renderCard(info);
    }
    renderFound(info);
    renderNav();
  }

  function pushHistory(url) {
    history.splice(at + 1);
    history.push(url);
    at = history.length - 1;
  }

  // ------------------------------------------------------------- lifecycle

  function open(startUrl) {
    root.hidden = false;
    document.documentElement.classList.add('browsing');
    if (startUrl) {
      go(startUrl);
    } else {
      if (!current) el('brIntro').hidden = false;
      addr.focus();
    }
    renderNav();
  }

  function close() {
    root.hidden = true;
    document.documentElement.classList.remove('browsing');
    // A page left loaded keeps its audio playing over the film.
    frame.src = 'about:blank';
    frame.hidden = true;
  }

  const isOpen = () => !root.hidden;

  // ---------------------------------------------------------------- wiring

  el('brGo').addEventListener('click', () => go(addr.value));
  addr.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') go(addr.value);
  });
  addr.addEventListener('focus', () => addr.select());

  el('brBack').addEventListener('click', () => {
    if (at > 0) go(history[--at], { push: false });
  });
  el('brFwd').addEventListener('click', () => {
    if (at < history.length - 1) go(history[++at], { push: false });
  });
  el('brReload').addEventListener('click', () => {
    if (current) go(current.url, { push: false });
  });
  const openInTab = () => {
    if (current) window.open(current.url, '_blank', 'noopener,noreferrer');
  };
  el('brTab').addEventListener('click', openInTab);
  el('brCardTab').addEventListener('click', openInTab);
  el('brFallbackTab').addEventListener('click', openInTab);
  el('brAnyway').addEventListener('click', loadAnyway);
  el('brClose').addEventListener('click', close);

  for (const b of root.querySelectorAll('[data-goto]')) {
    b.addEventListener('click', () => go(b.dataset.goto));
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close();
  });

  return { open, close, isOpen };
}
