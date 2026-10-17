# Recyclone CV worker (Agent E)

Footage in, one `DisposalEvent` per item that entered a bin out, posted to core's `POST /api/events`.
Contract: `contracts/README.md` §1, §4, §6. Design notes: `AGENTS.md` in this folder.

## Setup

```bash
cd worker
uv sync
# Model weights are not in git. Put (or symlink) them here:
#   weights/yolo11n.pt            (ultralytics YOLO11n)
#   weights/clip/ViT-B-32.pt      (OpenAI CLIP)
```

Environment (see the root `.env.example`): `API_BASE_URL`, `WORKER_INGEST_TOKEN`, `WORKER_PORT` (default 8765).

## Commands

| Command | What it does |
|---|---|
| `uv run recyclone-worker enroll --clip enroll.mp4 --segments segments.json --out state/gallery.npz` | Build references from an enrollment clip shot with the demo camera. `segments.json`: `[{"catalog_item_id": "item_beanco_cup", "start_s": 0, "end_s": 6}, ...]` |
| `uv run recyclone-worker run --clip demo.mp4 --clip-id clip_demo_v1 --gallery state/gallery.npz --realtime` | Live demo: plays at clip speed, posts events, serves `http://localhost:8765/stream.mjpg` |
| `... run ... --dry-run --no-stream` | Print events instead of posting (no API needed) |
| `uv run recyclone-worker replay-labeled --file ../contracts/fixtures/demo-events.jsonl` | Stage backup: post hand-labeled events. Call `POST /api/demo/reset` first, and never mix with a live run. |
| `uv run recyclone-worker flush` | Resend events queued in `state/outbox.jsonl` while the API was down |
| `uv run recyclone-worker calibrate --clip demo.mp4` | Draw each bin opening on a frame; saves the regions into `contracts/fixtures/demo-site.json` |
| `uv run recyclone-worker label --clip demo.mp4 --clip-id clip_demo_v1` | Hand-label every drop (keys in the window, answers in the terminal) → `contracts/fixtures/demo-events.jsonl` |
| `... run ... --events-out state/run.jsonl` then `uv run recyclone-worker evaluate --labels ../contracts/fixtures/demo-events.jsonl --predicted state/run.jsonl` | Counting, wrong-bin, item and assessable rates vs the hand labels |
| `uv run recyclone-worker suggest-thresholds --gallery state/gallery.npz` | Calibrate core's confidence thresholds for CLIP (TACO litter as not-in-catalog examples) |
| `... run ... --tracker motion` | Background-subtraction tracker near the bins, for items YOLO can't name (wrappers, bags) |
| `... run ... --tracker world` | YOLO-World with packaging prompts (slower; compare on real footage) |
| `... run --tracker items --namer deepseek --local-rules rules/cambridge-ma-2022.md` | Items not in the catalog get a proposed generic type (DeepSeek) and a suggested bin under the local rules (Jev), sent as `item.proposed_type` for the area manager to approve. Keys: `~/.config/recyclone/{deepseek,jev}.env`. |
| `... run ... --no-categories` | Report unregistered items as unknown instead of a generic category (on by default) |
| `uv run recyclone-worker run --tracker items --clip demo.mp4 --clip-id clip_demo_v1 --realtime` | **Best on real footage.** Item tracker: analyzes the whole clip first (~0.4 s per frame, cached in `state/items-cache/`, so run it once before the demo), then plays it at clip speed, sending each drop's event when the video reaches it. Bins come from `demo-site.json`; `--item-bins state/my.json` gives per-frame boxes for a moving camera. `--gallery` is ignored (items are named from text). |

## Item tracker on real footage (anyone on the team can run and improve it)

