# Watch Together

Friends in different places watch the same thing at the same moment and talk while they do.

Plan: [FINAL-PLAN.md](FINAL-PLAN.md) · Risks: [RISKS.md](RISKS.md) · UI direction: [Houselights](https://claude.ai/code/artifact/5e97a447-f809-4089-b978-081a2a2603ee)

---

## Run it

```bash
npm install && npm run dev
```

Open `http://localhost:8787`, press **Start a room**, share the `/r/CODE` link.

---

## What works now

**Home page** — start a room or join with a code. Codes come from an alphabet with no
`0 1 I L O`, so they survive being read aloud.

**The room** at `/r/CODE` — two temperatures with a 900ms transition between them:

- **Foyer** (plum, lights up) — source picker, roster, chat, the Start button
- **House** (warm ink, lights down) — full-bleed film, presence rail, ephemeral chat over
  the picture, auto-hiding controls, floating reactions, sync dot with a ±300ms nudge

**Sources** — YouTube, any direct video URL, Internet Archive search, plus a synthetic
`test` clock. All behind one adapter interface, so `sync.js` never changes when one is added.

**Sync** — clock estimation, drift correction by playback rate, ready-check gate, live
roster with per-person lag, and an interruption band instead of a modal.

**Chat and reactions** — 50 messages kept for late joiners, join/leave notices, five fixed
reactions that float over the film and vanish.

**Voice and camera** — P2P mesh over the room's existing WebSocket, so there is no second
service. Mic toggle, push-to-talk on **T**, mute, speaking detection that lights the rail,
and ducking that dips the film to 25% while someone talks. Camera is optional per person;
its *quality* is not — 180p/150kbps during playback, relaxed to 360p when paused, and
throttled further as the film's buffer drains.

### Verified end to end

| | Result |
|---|---|
| Drift between two clients | **4 ms** (both ~45 ms behind server target, uniformly) |
| Recovery from a 600 ms knock | ~70 ms/s, inside ±150 ms in 7 s, **never seeked** |
| Recovery from a 2.4 s knock | hard seek fires, lands at +150 ms, nudges in |
| Deadband hold | ±50 ms, no correction applied |
| Real playback | Archive MP4, advanced 3.03 s in 3 s, drift −43 ms holding |
| Archive search | 20 results, correct part-1 file selection |

### Verified for voice

Signalling, the UI state machine and the failure paths: `/api/ice` returns STUN and
correctly reports `relay: false` with no credentials set; peer ids arrive; rail tiles are
created and kept (not rebuilt) so a `<video>` survives roster updates; a blocked microphone
produces an actionable message without half-flipping the button state.

### Still unproven

- **Real network latency.** RTT was ~1 ms because everything ran on localhost. The
  lowest-RTT sampling exists for networks with jitter, so the honest test is two machines
  on different connections.
- **An actual peer connection.** No microphone is available in the dev sandbox, so the
  offer/answer exchange, perfect-negotiation glare handling, ducking and speaking detection
  have never carried real audio. Two machines with microphones is the only way to know.

---

## Turning on TURN

Mesh voice works right now with public STUN, which connects most people. Roughly one in six
sits behind a symmetric NAT and needs a relay — and a relay always costs someone money, so
it needs credentials.

Create a Realtime TURN key in the Cloudflare dashboard, then:

```bash
npx wrangler secret put TURN_TOKEN_ID
npx wrangler secret put TURN_API_TOKEN
```

`/api/ice` picks them up with no client change. Cloudflare's free tier covers 1,000 GB a
month. If the credentials are absent or the call fails, the endpoint falls back to STUN
rather than taking voice down for everyone who doesn't need a relay.

**Above four people, mesh stops scaling** — each extra person costs everyone another
upstream. That is where the SFU has to take over, and it needs the same account.

---

## Layout

```
src/
  index.js         Worker — routing, room codes, /r/ pages, Archive proxy
  room.js          Durable Object — clock, ready-check, roster, chat
public/
  index.html       Home
  home.css home.js
  room.html        The room
  room.css room.js
  style.css        Tokens and base — the two grounds
  sync.js          SyncClock + DriftCorrector
  adapters.js      VideoSource implementations
  tick-worker.js   Worker-thread timer so background tabs keep correcting
```

### How the sync works

The room never broadcasts a position. It broadcasts an **anchor** (movie time) plus the
**wall clock** that anchor was true at, so any client computes its own target:

```
target = anchorTime + (syncedNow() - anchorClock) / 1000
```

A client joining mid-gap gets the right answer with no polling. `syncedNow()` comes from
NTP-style offset estimation that keeps the **lowest-RTT** sample of the last 8 rather than
averaging — a sample delayed by a congested hop carries that delay into its estimate, so
averaging drags the result toward whatever was slowest.

Correction is by playback rate, never by seeking, until drift passes one second.

### Adding a source

Implement the interface in `adapters.js`, register it in `createSource`. Nothing in
`sync.js` should need to change:

```
play() pause() seek(t) getCurrentTime() getBufferedAhead()
setPlaybackRate(r) isReady() destroy()
supportsFineRate: boolean
```

`supportsFineRate: false` (YouTube — discrete rates only, and the call is advisory) widens
the corrector's deadband to ±400 ms and switches it to micro-seeks.

---

## Things that will bite whoever touches this next

- **`new_sqlite_classes`, not `new_classes`** in `wrangler.jsonc`. SQLite-backed Durable
  Objects are the only kind on the free plan; the other spelling works locally and fails on
  deploy.
- **The ready-check timeout is a storage alarm**, not `setTimeout`. A hibernating Durable
  Object has no live timers.
- **`/r/CODE` requests `/room`, not `/room.html`.** The asset handler 301s `.html` to the
  extensionless path, and the browser following that redirect wipes the room code out of
  the address bar.
- **`[hidden] { display: none !important }` is load-bearing** in `style.css`. Author rules
  beat the UA stylesheet, so a plain `label { display: block }` silently defeats `hidden`.
- **Archive items are often reels, not films.** Many hold no complete copy — only
  `...-3of5.mp4`. `archivePick` takes the first part and reports the count so the UI can say
  so; sorting by size alone lands on an arbitrary middle reel.
- **`object-fit` defaults to `contain` for `<video>`** (unlike `<img>`), so 4:3 prints
  letterbox correctly with no extra CSS.

---

## Next

- **Two machines with microphones** — proves the peer connection, the latency figure and
  the ducking all at once. Everything else is guesswork until this happens.
- **Screen share** adapter for anything the other sources can't reach.
- **SFU** for rooms above four, on the same Cloudflare account as TURN.
- **HLS** via hls.js. Note `.m3u8` needs CORS on the origin, unlike a plain MP4.

Three decisions still open ([FINAL-PLAN.md](FINAL-PLAN.md) §9): mobile scope, room
lifetime, and who is allowed to pause.
