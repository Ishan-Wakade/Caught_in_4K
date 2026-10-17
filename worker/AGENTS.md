# worker/ — CV worker (owner: Agent E)

Read the root `AGENTS.md` and `contracts/README.md` first. Only E edits this folder.

## Job

Turn camera footage into one `DisposalEvent` per item that actually entered a bin, posted to `POST /api/events`. Run live on the staged demo footage. Keep a path to a future live camera adapter.

Python, running on a laptop (not Vercel).

## Pipeline

1. Load the site configuration (`contracts/fixtures/demo-site.json`): cameras, and for each camera the image region of every bin opening.
2. Read frames from a source adapter: `RecordedClipSource` now, with a `LiveCameraSource` interface left in place for later.
3. Detect and track visible items across frames.
4. Identify catalog candidates using visual appearance plus visible logos/text matched against the area manager's catalog reference photos. Do not rely on logos alone, and do not assume generic packaging identifies a restaurant.
5. Decide whether a tracked item actually entered a specific bin opening. Seeing an item in someone's hand or near a bin is not enough.
6. Emit exactly one event per item, with a deterministic `event_id` (see contract), confidence values, and evidence crops.
7. Serve the annotated stream and evidence files for the Live scene (contract §4).

## Requirements

- Count an item once, not once per frame. Replaying a clip must produce the same `event_id`s.
- Overlapping camera views: the prototype assigns one authoritative camera per bin and documents that limitation.
- Report occlusion, mixed handfuls, and uncertain destinations as low confidence or `null`, never as fabricated precision.
- Focus on items and bin openings. Do not identify people.
- Never send correctness; core applies the sorting rules.
- Never apply confidence thresholds; send raw candidates and confidences (contract §6).
- Load the catalog from `GET /api/catalog` at startup, falling back to `contracts/fixtures/demo-site.json` (contract §6).
- Set `occurred_at` from clip start wall-clock time + offset, and validate every event against `contracts/disposal-event.schema.json` before posting.
- Compute `event_id` with the reference `make_event_id` in `contracts/scripts/check_python.py` (int `track_id` only), and serialize with `allow_nan=False`.

## Model approach (E's decisions, not user decisions)

- **Tracking:** YOLO11n + ByteTrack (`ultralytics track(persist=True)`) on MPS. People, worn/carried items (backpack, handbag, tie...) and furniture/bins are dropped before anything else uses the output (`tracking.NOT_ITEMS`). A track is judged only after it has been missing for 35 frames, longer than ByteTrack's 30-frame buffer, so a cup hidden by a hand over the bin and then carried away is not counted. Eymen was asked whether to add background subtraction and did not answer; it remains an option if YOLO misses items in the real footage.
- **Identification:** nearest reference embedding (CLIP ViT-B/32), with references **enrolled from the demo camera** (`recyclone-worker enroll`). On 16 Oct, a spike with phone photos plus web product images showed only visually distinctive items (the clear cup) match reliably. Same-table backgrounds dominated, studio web images never matched, DINOv2 was worse, and OCR missed vertical/small logos. So phone/web photos are not used as references.
- **Products from text, no registration:** `categories.PRODUCT_PROMPTS` describes each catalog product in words ("a Shake Shack burger box"). On 16 Oct, with nothing registered, CLIP got 5/7 of Eymen's real items right by brand; the misses fell back to the right generic category. Registered photos (gallery), when present, are still tried first.
- **Unregistered items (generic categories):** when no registered product matches at or above the profile's item threshold, CLIP zero-shot picks one of `categories.GENERIC_PROMPTS` (each a catalog item with a bin rule). On 16 Oct, on Eymen's 6 real items with no gallery, it got **6/6** categories right (cup, takeout box, container, 3× wrapper), with probabilities 0.57–0.99. The wrappers were the low ones, so a 0.78 calibrated threshold would still mark some of them unassessable. A vision LLM (Grok) can replace `CategoryClassifier.classify()` once credits exist.
- **YOLO-World option (`--tracker world`):** tested 16 Oct on the same photos: it labeled a background flask "paper coffee cup" and missed the burger box; it ran at 21 fps (imgsz 960) or 51 fps (640, found nothing). Kept as an option to compare on real footage; not the default.
- **Bin entry:** `throw_score()` scores a track's path per bin region (Eymen asked Claude to write it). The item must have moved; it must vanish inside the opening, or just above it while falling. `entered_bin()` takes the best region at or above 0.5, returns nothing on a tie, and clamps to a plain float.
- **Delivery:** see README "Delivery never stops the run". Only 400/413/422 count as the event's fault; other 4xx are configuration problems and are retried.
- **Catalog:** item IDs are checked against `GET /api/catalog` (fixture fallback) when enrolling (error) and when running (warning).
- **Timestamps:** realtime runs use "now" as clip start; faster runs back-date the start by the clip length, because core rejects `occurred_at` more than 5 s in the future.

## Synthetic stress results (16 Oct, `scripts/stress.py`, motion tracker, no registration)

