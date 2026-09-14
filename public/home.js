const el = (id) => document.getElementById(id);
const notice = el('homeNotice');

function fail(msg) {
  notice.textContent = msg;
  notice.hidden = false;
}

el('createBtn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Opening…';
  try {
    const res = await fetch('/api/new-room');
    if (!res.ok) throw new Error();
    const { code } = await res.json();
    location.href = `/r/${code}`;
  } catch {
    btn.disabled = false;
    btn.textContent = 'Start a room';
    fail("Couldn't open a room. Check your connection and try again.");
  }
});

// The installed app's "Start a room" shortcut — press and hold the icon —
// lands here. Drop the flag first, so going back does not open another room.
if (new URLSearchParams(location.search).has('start')) {
  history.replaceState(null, '', '/');
  el('createBtn').click();
}

function join() {
  const code = el('joinCode').value.trim().toUpperCase();
  if (code.length < 4) {
    fail('Room codes are six characters — check the one you were sent.');
    el('joinCode').focus();
    return;
  }
  location.href = `/r/${code}`;
}

el('joinBtn').addEventListener('click', join);

el('joinCode').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') join();
});

// Codes are generated from an alphabet with no 0, 1, I, L or O precisely so
// they survive being read aloud. Anything outside it is a mistype, and there
// is no safe guess for what was meant — so drop it rather than substitute.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

el('joinCode').addEventListener('input', (e) => {
  notice.hidden = true;
  e.target.value = Array.from(e.target.value.toUpperCase())
    .filter((ch) => ALPHABET.includes(ch))
    .join('');
});

// ------------------------------------------------------------------ install

// Already opened from the home screen: nothing to offer.
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// iPadOS reports itself as a Mac; its touch screen gives it away.
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
let installPrompt = null;

const showInstall = (on) => (el('installBtn').hidden = !on);

function setHint(open) {
  el('installHint').hidden = !open;
  if (open) el('installHintClose').focus();
  else el('installBtn').focus({ preventScroll: true });
}

if (!standalone) {
  // Chrome, Edge and Android hand over their own install prompt once they judge
  // the site installable. Keep it for the button, rather than let the browser
  // raise a banner of its own at a moment it picks.
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    showInstall(true);
  });
  if (isIOS) showInstall(true);
}

addEventListener('appinstalled', () => {
  installPrompt = null;
  showInstall(false);
});

el('installBtn').addEventListener('click', async () => {
  if (!installPrompt) return setHint(true);
  const prompt = installPrompt;
  // A prompt can be shown once. Whatever they choose, the button goes; the
  // browser offers a fresh prompt later if it still makes sense.
  installPrompt = null;
  showInstall(false);
  prompt.prompt();
  await prompt.userChoice.catch(() => {});
});

el('installHintClose').addEventListener('click', () => setHint(false));
// A tap on the dimmed page around the sheet closes it, as does Escape.
el('installHint').addEventListener('click', (e) => {
  if (e.target === el('installHint')) setHint(false);
});
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !el('installHint').hidden) setHint(false);
});