`scripts/item_tracker.py` is the current best detector on real, even hand-held, footage. It counts only objects a
person brings in (the skeleton's arm decides), remembers what was already in a bin, and decides drops. The logic
lives in `recyclone_worker/items.py` and is what `run --tracker items` uses; this script scores it against true
drop frames and renders debug videos. Results and limits: `AGENTS.md`, "Real-footage experiments".

```bash
cd worker && uv sync                     # weights (FastSAM, YOLO11n-pose, CLIP) download on first run
uv run python scripts/pick_boxes.py ~/Videos/clip.mov --bins bin_recycle --frames 120,180,240 > state/my.json
# edit state/my.json: add each real drop to "truths" as {"frame": N, "bin": "bin_..."}
uv run python scripts/item_tracker.py ~/Downloads/tracker-out state/my.json
```

Format of the config: `examples/item_tracker.example.json` (keep your own copy under `state/`, which is git-ignored).
Output: `<name>_items.mp4` per clip (one box per item, the arms, a magenta line from a wrist to the item it
holds, DROP banner; `--debug` draws every fragment and bin contents too), `item_summary.md` (found / false drops at ±0.5 s and ±1.5 s), `item_results.json`.

Improving it:
- Perception is cached in `OUT/cache/`, so after the first run a rule change re-scores in seconds
  (`--no-video` skips rendering). `--recompute` re-runs the models.
- The knobs are the constants at the top of `recyclone_worker/items.py`, each with a one-line reason.
- Box accuracy: add `"gt_boxes": {"120": [x0, y0, x1, y1], ...}` (the carried item, full-frame pixels) to a clip's
  config and the summary reports IoU of the held box and of the item's best box (IoU >= 0.5 counts as a match).
- `--test` marks a config as the test split in the summary. Keep a **dev** set you tune on and a **test** set you only score at the end; numbers from clips you tuned
  on are not accuracy. Never commit videos or `state/` configs (people are in them).

Filming plan and the full after-filming sequence: `docs/demo/shot-list.md`. Local end-to-end rehearsal against the real core: `pnpm --filter @recyclone/rehearsal start` (see `tools/rehearsal/server.ts`).

The stream and evidence URLs are for `<img src=...>` on the presenter's laptop only: there is no CORS header, so `fetch()` from the dashboard cannot read them, and requests whose `Host` is not localhost get 403.

Delivery never stops the run:
- Events are sent from a background thread, so a slow API never freezes the video. Unreachable API, timeouts, 5xx, garbled replies, and configuration errors (401/404/429) go to `state/outbox.jsonl`; a running worker retries them every 5 s, and `flush` resends any left over. Don't run `flush` while `run` is posting.
- Events core says are wrong (400/413/422) go to `state/rejected.jsonl` with core's reason, printed as `REJECTED`.
- At the end, `run` prints `delivery: created N, duplicate N, queued N, rejected N`. If everything was a duplicate, you forgot `POST /api/demo/reset` after a rehearsal.

`replay-labeled` shifts the file's timestamps to now and, by default, sends each event when its moment arrives (`--no-wait` sends all at once).

## Tests

`uv run pytest -q`. No model downloads: ML parts are faked in `tests/fakes.py`.

## What is real and what is not yet

- Real: tracking (YOLO11n + ByteTrack on the Mac GPU, about 50 fps at imgsz 960, measured 16 Oct; people, worn items and furniture dropped), bin regions from `demo-site.json`, deterministic IDs, contract validation, background delivery with outbox, MJPEG stream, evidence crops (the last frame before the item vanished).
- Waiting on footage: bin regions in `demo-site.json` are placeholders until the demo camera is set up; reference gallery needs the enrollment clip.
- Business evidence comes from reference matching only (a branded item among the top candidates); there is no logo/text reading.
- Not built: a live camera source, one-authoritative-camera handling across several cameras.
- `throw_score()` (bin entry) is a simple path heuristic, tested against falling in, falling at the rim, being held near and carried away, passing over, and standing still. Tune it on the real footage.
- Known gap: if the tracker switches IDs mid-throw, one item can produce two events.
