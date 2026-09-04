# Watch-Together Platform — Research & Build Plan

Researched September 2026. Numbers verified against current provider docs (sources at bottom).

---

## 0. The one thing that changes the whole design

**Do not stream the movie from one source to everyone.** That is the instinct behind the
Google Drive idea, and it is the reason it will feel laggy.

There are two possible architectures. Only one of them is fast and free.

### Architecture A — Sync-playback (CORRECT)

Every client downloads the movie **independently** from a CDN and plays its own copy.
A tiny server only broadcasts a **clock**: `{ movieTimeSec, wallClockMs, isPlaying }`.
Clients nudge their own `playbackRate` to stay locked to that clock.

- Video quality: full source quality, ABR-adaptive per person
- Bandwidth: served by CDN, scales flat
- Sync accuracy achievable: **±80–150 ms** (imperceptible)
- Data over the realtime channel: ~200 bytes/sec. Nothing.

### Architecture B — Host broadcasts (WRONG for this)

One person plays the file and re-encodes it to everyone through an SFU. Most people build
this first because it is "obviously" synced.

- Quality capped at ~1080p30 @ 2–4 Mbps, compressed twice, text goes mushy
- Bound by the host's *upload* speed — on home internet that is the killer
- Every extra viewer costs real egress
- Host closes laptop → movie stops for everyone

**Decision: build A.** Keep B as a "screen share" button for trailers or anything you
cannot host. This is also how Teleparty, Syncplay and OpenTogetherTube all work.

---

## 1. Verdict on Google Drive as the origin

Your concept says "put the movie in Google Drive and stream from there." I researched this
specifically. It works for a demo with 3 friends and then breaks.

| Problem | Detail |
|---|---|
| **Per-file download lockout** | When many users pull the same shared file, Drive locks it for ~24h with "Download quota exceeded." This is the killer — it triggers on exactly the traffic pattern you want. |
| **No adaptive bitrate** | Drive serves one progressive MP4. There is no HLS/DASH ladder. A friend on 3G buffers forever with no 480p to fall back to — your "buffering problem," structurally unsolvable on Drive. |
| **Seek is slow** | `files.get?alt=media` honors `Range`, but every seek is a fresh authenticated round-trip through Drive's redirect chain. Expect 1–3s to scrub. |
| **API egress cap** | 1 TB/day per project. Fine in isolation, but the per-file lockout hits long before this. |
| **No edge cache** | You hit Google's origin, not a CDN POP near your users. |
| **ToS** | Using Drive as a public content-delivery backend violates its abuse policy. Account termination risk. |

**Replace it with Cloudflare R2.** R2 has **zero egress fees at every tier** — not "10 GB
then paid," genuinely unlimited free bandwidth out. The only free-tier limits are 10 GB
storage and operation counts. For serving video this is the best free deal that exists.

Keep Drive as the **ingest/staging** layer if you like it: upload there, transcode, push to R2.

---

## 2. Legal line — read once, then move on

Hosting films you do not hold distribution rights to is copyright infringement, and
practically it means your Cloudflare account gets terminated on the first DMCA notice,
taking the whole site with it. Build so **users supply their own file** — upload their own
video, paste a URL, or screen-share. Same product, legal, and it is how OpenTogetherTube
survives. Everything below assumes that model.

---

## 3. The stack — all free, mostly one account

| Layer | Choice | Free allowance | Why |
|---|---|---|---|
| **Video storage + CDN** | **Cloudflare R2** | 10 GB storage, **unlimited egress**, 10M Class-B ops/mo | Zero egress is the whole ballgame |
| **Transcode to HLS** | **FFmpeg on your own PC** | free | Batch job, no server needed |
| **Room state + sync clock** | **Cloudflare Durable Objects** (WebSocket Hibernation) | 100k req/day, 313k GB-s/day | One DO instance = one room. Stateful, edge-local, hibernates between messages so the quota lasts. |
| **Video/voice call** | **Cloudflare Realtime SFU** | **1,000 GB/mo egress** | ~370 hrs of 4-person video free (math in §5) |
| **TURN (NAT fallback)** | **Cloudflare TURN** | shares that 1,000 GB | Needed for the ~15–20% behind symmetric NAT |
| **Frontend** | **Cloudflare Pages** or Vercel | effectively unlimited | Next.js or plain Vite both fine |
| **Auth + user DB** | **Supabase free** | 500 MB DB, 50k MAU | Or skip auth in v1 — room codes only |
| **Player** | **hls.js** | OSS | Handles ABR, buffering, `playbackRate` |

SFU + TURN + storage + signaling + hosting all on Cloudflare means one dashboard, one bill
(zero), and traffic that never leaves their edge network. That is also a latency win.

**Rejected after research:**

- *LiveKit Cloud* — free tier is 5,000 min / 50 GB / **hard cap, requests just fail**. Cloudflare gives 20× the bandwidth.
- *Oracle Cloud free VM* — was 4 OCPU/24 GB, **cut to 2 OCPU/12 GB in June 2026**, and ARM capacity is constantly "out of host capacity." Still has 10 TB/mo egress, so keep it as a **backup** for self-hosted coturn + LiveKit if you outgrow Cloudflare.
- *meet.jit.si* — cannot embed cleanly alongside a synced player, no quality control, their limits.