Drawn scene + cut-outs of the real items; NOT real-camera evidence. Held-out videos (14, never tuned on):
107 drops, **103 counted (96%)**, 4 missed, 4 extra, 0 wrong bin; **bin rule right 85/94**; only 69/107
events above core's 0.5 item threshold (the rest would show as unassessable). Verified failure types:
a white receipt missed in a dark noisy scene; one item counted twice when its track split; two items
thrown into the same bin at the same moment counted once; worst on fast throws with motion blur (bin
rule 4/7, core-identified 2/8). Fixes must be checked on NEW held-out seeds, not these.

## Real-footage experiments (16 Oct, Eymen's 5 handheld phone clips)

Clips IMG_9096/9097 (wall slot) and IMG_9100/9101/9102 (recycling bin), one drop each; bin boxes and true
drop frames are hand-given in a local, git-ignored config (`worker/state/real/bins.json`). These 5 clips are
**dev data**: the rules below were tuned while looking at them, so the numbers are not a held-out accuracy.

- `scripts/real_viz.py`: plain YOLO11n + CLIP per frame. Found the item in only 18–89% of frames: detection,
  not recognition, is the bottleneck on real footage.
- `scripts/hand_pipeline.py` (Eymen's design): pose skeleton + given bin boxes + CLIP on the hand crop
  (holding vs empty). 2/5 drops, 7 false: over the bin the crop sees the bin interior, and the wrist is lost
  when only a forearm is in view.
- `scripts/item_tracker.py` (current best): FastSAM proposes class-agnostic regions, CLIP decides item vs
  background (no YOLO classes), camera motion is removed (optical flow + RANSAC), and **only objects brought
  by a person count**: the skeleton's arm decides which object each hand holds (at most one per hand per
  frame), fragments of one object are merged into one item (nested boxes / hand-over, checked against the
  item's held-time look), bin contents seen before the drop are remembered and never counted. Drop = a carried
  item vanishes in, or comes to rest in, a bin box; vetoed if a hand holds it again outside the bin.
  Result: 1 item per clip (2 in 9102), **5/5 drops into the right bin within ±1.5 s, 0 false**; 3/5 within
  ±0.5 s (the drop is decided when the item vanishes, up to 0.8 s off the release); category right 4/5 (the
  crumpled paper bag came out "wrapper"). FastSAM weights download to `worker/weights/` on first run.
  Needs: a visible arm at some point while the item is held, and bin boxes per camera.

## IoU evaluation and fixes (17 Oct, same 5 dev clips)

Drop timing alone hid a tracking problem, so the item's box is now also scored by IoU against hand-checked boxes:
39 frames (about 8 per clip while the item is in hand), each box from SAM 2.1 on a point placed by eye and checked
on an overlay (3 SAM boxes were wrong and replaced by grid-read boxes). They live with the clip config
(`"gt_boxes": {"frame": [x0, y0, x1, y1]}`), and `scripts/item_tracker.py` reports two numbers: the box a hand
holds (what the drop decision follows) and the best of the item's boxes (was the right box found at all).

Before: held box IoU >= 0.5 in **10/39** (mean 0.33), although the item's best box was right in 38/39. The hand
was linked to the hand-crop proposal, the hand + item region or the arm, and one track jumped to a region twice
its size (IMG_9097, frame 201: IoU 0.18 with its previous box, area x2.04), so that drop came 22 frames late.

Changes (`recyclone_worker/items.py`):
- `hold_touch` replaces `hold_share`: an item touches a hand when half of the SMALLER box overlaps the other (an
  item bigger than the hand now counts); a segmented region beats the synthetic hand crop; a part (lid) gives way
  to the whole object.
- `MAX_GROWTH = 2.0`: frame-to-frame association refuses a box whose area more than doubles or halves. Chosen
  from physics, not by score: 1.4 scored worse (a false drop), 1.6 and 2.0 differed only on IMG_9100.
- `MAIN_SHARE` 0.25 → 0.2: with more correct holds, the crumpled bag in IMG_9102 (25 held frames) fell just under
  the 0.25 bar (26). 0.2 and 0.15 give the same result, so it is not on an edge any more.

After: held box **16/39** (mean 0.49); drops within ±0.5 s **4/5** (was 3/5), within ±1.5 s 5/5, 0 false.
IMG_9097 +22 → +2 frames. IMG_9100 is still 27 frames early: the cup is hidden in the fist until the release,
which no box can see. These are DEV numbers (tuned while looking at these clips); a held-out clip is still needed.

## Generalization check: other places, other bins (17 Oct)

Eymen asked for other places and bins, and no overfitting. Protocol: 3 splits, kept in local configs (git-ignored,
videos not committed; YouTube clips are third-party, for evaluation only):
- **dev**: Eymen's 5 phone clips (`state/real/bins.json`).
- **dev-2**: the 2 YouTube clips Eymen sent (`state/heldout/youtube.json`): street with 3 recycling bins (the person
  stands behind the bins; no item is ever visible, so the correct output is NO drop) and a beach bin (face mask into
  the slot, f405; a wrapper in the other hand is not thrown). They were run FROZEN first, then studied, so they are dev now.
- **test**: 3 more stock clips (`state/test/youtube_test.json`): park cup, container slot close-up (arms only), two
  bins with no person in view. Truth was labeled by looking at the frames only; the model was run once, at the end,
  after every rule was frozen. A 4th (airport) was dropped because its truth could not be told from the frames.

| model | dev (5) | dev-2 (2) | test (3) |
|---|---|---|---|
| before IoU (b7463eb) | 5/5, 0 false | 0/1, 6 false | 0/3, 0 false |
| IoU rules (5b0a01f) + time in seconds | 5/5, 0 false | 1/1, 4 false | 1/3, 0 false |
| **final** (+ item seen outside a bin) | **5/5, 0 false** | **1/1, 0 false** | **1/3, 0 false** |

Changes that generalize (none tuned to a number on a clip):
- Durations are seconds, not frames (`at_fps`, constants given at 30 fps): the YouTube clips are 24 fps, cameras often 10-15.
- `REQUIRE_SEEN_OUTSIDE`: a drop needs an item that was seen AS AN ITEM outside every bin. All 4 dev-2 false drops
  were locks/hinges on bin tops that a hand passed over while the camera panned.
- `item_boxes`: one box per item per frame (the region CLIP is surest is an item, segmented before hand crop),
  used by the videos, the stream and the evidence crop: the shown box matches the true box in 31/39 dev frames.
  Only items seen as items outside a bin are drawn (`data["_brought"]`), the same rule the drop decision uses.
Tried and reverted: a wider "is it an item" vocabulary (TACO litter classes). Words like "a plastic lid" and "scrap
metal" also describe bin hardware, so bin parts became items again (dev-2 back to 4 false drops, a dev drop lost).

Limits shown by the test set: 2 of 3 misses are views with no visible arm (a person cut off by the frame, or an item
dropped from above): the tracker only counts objects a person is seen carrying, by design. A fallback for armless
views (the older motion tracker near the bins) is the next step. Categories are only the demo catalog's: a face mask
came out "wrapper", a bag "paper cup"; out-of-catalog items need catalog entries (contract fixture), not more prompts.
Bins must be marked once per camera (`demo-site.json` regions, or `--item-bins` keyframes for a moving camera).

## Item tracker in `run` (17 Oct)

`recyclone-worker run --tracker items` uses the item tracker (`recyclone_worker/items.py`, `item_playback.py`).
Perception runs at ~2–3 fps on this Mac (measured 17 Oct on IMG_9100: FastSAM 200 ms, pose 26 ms, CLIP on ~50
regions 233 ms per frame; a fresh 437-frame clip took 150 s), against a 30 fps camera, and the drop decision
needs the whole clip (the veto looks 1.5 s ahead). **Eymen's decision (17 Oct): pre-process, play live.** The
clip is analyzed first (cached per file in `state/items-cache/`), then played at clip speed; the annotated
stream and each event go out when the video reaches the drop. Drops still come from the model, not hand
labels; say "analyzed beforehand, played back" if asked, never "real-time detection".

- `track_id` = the item's id (its first held track), so replays give the same `event_id`s (checked: a fresh and a
  cached run of IMG_9100 gave the same id).
