# Watch Together — Final Build Plan

Supersedes [PLAN.md](PLAN.md). Risk detail stays in [RISKS.md](RISKS.md).
Researched September 2026, verified against current provider docs.

---

## 1. What we are building

A room where friends in different places watch the same thing at the same moment and talk
while they do. One person opens a room, picks a source, shares a link. Everyone's playhead
is held to a shared clock within ~100ms. Voice always on, camera on if you want it.

Free to run. No installs. No accounts in v1.

---

## 2. Settled architecture

**Every client streams the video independently. The server broadcasts only a clock.**

```
        Cloudflare edge (video)
       /         |         \
   Aarav       Sita       Ravi      each streams its own copy
       \         |         /
        Durable Object (room)        broadcasts { anchorTime, anchorClock, playing }
                 |
        Cloudflare SFU (voice/cam)
```

Not the alternative — one host re-broadcasting to everyone — because that is capped by the
host's upload, double-compresses the picture, costs egress per viewer, and dies when the
host closes their laptop. Screen share stays available as a *source*, not as the architecture.

---

## 3. Source system

The sync engine must not know where video comes from. One interface, many adapters:

```ts
interface VideoSource {
  play(): void
  pause(): void
  seek(t: number): void
  getCurrentTime(): number
  getBufferedAhead(): number
  setPlaybackRate(r: number): void
  readonly supportsFineRate: boolean   // false => sync uses micro-seeks instead
  readonly kind: 'youtube' | 'file' | 'hls' | 'screen'
}
```

| Source | Adapter | Storage | Sync floor | Priority |
|---|---|---|---|---|
| **YouTube** | IFrame Player API | zero | ~250ms | **v1 default** |
| **Direct file URL** | `<video src>` | zero | ~100ms | **v1** |
| **Internet Archive** | direct-file adapter + search | zero | ~100ms | v1 (free public-domain library) |
| **HLS URL** (`.m3u8`) | hls.js | zero | ~100ms | v2 |
| **Jellyfin / Plex** | direct-file adapter | zero | ~100ms | v2 |
| **Upload** | R2 + presigned multipart | 10 GB cap | ~100ms | v3 |
| **Screen share** | WebRTC (Architecture B) | zero | exact | v2 — universal fallback |

**YouTube is the default, not upload.** It removes the upload wait, the 10 GB ceiling, the
codec validator, the bandwidth cost and the takedown exposure in one move, and its CDN
beats anything we can build.

**Screen share is the honest universal answer.** If a user can play it on their screen they
can share it. Quality is capped and it eats their upload, but it covers everything and puts
the sourcing decision with the user, which is where it belongs.

### Adapter notes that will cost time if missed

- **Cross-origin video is fine.** A plain `<video src="https://other.com/f.mp4">` plays
  without CORS headers — the same-origin policy restricts what *JavaScript* can read, not
  what HTML elements can render. **But hls.js fetches segments via XHR**, so `.m3u8` URLs
  *do* need `Access-Control-Allow-Origin`. Validate on paste, fail with a clear message.
- **YouTube's `getCurrentTime()` is jittery.** Values are not timestamped, so you cannot
  tell when they were sampled. `setPlaybackRate()` only accepts discrete rates and is
  advisory — it may not apply, so listen for `onPlaybackRateChange` rather than trusting the
  call. Hence `supportsFineRate: false` and a wider deadband for this adapter.
- **Jellyfin's "Copy Stream URL" appends the user's session API key.** Anyone holding that
  link can act as that user. Never ask people to paste it into a shared room. Accept
  Jellyfin only via a per-item token the user generates deliberately, and warn in the UI.
- **Internet Archive** direct files live at `https://archive.org/download/{id}/{file}`,
  permissive, free, and full of public-domain film. Worth a built-in search — it makes the
  product useful on day one with zero storage.

---

## 4. Stack

| Layer | Choice | Free allowance |
|---|---|---|
| Room state + clock | **Cloudflare Durable Objects** (WebSocket Hibernation) | 100k req/day |
| Voice + camera | **Cloudflare Realtime SFU** | 1,000 GB/mo egress |
| TURN | **Cloudflare TURN** | shares that 1,000 GB |
| Storage (v3) | **Cloudflare R2** | 10 GB, **unlimited egress** |
| Frontend | **Cloudflare Pages** | effectively unlimited |
| Player | hls.js + YouTube IFrame API | OSS |

One account, one dashboard, zero bill, traffic that never leaves Cloudflare's edge.

**Rejected:** LiveKit Cloud (50 GB hard cap — requests *fail*, 20× less than Cloudflare).
Oracle free VM (cut to 2 OCPU/12 GB in June 2026, ARM capacity permanently unavailable) —
keep as a fallback for self-hosted coturn if we outgrow the free tier.

**Rooms of ≤4 use P2P mesh instead of the SFU** — direct peer connections cost zero egress.
Auto-switch to the SFU at 5+. Roughly triples the effective free tier.

