# Pre-mortem — what will go wrong with this flow

Companion to [PLAN.md](PLAN.md). Ordered by how likely it is to actually hurt you.

---

## TIER 1 — These will break v1 if you don't plan for them

### 1. The codec wall (biggest single risk)

Most movie files people have are `.mkv` containing **H.265/HEVC video** and **AC3 / E-AC3 / DTS 5.1 audio**. Browsers cannot play that:

| Format | Chrome | Safari | Firefox |
|---|---|---|---|
| MKV container | no | no | no |
| H.265 / HEVC | hardware-only, unreliable | yes (Apple silicon) | no |
| AC3 / DTS audio | **never** | no | **never** |
| H.264 + AAC in MP4 | yes | yes | yes |

Failure mode is nasty: the file uploads fine over 40 minutes, then plays as **video with
no sound**, or a black screen with sound. The host has no idea why.

**Fix — validate before upload, not after:**
- Probe the file in-browser with `mediainfo.js` or `ffprobe.wasm` (reads only the header,
  ~1 MB, instant) the moment they pick it
- If it isn't H.264 + AAC in MP4, block the upload and say exactly why
- Offer a one-line FFmpeg command they can copy, or a small helper app that remuxes
- Remuxing MKV→MP4 (`-c copy`) is **seconds**, not an hour, when the codecs are already
  H.264/AAC. Only a true re-encode is slow. Detect which case it is and say so.

This single check will save you more support pain than everything else combined.

### 2. Cameras during the movie will starve the movie

You want cameras optional during playback. The problem: **WebRTC and the video stream
compete for the same downlink, and WebRTC wins.**

WebRTC's congestion control (GCC) is aggressive and adapts in milliseconds. A progressive
HTTP video fetch is passive and just takes what's left. So cameras don't degrade — the
*movie* does. Buffer drains, playback stalls, drift builds, the sync engine hard-seeks, and
it looks like your sync is broken when the real cause is the camera feed.

Rough numbers for a 4-person room, per person:

| | Downlink needed |
|---|---|
| Movie @ 1080p | 4.5 Mbps |
| 3 cameras @ 500 kbps (normal call quality) | 1.5 Mbps |
| **Total** | **6.0 Mbps** — breaks a 10 Mbps line once overhead is counted |
| 3 cameras @ 150 kbps (180p, capped) | 0.45 Mbps |
| **Total (capped)** | **~5.0 Mbps** — comfortable |

**Fix:**
- Hard-cap camera bitrate during playback via `RTCRtpSender.setParameters()` —
  180p @ 150 kbps. Faces in small tiles; nobody can tell the difference
- **Buffer-aware auto-throttle:** watch `video.buffered.end(0) - video.currentTime`. Under
  10s of buffer, drop camera bitrate further. Under 5s, suspend incoming video tracks and
  keep audio. Restore when the buffer recovers
- Show it honestly: *"Cameras paused — protecting playback"*. Users accept it when they
  understand it
- Keep the choice theirs, as you said — just make the *quality* automatic

### 3. No ABR in v1 means the slow friend just suffers

If you ship a plain MP4 (which I recommended for speed), there is no 480p to fall back to.
One person on weak wifi will stall repeatedly, and your ready-check gate will time out on
them every single time.

**Fix, cheapest first:**
- Upload a **720p @ 2 Mbps** master, not 1080p. Halves everyone's requirement, and on a
  laptop screen with friends talking over it nobody notices
- Detect the chronic laggard and offer *"You're falling behind — watch in low quality?"*
  pointing at a second, smaller file
- Real answer is the HLS ladder in Phase 5

### 4. Upload fragility

A 40-minute upload has 40 minutes to fail. Tab closed, laptop slept, wifi dropped, phone
locked (iOS Safari suspends background uploads within ~30s).

**Fix:**
- Multipart + persist the upload ID and completed part list to **IndexedDB**. On return,
  offer *"Resume upload — 62% done"*
- Request a **Screen Wake Lock** during upload
- Warn on `beforeunload`
- Never let a failed part restart the whole file

---

## TIER 2 — Won't break, but will make it feel bad

### 5. Perfect sync is not achievable, and someone will notice

±80–150ms is the realistic floor. Different devices, decoders and frame timings mean you
can never be frame-exact. Two friends in the **same physical room** on two laptops will see
the offset and report it as a bug.