- `item`: the item's CLIP category votes, normalized (raw scores, no threshold). No confident look outside a bin
  → unknown (before 17 Oct, all-zero votes silently became the first category, "Shake Shack cup").
- `destination_confidence`: share of the item's last 10 sightings (up to the drop) inside the chosen bin box. A
  plain heuristic, not a calibrated probability; it was 1.0 on all 5 dev clips, so it does not yet separate
  easy from hard drops.
- Evidence crop: the item's last box before the drop, often a fragment of it (IMG_9100: the cup's rim).
- The stream draws bin boxes, carried items and existing bin contents, never the skeleton.
- Through the CLI, the 5 dev clips give the same drops as the script (277/220/361/230/198). The sauce cup's
  category confidence is 0.35, below core's 0.5 item threshold, so core would mark it unassessable.

## Evaluation

- Hand-label the demo clip into `contracts/fixtures/demo-events.jsonl` (item, bin, business where knowable, timestamp).
- Compare worker output against those labels. Report event-counting errors, destination errors, identification errors, and the fraction of events the system could assess. Numerical targets are not yet agreed.
- The same labeled file is the stage backup. If live detection fails during the demo, it can be replayed with `source.mode = "labeled"`, and the dashboard shows that it is a backup.

## Verify

- One disposal produces one event despite repeated frames or reprocessing.
- Items held near a bin but not dropped produce no event.
- Unknown items and businesses come through as `null`, not guesses.

## Environment variables

`API_BASE_URL`, `WORKER_INGEST_TOKEN`, `WORKER_PORT`.
