# Demo video script (~2:45)

The demo is a **screen recording of the real system processing our staged footage**, edited for
time. It is not a montage of raw clips. Every event on screen must come from the worker and core
as they ran. Cut dead time; never add, reorder, or fake events. Keep the uncut master recording.

Filming plan for the footage itself: `shot-list.md`. This script needs three changes to it:

- **Unknown item:** a receipt or napkin is in the catalog. Use something outside it (rubber glove,
  small toy) and check in a `--dry-run` that it comes out unassessable.
- **Clip 3, "after" (~40 s):** 3–4 Shake Shack cups → **recycling**, run *after* the manager's reply
  so they count as the after period.
- **No-reply follow-up:** don't answer the cup recommendation for 2 minutes, so the follow-up text
  appears; then reply. No extra footage needed.

## Setup for the recording

| What | Setting |
|---|---|
| Dashboard | Run locally next to the worker: `NEXT_PUBLIC_DATA_SOURCE=api`, `NEXT_PUBLIC_WORKER_URL=http://localhost:8765`. Leave `NEXT_PUBLIC_DEMO_TOOLS` off if texts are live; turn it on only if texts are mocked (for the reply box). |
| Core | Demo profile (3 drops to alert, 60% goal, 80% full, 2-minute follow-up). `POST /api/demo/reset` before every take. |
| Texts | `MESSENGER_MODE=live` with a real phone per manager, if Photon works. Otherwise mock, and say so on screen. |
| Screen | 1920×1080 browser window, zoom 100%, nothing else open. Record with QuickTime or OBS. |
| Phone | Mirror the manager's iPhone with QuickTime (File → New Movie Recording → choose the iPhone), recorded at the same time. |
| Worker | `uv run recyclone-worker run --clip demo.mp4 --clip-id clip_demo_v1 --realtime`, then `--clip after.mp4 --clip-id clip_after_v1` for Clip 3. |

## Shots

Times are targets for the edited video. "Screen" = dashboard recording; "Phone" = mirrored phone.

| # | Time | On screen | Caption / voiceover |
|---|---|---|---|
| 1 | 0:00–0:08 | Raw footage: someone drops a clear cup into **trash**. | "A recyclable cup. In the trash. Again." |
| 2 | 0:08–0:20 | Title card over a still of the bins. | "Shared bins at food courts get sorted wrong all day. Nobody knows which mistakes repeat, or whose packaging it is. The cameras are already there." |
| 3 | 0:20–0:28 | Screen: **Overview**, empty. | "Caught in 4K watches the bins through cameras you already have." |
| 4 | 0:28–0:45 | Screen: **Cameras**. Annotated stream: Biscoff wrapper → trash (right bin), then Shake Shack cup → trash. Headline turns clay: "…went into Trash. Here, this belongs in Recycling." | "It spots each item, which bin it went into, and whether that's the right bin under local rules." |
| 5 | 0:45–0:52 | Screen: Cameras. Someone holds the sauce cup over compost, then walks off. Nothing is counted. | "Holding something near a bin isn't throwing it." |
| 6 | 0:52–1:05 | Screen: cup → recycling, then cup → trash again. Cut to the cup's **item page**: 33%, below the 60% goal, 3 drops. | "One cup going in the wrong bin isn't a pattern. Three drops at 33% is." |
| 7 | 1:05–1:20 | Phone: the recommendation text arrives (to Shake Shack's manager, or the area manager if the logo wasn't read). Split screen with **Messages**. | "So it texts the manager with a concrete fix: a sign where customers pick up the cup." |
| 8 | 1:20–1:30 | Jump cut, on-screen timer "2 min later". Phone: follow-up text arrives. | "No answer? It follows up once. (Shortened for the demo; normally 24 hours.)" |
| 9 | 1:30–1:42 | Phone: manager types "Put a sign up at the pickup counter." Messages shows **Action confirmed**. | "The manager replies by text. No app, no login." |
| 10 | 1:42–2:00 | Screen: burger box → trash. Cut to **Bins**: trash ~80% with its illustration; the other bins unchanged. Phone: emptying request to the area manager; reply "emptied it". Trash drops to near 0; recycling and compost stay. | "It estimates how full each bin is and asks for it to be emptied. Only that bin resets." |
| 11 | 2:00–2:10 | Screen: the unknown item → compost. Headline: "Couldn't tell what that was". | "If it can't tell what something is, it says so. Unknowns never count as mistakes." |
| 12 | 2:10–2:30 | Screen: Clip 3 on Cameras, cups → recycling. Cut to the item page: before and after scores (e.g. 33% → 100%) with their drop counts. | "Then it keeps watching, so you can see what changed after the sign went up." Caption: **"Staged follow-up clip, not a real-world result."** |
| 13 | 2:30–2:38 | Screen: **Overview**, now full: restaurants, room to improve, changes after a text. | "Every bin, every item, every text, in one place." |
| 14 | 2:38–2:45 | End card (below). | — |

Optional, only if it happens naturally in a take: a drop whose source restaurant is unclear lands
in the **Review queue**. Show it for 5 s after shot 11: "When it isn't sure whose it is, a person
decides." Don't stage it for the video; since 16 Oct it rarely triggers (see `worker/AGENTS.md`).

## End card: what's real

Fill this in from what the recording actually used:

> Footage staged by our team and processed by the model as it played.
> Timers shortened for the demo. Texts: [sent through Photon to real phones / mocked].
> Bin images: [Grok Imagine / placeholder]. Shake Shack packaging is used as a real-world example;
> Shake Shack is not a partner.

## Before publishing

- Watch the edit next to the uncut master: every event in the edit happened in the run.
- Every mocked service is labeled on screen or on the end card.
- Timings that were shortened are said out loud or captioned (shot 8).
- Shot 12 carries the "staged, not a real-world result" caption.