---

## 4. The sync protocol — this is the "no lag" part, build it carefully

Naive implementations do `socket.on('seek', t => video.currentTime = t)`. That stutters on
every correction and is why most watch-party apps feel bad. Do this instead.

### 4.1 Clock offset estimation (NTP-style)

On connect, then every 10s:

```
t0 = client now
-> ping
t1 = server now (from the Durable Object)
<- pong
t2 = client now

rtt    = t2 - t0
offset = t1 - (t0 + rtt / 2)
```

Keep the **8 most recent samples and take the one with the lowest RTT** — not the average.
Low-RTT samples are the accurate ones. Now every client shares a common clock to ~±20 ms.

### 4.2 Server broadcasts intent, not position

The room Durable Object holds authoritative state:

```json
{
  "playing": true,
  "anchorMovieTime": 1423.5,
  "anchorWallClock": 1757000000000,
  "rate": 1.0
}
```

Target position at any moment:

```
target = anchorMovieTime + (syncedNow() - anchorWallClock) / 1000
```

Because it is an anchor plus a clock rather than a position, a client that joins during a
message gap still computes the right answer. No polling.

### 4.3 Drift correction via playbackRate, not seeking

```
drift = video.currentTime - target

|drift| <  0.05s  ->  do nothing            (deadband, stops oscillation)
|drift| <  1.0s   ->  playbackRate = 1 - clamp(drift * 0.5, -0.07, 0.07)
                      // silently catches up over a few seconds, inaudible
|drift| >= 1.0s   ->  hard seek to target + 0.15s, then resume
```

The ±7% rate cap matters — beyond ~10% the audio pitch shift becomes audible. This single
technique is what separates a good watch party from a bad one.

### 4.4 Ready-check gate — kills "everyone waits for the one buffering guy"

Before any play or seek actually starts:

1. Server sends `PREPARE(target)`, state set to paused
2. Each client seeks, waits for `readyState >= 3` (HAVE_FUTURE_DATA) with ≥5s buffered
3. Each client replies `READY`
4. Server waits for all READY **or an 8s timeout**, then broadcasts
   `PLAY_AT(wallClock = now + 500ms, movieTime = target)`
5. Everyone starts on the same future timestamp

Anyone who times out gets pulled in by the drift corrector once they catch up, instead of
holding the room hostage. Show a "Ravi is buffering…" chip so it is socially obvious.

### 4.5 Late joiner

Gets current state and runs a ready-check on themselves only. Zero disruption to others.

---

## 5. Free-tier math — does this actually hold up?

### Storage (R2, 10 GB)

- 1080p H.264 @ 4.5 Mbps → 2 hr movie ≈ **4.0 GB**
- 720p H.265 @ 1.8 Mbps → 2 hr movie ≈ **1.6 GB**
- Full 3-rendition ladder (1080/720/480) of one 2 hr film ≈ **6.4 GB**

So 10 GB is **one film with a full ABR ladder**, or ~5 films at 720p single-rendition.

Mitigation: treat R2 as a *cache*, not a library. Users upload, watch, auto-delete after
72h via an R2 lifecycle rule. Rotation makes 10 GB feel infinite for a small group.

### Bandwidth (R2 egress): unlimited and free

The real constraint is Class-B operations (10M/month). With **6-second HLS segments**, a
2 hr movie is 1,200 segments, so each viewer pulls ~1,200 GETs. That is **~8,300
movie-views/month free**. At 10s segments it is ~14,000. You will never hit this.

> Segment-length note: 6s is Apple's recommended HLS length and the right call. Short
> segments (2s) are a *live* low-latency technique — for VOD they just multiply your op
> count and give the ABR algorithm less runway. You are syncing a *file*, not a live
> stream, so segment length does not affect your sync accuracy at all.

### Video call (Cloudflare SFU, 1,000 GB/mo)

| Mode | Per-person down | 4-person room | Free hours/month |
|---|---|---|---|
| Video 360p @ 500 kbps | 1.5 Mbps | 6 Mbps ≈ 2.7 GB/hr | **~370 hrs** |
| Audio only @ 40 kbps | 120 kbps | 0.5 Mbps ≈ 0.2 GB/hr | **~4,500 hrs** |

**Design decision: default to audio-only once the movie starts.** Nobody watches faces
during a film, it saves 13× the bandwidth, and it removes the biggest CPU load. Cameras on
in the lobby, cameras auto-off on play, manual toggle always available. This is both the
better product and the cheaper one.

### Extra free trick: mesh below 5 people

For rooms of ≤4, use **P2P mesh** WebRTC instead of the SFU — direct peer connections cost
you **zero** Cloudflare egress (only TURN-relayed users cost anything). Auto-switch to the
SFU at 5+. Mesh at 4 = 3 up and 3 down each, fine for audio and acceptable for 360p video.
This roughly triples your effective free tier.

---

## 6. The audio problem nobody plans for