**Cost control:** cameras capped at 180p/150kbps *during playback* (see §7). Sync ping every
10s while converging, then 30s once locked — a 3× saving on the DO request budget for free.

---

## 5. Sync engine

### 5.1 Clock offset (NTP-style)

```
t0 = client now  ->  ping
t1 = server now (Durable Object)
t2 = client now  <-  pong

rtt    = t2 - t0
offset = t1 - (t0 + rtt / 2)
```

Keep 8 samples, **use the one with the lowest RTT** — not the average. Low-RTT samples are
the accurate ones. Gets every client onto a common clock within ~20ms.

### 5.2 The room broadcasts intent, not position

```json
{ "playing": true, "anchorTime": 1423.5, "anchorClock": 1757000000000, "rate": 1.0 }
```

```
target = anchorTime + (syncedNow() - anchorClock) / 1000
```

An anchor plus a clock, never a bare position — so a client that joins mid-gap still
computes the right answer with no polling.

### 5.3 Drift correction — rate, not seeking

```
drift = source.getCurrentTime() - target

|drift| <  0.05s  ->  nothing                      (deadband, kills oscillation)
|drift| <  1.0s   ->  rate = 1 - clamp(drift * 0.5, -0.07, 0.07)
|drift| >= 1.0s   ->  seek(target + 0.15)
```

The ±7% cap matters — past ~10% the pitch shift is audible. For `supportsFineRate: false`
adapters (YouTube), widen the deadband to ±400ms and micro-seek instead.

Read position with `requestVideoFrameCallback()`, not `currentTime` — the latter updates
about 4×/sec on some browsers, which is the same order as the error we're correcting.

Run the sync tick in a **Web Worker**. Background tabs throttle timers to 1/sec and drift
correction dies silently otherwise.

### 5.4 Ready-check gate

1. Room sends `PREPARE(target)`, state paused
2. Clients seek, wait for `readyState >= 3` and ≥5s buffered, reply `READY`
3. Room waits for all `READY` **or 8s**, then broadcasts `PLAY_AT(clock = now + 500ms, time = target)`
4. Everyone starts on the same future timestamp

Whoever times out gets pulled in by the drift corrector. Nobody holds the room hostage.

---

## 6. UI design direction

### 6.1 The thesis

**The best interface here disappears.** This is not a dashboard — it is a dark room with a
bright rectangle. Every pixel of chrome competes with the film.

But that is only true *during* the film. Before it, the job is the opposite: make a handful
of people in different cities feel like they arrived somewhere together. So the product has
**two temperatures**, and moving between them is the design.

### 6.2 Houselights — the signature

A real cinema dims. So does this.

Pressing play runs one orchestrated **900ms** transition: the plum foyer drains to warm
ink, chrome desaturates and recedes, the participant tiles shrink and slide to a rail at
the bottom edge, and the film comes up. It happens once per session, at the emotional peak,
and it is the only place we spend boldness. Everything else stays quiet.

Reversed on pause, faster (400ms) — the lights come up, faces grow back, chat returns.

`prefers-reduced-motion` collapses it to a 120ms cross-fade with no movement.

### 6.3 Tokens

Two grounds, one continuous dim between them.

```css
/* Foyer — lobby, warm, lit */
--foyer:        #2A1620;   /* deep plum, theater carpet */
--foyer-raised: #3A2029;
--brass:        #C9A227;   /* fixtures, primary action */

/* House — playing, lights down */
--ink:          #0B0908;   /* warm near-black, never #000 */
--ink-raised:   #16120F;

/* Shared */
--screen:       #F2EDE4;   /* warm white — projected light, all body text */
--muted:        #8A7D74;
--lamp:         #E8A33D;   /* presence, speaking, "live" */
--fault:        #C4564A;   /* desaturated — errors must not shout in the dark */
```

Warm near-black, not neutral. Projection bulbs are warm; a cold grey UI reads as a laptop,
not a room.

### 6.4 Type

| Role | Face | Use |
|---|---|---|
| Display | **Bricolage Grotesque** | Variable width + optical size. Titles, the room name. Heavy weight, tight tracking. |
| Body | **Instrument Sans** | Everything readable. |
| Data | **DM Mono** | Room codes, timestamps, sync offsets, bitrates. |

Room codes are always mono, always letter-spaced, always selectable — people read them
aloud over the phone.

### 6.5 The three modes

**Foyer** — people arriving, picking what to watch.

```
┌────────────────────────────────────────────────┐
│  TONIGHT                    room  K X 7 P 2 M  │
│                                                │
│   ┌──────────────────────┐   ┌──────────────┐  │
│   │                      │   │ ● Aarav      │  │
│   │  [ source preview ]  │   │ ● Sita       │  │
│   │                      │   │ ○ Ravi   ⋯   │  │
│   │  Nosferatu (1922)    │   ├──────────────┤  │
│   │  1h 34m · archive    │   │              │  │
│   └──────────────────────┘   │  chat        │  │
│                              │              │  │
│   ▸  Start — 2 of 3 ready    └──────────────┘  │
└────────────────────────────────────────────────┘
```

