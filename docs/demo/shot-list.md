# Demo filming plan (Agent E)

Two clips, same camera, same spot, same light. **Do not move the camera between them or after
calibrating**: the bin regions are stored as fractions of the frame.

## Setup

- Camera: phone on a tripod or taped down, landscape, 1080p 30 fps, **locked exposure/focus**.
  Frame all three bins with their openings clearly visible, and some space above them where items fall.
- Order of bins left to right does not matter; `calibrate` asks for each one by name.
- Thrower: one person at a time, stand to the side or behind the bins so the item is not hidden
  by your body at the moment it drops. Release the item above the opening; don't push it in by hand.
- Items (catalog IDs in brackets): Shake Shack clear cup with lid + straw (`item_shakeshack_cup`),
  Shake Shack burger box (`item_shakeshack_box`), sauce cup (`item_sauce_cup`), Goldfish bag
  (`item_goldfish_bag`), Biscoff wrapper (`item_biscoff_wrapper`), Quaker Chewy wrapper
  (`item_granola_wrapper`). Also bring **a plain clear cup with no logo** (`item_generic_cup`) and
  **one thing that is not in the catalog** (e.g. a receipt balled up, or a paper napkin).

## Clip 1: enrollment (`enroll.mp4`, ~1 min)

Hold each catalog item in front of the bins, at the height where you will drop it, for 6 seconds,
turning it slowly (front, side, back, crumpled if it crumples). Say its name out loud at the start so
the segments are easy to find. Order: Shake Shack cup, Shake Shack box, sauce cup, Goldfish bag,
Biscoff, Quaker, plain clear cup. **Do not enroll the not-in-catalog item.**

Then write `segments.json` with the start/end second of each item, e.g.
`[{"catalog_item_id": "item_shakeshack_cup", "start_s": 1, "end_s": 7}, ...]`.

## Clip 2: demo (`demo.mp4`, ~3 min, one take)

Leave 5+ seconds between throws. Numbers below use the demo profile in `demo-site.json`
(alert when an item's correct-sorting % is below 60 after 3 assessed events; emptying request at
80% estimated fullness; trash starts at 93.5 of 120 L). These are provisional values.

| # | Action | Expected on the dashboard |
|---|---|---|
| 1 | Biscoff wrapper → **trash** | correct; trash ~93.6 L |
| 2 | Shake Shack cup → **trash** | **incorrect** (cup belongs in recycling); trash ~94.3 L |
| 3 | Shake Shack cup → **recycling** | correct |
| 4 | Shake Shack cup → **trash** | incorrect; cup is 1 of 3 correct = 33% < 60% → **recommendation to Shake Shack manager** |
| 5 | Hold the sauce cup over the **compost** opening for 3 s, then walk away with it | **nothing** (held near ≠ thrown) |
| 6 | Shake Shack burger box → **trash** | incorrect (box is compost); trash ~96.2 L = 80% → **emptying request** |
| 7 | Plain clear cup → **recycling** | item identified, origin uncertain → **review queue** (if the Shake Shack cup is its runner-up match) |
| 8 | Not-in-catalog item → **compost** | **unassessable** (should score below the calibrated threshold) |
| 9 | Goldfish bag → **trash**, then Quaker wrapper → **trash** | correct, correct |

Steps 4 and 6 need the manager replies: in mock mode, type them in the dashboard's
"reply as manager (mocked)" box ("put a sign up at the pickup counter", "emptied it").

## After filming (commands from `worker/`)

```bash
uv run recyclone-worker calibrate --clip demo.mp4                     # draw the 3 bin openings -> demo-site.json
uv run recyclone-worker enroll --clip enroll.mp4 --segments segments.json --out state/gallery.npz
uv run recyclone-worker suggest-thresholds --gallery state/gallery.npz   # put the value in demo-site.json demo profile
uv run recyclone-worker label --clip demo.mp4 --clip-id clip_demo_v1     # hand labels -> contracts/fixtures/demo-events.jsonl
uv run recyclone-worker run --clip demo.mp4 --clip-id clip_demo_v1 --gallery state/gallery.npz --dry-run --no-stream --events-out state/run.jsonl
uv run recyclone-worker evaluate --labels ../contracts/fixtures/demo-events.jsonl --predicted state/run.jsonl
# if YOLO misses wrappers, try the motion tracker:
uv run recyclone-worker run ... --tracker motion
```

Rehearse the full chain locally without the dashboard:

```bash
WORKER_INGEST_TOKEN=rehearsal pnpm --filter @recyclone/rehearsal start   # real core, in memory, demo profile
API_BASE_URL=http://127.0.0.1:3000 WORKER_INGEST_TOKEN=rehearsal uv run recyclone-worker run --clip demo.mp4 --clip-id clip_demo_v1 --gallery state/gallery.npz --realtime
```

For step 7 to reach the review queue, `business_confidence_threshold` must be **above** the plain
cup's Shake Shack runner-up score (visible in the `run --dry-run` output under `business.confidence`);
otherwise core attributes it to Shake Shack directly.

If the numbers in the table don't line up (e.g. trash fills too early), adjust `initial_volume_l` or
the demo thresholds in `demo-site.json` rather than re-filming.