Movie audio and the voice call fight each other. Three separate issues:

1. **Echo / feedback.** A person on speakers has their mic pick up the movie, sends it to
   everyone, and they hear the movie twice, offset. WebRTC's AEC only cancels audio *it*
   rendered — not your `<video>` element's output.
   **Fix:** route movie audio through the same `AudioContext`, hard-recommend headphones in
   the UI, and ship a **push-to-talk** toggle plus an aggressive noise gate for speaker users.

2. **Ducking.** When someone talks, movie volume should dip.
   **Fix:** a Web Audio `GainNode` on the movie driven by an `AnalyserNode` on the remote
   voice streams. Dip to 25% over 120 ms, restore over 600 ms. Feels magical, ~30 lines.

3. **Mixing.** Separate sliders for *movie volume* and *voice volume*. Obvious, and almost
   every clone forgets it.

---

## 7. Transcode pipeline

Local FFmpeg → 3-rendition HLS → upload to R2. One command per rendition:

```bash
ffmpeg -i input.mkv -vf scale=-2:720 -c:v libx264 -profile:v main -crf 23 -preset fast -c:a aac -b:a 128k -ac 2 -force_key_frames "expr:gte(t,n_forced*6)" -hls_time 6 -hls_playlist_type vod -hls_segment_type mpegts -hls_segment_filename "720p/seg_%04d.ts" 720p/index.m3u8
```

Then write a master playlist listing 480p/720p/1080p and `rclone copy` the folder to R2.

- **Force keyframes at segment boundaries** (the `-force_key_frames` above) or ABR
  switching and seeking both get sloppy.
- **Burn nothing in.** Serve subtitles as WebVTT sidecar tracks — smaller, toggleable, and
  each viewer picks their own language.
- Set R2 CORS to allow your origin, and cache headers `public, max-age=31536000, immutable`
  on segments — they never change.
- Long term, move this into a Cloudflare Queue + container worker so users upload through
  the site. v1 can be you running a script.

---

## 8. Build order

**Phase 1 — Sync core (hardest part, do it first).** Local `<video>` + a Durable Object
room + the clock protocol from §4. Two browser tabs, one file, prove you can hold ±150 ms.
No auth, no calls, no styling. If this does not feel right, nothing else matters.

**Phase 2 — Real content.** FFmpeg ladder → R2 → hls.js. Add the ready-check gate. Test
with a friend on a genuinely bad connection — that is the only test that counts.

**Phase 3 — Voice.** P2P mesh WebRTC, audio only, TURN configured. Ducking and
push-to-talk. Cloudflare TURN credentials.

**Phase 4 — Rooms and polish.** Room codes, join links, presence list, chat, "X is
buffering" indicators, host controls (who may pause?), emoji reactions floating over video.

**Phase 5 — Scale valves.** Auto-switch mesh→SFU at 5 people. Camera support. R2 lifecycle
auto-delete. User upload flow.

---

## 9. Traps to avoid

- **Autoplay policy.** Browsers block programmatic `play()` without a user gesture, so your
  `PLAY_AT` silently fails. Require one "Join & Unmute" click on entry that primes the
  video element with a muted play/pause.
- **DRM content is impossible.** Netflix/Prime/Disney+ are Widevine-encrypted — you cannot
  sync or capture them, only screen-share, and even that gets blacked out. Do not promise it.
- **`currentTime` is imprecise.** It updates ~4×/sec in some browsers. Use
  `requestVideoFrameCallback()` for accurate position reads — a real accuracy win, well
  supported now.
- **Background-tab throttling.** Timers drop to 1/sec, so drift correction dies. Run the
  sync tick in a Web Worker, or accept a resync on `visibilitychange`.
- **Safari/iOS.** Needs `playsinline`, is fussy about `playbackRate` ranges, and prefers
  native HLS — which is fine, since you are on HLS.
- **Do not build accounts in v1.** Room code plus display name. Auth is the number-one way
  side projects die.

---

## Sources

- [Cloudflare R2 — zero egress](https://www.cloudflare.com/products/r2/)
- [Cloudflare Realtime SFU limits](https://developers.cloudflare.com/realtime/sfu/limits/)
- [Cloudflare TURN/SFU product](https://www.cloudflare.com/products/turn-sfu/)
- [Durable Objects WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets)
- [Workers / Durable Objects pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Google Drive API limits](https://developers.google.com/workspace/drive/api/guides/limits)
- [Drive "download quota exceeded" reports](https://support.google.com/drive/thread/258523607/download-quota-exceeded?hl=en)
- [LiveKit quotas and limits](https://docs.livekit.io/deploy/admin/quotas-and-limits/)
- [Oracle free tier cut to 2 OCPU / 12 GB, June 2026](https://www.infoq.com/news/2026/07/oracle-cloud-free-tier-limits/)
- [HLS latency and segment duration](https://www.wowza.com/blog/hls-latency-sucks-but-heres-how-to-fix-it)
- [Watch-together open source projects](https://github.com/topics/watch-together)

---

See [RISKS.md](RISKS.md) for the pre-mortem: failure modes in this flow, ordered by likelihood.
