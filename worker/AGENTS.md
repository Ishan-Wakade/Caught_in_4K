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
- **Bin entry:** `throw_score()` scores a track's path per bin region (Eymen asked Claude to write it). The item must have moved; it must vanish inside the opening, or just above it while falling. `entered_bin()` takes the best region at or above 0.5, returns nothing on a tie, and clamps to a plain float.
- **Delivery:** see README "Delivery never stops the run". Only 400/413/422 count as the event's fault; other 4xx are configuration problems and are retried.
- **Catalog:** item IDs are checked against `GET /api/catalog` (fixture fallback) when enrolling (error) and when running (warning).
- **Timestamps:** realtime runs use "now" as clip start; faster runs back-date the start by the clip length, because core rejects `occurred_at` more than 5 s in the future.

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