**House** — playing. Chrome gone.

```
┌────────────────────────────────────────────────┐
│                                                │
│                                                │
│             [ full-bleed film ]                │
│                                                │
│                                                │
│  ◐◐◐◐                                          │  ← presence rail
└────────────────────────────────────────────────┘
      controls fade in on pointer move only
```

**Interruption** — a thin band at the top edge, never a modal.

```
│  ⋯  Ravi is catching up                 2s behind  │
```

A modal would stop the film for everyone to report a problem affecting one person. The band
slides in, self-dismisses, and never takes focus.

### 6.6 Decisions that follow from the thesis

- **Chat during playback is ephemeral.** Messages rise from the bottom-left and fade after
  8s. A sidebar would shrink the film; an opaque panel would cover it. Full chat history
  stays one keypress away and is always there in the foyer.
- **Presence is rendered as light.** Tiles in the rail sit dim. When someone speaks, theirs
  warms to `--lamp` and grows ~8%. When someone's buffering, theirs dims further. You read
  the room peripherally, the way you do in an actual cinema.
- **Camera is the user's choice, quality is not.** Toggle whenever you like. The app caps
  the bitrate during playback and says so plainly when it does.
- **Sync status is one dot.** Lamp = locked, amber = catching up. Click it for the real
  offset in mono and a ±100ms nudge slider — the fix for the "we're in the same room and I
  can see the gap" complaint.
- **Reactions float over the film and vanish.** Cheap, high delight, no persistent chrome.
- **Controls auto-hide after 3s** of no pointer movement. Standard because it is right.

### 6.7 Quality floor

Responsive to 360px. Visible keyboard focus on every control. `prefers-reduced-motion`
respected throughout. Screen Wake Lock held during playback and upload. Hit targets ≥44px —
people use this on a couch, on a phone, in the dark.

---

## 7. Playback protection (the camera conflict)

WebRTC and the video stream compete for the same downlink, and **WebRTC wins** — its
congestion control adapts in milliseconds while an HTTP video fetch is passive. Left alone,
cameras starve the film, the buffer drains, and it presents as a sync bug.

| | Downlink, 4-person room |
|---|---|
| Film @ 1080p | 4.5 Mbps |
| 3 cameras @ 500 kbps | 1.5 Mbps → **6.0 Mbps, breaks a 10 Mbps line** |
| 3 cameras @ 150 kbps (180p) | 0.45 Mbps → **~5.0 Mbps, comfortable** |

**Rules:**
- Cap camera send to 180p/150kbps during playback via `RTCRtpSender.setParameters()`
- Buffer-aware throttle: under 10s buffered, drop further; under 5s, suspend incoming video
  and keep audio; restore on recovery
- Say it in the band: *"Cameras dimmed — protecting playback"*
- Ship a 720p master rather than 1080p. Halves everyone's requirement and nobody notices

---

## 8. Build order

| Phase | Ship | Why here |
|---|---|---|
| **1** | Sync core against one hardcoded YouTube video. Two tabs, ±150ms held. No styling. | The only genuinely risky part. If this doesn't feel right, nothing else matters. |
| **2** | Source adapters: YouTube + direct URL + Archive search. Room codes, join links, ready-check. | **A working product.** Friends can watch together. Zero storage, nothing to take down. |
| **3** | The UI — foyer, houselights, presence rail, ephemeral chat, reactions. | Design lands on a working core, not the reverse. |
| **4** | Voice, then camera. Mesh ≤4, SFU above. Ducking, push-to-talk, bitrate caps. | |
| **5** | Screen share adapter. Covers everything else. | |
| **6** | Upload to R2 + codec validator + resumable multipart. | Only if people actually ask for it. |

Phase 2 is the milestone that matters. Everything after is improvement, not survival.

---

## 9. Open decisions

- **Room lifetime** — die when empty, or persist for a week so the same friends reuse a code?
- **Playback control** — recommend anyone-can-pause, 2s debounce, every action attributed
  visibly (*"Sita paused"*), with host transfer so a disconnected host can't brick the room.
- **Mobile scope** — is phone a first-class viewing device or a join-the-voice companion?
  Changes the layout work in Phase 3 substantially.

---

## 10. Standing constraints

- Users bring their own sources. No shared catalogue, no discovery, no search across users,
  no public room list, `noindex` everywhere. Private rooms only.
- Anything uploaded expires — 7 days, or 24h after the room ends. Pin during active rooms so
  a lifecycle rule can never delete a file mid-playback.
- Room codes: 6+ chars from an unambiguous alphabet (no `0/O`, `1/l`). Lock-room, kick and
  mute available to whoever's hosting.
- Keep deployment portable. Everything sits on one Cloudflare account, which is convenient
  and concentrated — those are the same decision.