Don't fight it. Set expectations in the UI ("in sync" indicator, not a millisecond
counter), and add a manual **±100ms nudge** so anyone bothered can hand-tune their own
device. Cheap to build, kills the complaint.

### 6. Audio chaos — and cameras make it worse

Three separate problems stacking:
- **Echo:** speaker users' mics pick up the movie and send it back. WebRTC's echo
  cancellation only cancels audio *it* rendered, not your `<video>` element's output
- **Ducking:** without it, movie audio buries voices and nobody can talk
- **AEC damage:** aggressive noise suppression can chew up movie audio bleeding through

**Fix:** headphone prompt on join, push-to-talk toggle, Web Audio ducking (dip movie to
25% over 120ms), and separate movie/voice volume sliders.

### 7. Playback control fights

If everyone can pause, someone's cat sits on the spacebar at the climax. If only the host
can, the host leaves for snacks and the room is frozen.

**Fix:** default to *anyone can pause*, but debounce (ignore a second command within 2s),
attribute every action visibly (*"Sita paused"*), and support **host transfer** so a
disconnected host doesn't brick the room.

### 8. CPU and heat

Decoding 1080p + encoding your camera + decoding 3 more cameras is a genuine load. Laptops
thermal-throttle, dropped frames turn into drift, phones get hot and the OS starts killing
things. This is the *second* reason to cap camera resolution.

### 9. Mobile and iOS specifics

- iOS needs `playsinline` or it force-fullscreens
- Autoplay is blocked without a user gesture — your `PLAY_AT` will silently no-op unless
  you prime the element with a muted play/pause on join
- Starting `getUserMedia` on iOS can interrupt or duck other audio playback
- Background tabs throttle timers to 1/sec, killing drift correction — run the sync tick in
  a Web Worker

**Test on a real iPhone in week one**, not at the end.

---

## TIER 3 — Will bite you as it grows

### 10. Storage is the first hard wall

10 GB is ~2 movies at 4 GB, or ~5 at 720p. Two friends both wanting to host at once = full.

**Fix:** one active movie per user, auto-expire 7 days after upload or 24h after the room
ends, **pin during active rooms** so a lifecycle rule can never delete a file mid-playback.
Show *"Expires in 6 days"* plainly. Dedupe by file hash so the same movie isn't stored twice.

### 11. Durable Objects request budget

Free tier is 100k requests/day, and each inbound WebSocket message counts. A 10-second
sync ping is 360 requests/hour/client — a 2 hr movie with 5 people is ~3,600. That's fine
for friends (~27 movie nights/day) but it's the quota you'll hit first if it spreads.

**Fix:** ping every 10s only while converging, then back off to 30s once the clock offset
is stable. Offset drift is slow; you lose nothing. That's a 3× saving for free.

### 12. Anyone with the link is in the room

No auth means room codes are the only barrier.

**Fix:** 6+ characters from an unambiguous alphabet (no `0/O`, `1/l`) — that's billions of
combinations, not guessable. Add a *lock room* button once everyone's arrived, plus kick
and mute controls for whoever's hosting.

### 13. The legal risk is concentrated, and it's an availability risk

One DMCA notice can terminate the Cloudflare account, which takes storage, SFU, signaling
and hosting down together — because you put everything in one place. The convenience and
the fragility are the same decision.

**Fix:**
- Users upload their own files. No shared catalogue, no discovery, no search, no public
  room list, `noindex` everywhere. Private rooms only
- Short expiry means nothing accumulates
- Have a takedown contact and honour it immediately
- Keep the transcode/upload scripts portable so you *can* move providers under pressure

---

## Recommended settings, given all of the above

| Setting | Default | Why |
|---|---|---|
| Master file | 720p H.264 + AAC, MP4, ~2 Mbps | Plays everywhere, halves bandwidth |
| Camera during movie | **user's choice, on = 180p @ 150 kbps** | Their call, capped so it can't starve playback |
| Camera in lobby | 360p @ 500 kbps | Nothing competing yet |
| Mic | on, with push-to-talk available | |
| Sync ping | 10s converging → 30s locked | Saves DO quota |
| Ready-check timeout | 8s | |
| Playback control | anyone, debounced, attributed | |
| Storage expiry | 7 days, pinned during rooms | |
