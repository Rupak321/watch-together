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
