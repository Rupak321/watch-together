# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People in different places who want to watch the same film at the same moment and talk while it plays. Confirmed as three equal audiences, none primary:

- friends in different cities, mostly on phones, watching and chatting;
- long-distance couples, mostly on laptops or a TV's browser, on voice;
- families on whatever device each person has — phones, tablets, laptops.

A viewer might be holding a phone upright, turning it on its side, sitting at a desk, or on a sofa across the room from a TV.

## Product Purpose

Watch Together opens a private room, puts one film in front of everyone, and keeps every playhead on the same frame — with voice, camera, chat and reactions alongside. It is free and needs no account. Success is a watch night that feels like sitting in the same room: nobody fiddling with sync, nobody hunting for a control, nobody losing the picture to the interface.

## Positioning

Every client streams the film itself; the room broadcasts only a clock. Playheads stay within about a tenth of a second, corrected by playback rate rather than jumps, and a ready-check starts everyone on the same future timestamp. Voice and camera run peer to peer over the room's own connection. It runs on Cloudflare's free tier, with no media server.

## Operating Context

- A room is a six-character code or a `/r/CODE` link, shared however people already talk (WhatsApp, Messages).
- The first person in is the host and can restrict play, pause and seek to themselves; the room passes on when the host leaves.
- Sources: YouTube links, direct video files, Internet Archive search, desktop screen share, and an embedded browser the host can show to the room. A test clock exists for measuring sync.
- People join voice, turn cameras on, chat, react, change their own film and voice volume, and nudge their own sync.
- The site installs to a home screen and opens without browser bars; it has an offline page.
- Phones: portrait and landscape. iPhones cannot share their screen and only allow full screen through the system video player.

## Capabilities and Constraints

- **One screen, never scrolling (user requirement).** The room must fit the viewport on every device and orientation — no page scroll, no sideways scroll, no clipped or overflowing content. Long content scrolls inside its own region, never the page.
- **Everything must keep working.** Sync, voice, camera, chat, reactions, host permissions, sources, full screen, picture in picture, subtitles, the ambient glow, the More sheet's functions, install and offline. A redesign that breaks or hides a working feature has failed.
- Static HTML, CSS and JavaScript served by a Cloudflare Worker, no framework. The room's scripts find elements by id and class; those hooks must survive.
- Screen share is desktop only; mesh voice suits about four people.
- Scope of the current redesign: the room, the name screen, the offline page and the install sheet. The home page is out of scope.

## Brand Commitments

- The name is Watch Together.
- The look may change completely (confirmed): no palette, typeface, wordmark treatment or cinema metaphor is binding.

## Evidence on Hand

- README screenshots in `docs/screenshots/`, captured from two real clients with Big Buck Bunny (Blender Foundation, CC BY 3.0).
- Measured sync numbers in the README.
- No user counts, testimonials, reviews or press exist; none may be invented.

## Product Principles

1. **The picture comes first.** The interface serves the film and gets out of its way; nothing covers or shrinks it without a reason.
2. **One screen, every device.** Phone, laptop and TV are equal citizens, and each gets a complete room that never scrolls.
3. **Together is visible.** Who is here, who is talking, who is ready and whether everyone is in sync should read at a glance.
4. **Nothing breaks.** Every control works in every state and size, with no overflow, clipping or dead ends.

## Accessibility & Inclusion

The current room was reported as too dark and hard to read: text and controls need comfortable contrast. Touch targets must suit phones; everything must be reachable by keyboard.
