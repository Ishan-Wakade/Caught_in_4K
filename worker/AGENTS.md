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

## Model approach (E's provisional plan, not a user decision)

Earlier testing in Eymen's `~/recycle-cv` showed a stock COCO detector labeling a plastic bottle "vase" and mislabeling food waste. Proposed two-stage design: a class-agnostic "object" detector and tracker near bin openings, plus a classifier/matcher on each crop against catalog reference images and logo text. Training data candidates: TACO, TrashNet, RealWaste, Garbage12, ZeroWaste. Final choice is E's, recorded here once made.

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
