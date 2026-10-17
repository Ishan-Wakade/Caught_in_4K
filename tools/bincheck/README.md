# bincheck: did the item go into the right bin?

Test tool for footage outside the live pipeline. It runs the worker's detection and identification on a video and decides each deposit. The output is an annotated MP4 (YOLO-style boxes and labels) and a JSON summary.

It reuses the worker as-is: YOLO11n + ByteTrack settings, the CLIP prompts in `categories.py`, and `throw_score()`. Ideas that work here can be proposed to the worker (`worker/` is owned by E).

## Run

Uses the worker's Python dependencies (`cd worker && uv sync`). It also downloads `yolo11n-pose.pt` on first run.

```
# 1. once per camera: click each bin opening's corners, Enter per bin, Esc to finish
python tools/bincheck/bincheck.py setup VIDEO.mov --at 9.4 --camera fixed --out setup.json

# 2. analyse + render
python tools/bincheck/bincheck.py run setup.json --out result.mp4

# optional: several results back to back
python tools/bincheck/bincheck.py reel a.mp4 b.mp4 --out reel.mp4
```

Add `"label": {"item": "...", "correct_bin": "trash"}` to `setup.json` to record the hand label for evaluation. Override any threshold with `--rule name=value`.

The `setup` click window has not been tested; `setup.json` can also be written by hand. Openings are normalized `[x, y]` points on the frame at `reference_time_s`.

## How it decides

1. **Items.** Each tracked object gets a live identity: CLIP on every crop, combined over its 8 sharpest, largest views. Re-ID (CLIP cosine ≥ 0.85 to an item lost in the last 5 s) keeps a split track as one item. An item ends as deposited, left (frame edge), lost, or parked. It does not end on a fixed timeout.
2. **Opening watcher.** Each opening goes CLEAR → OCCUPIED (picture changed, or a wrist from YOLO pose is inside) → clear again (stable for 10 frames, no wrist, no item over it). Then it checks for something new inside.
3. **Deposit.** The deposit is credited to the item whose track ended at the opening. If no track ended there, it goes to the item lost most recently within reach of the opening (hidden in a hand). Confidence comes from three signals: the path ended at the opening (`throw_score`), the item did not come back out, and something new is inside. Three signals give 0.9, two give 0.75, one gives 0.4. A hidden-item credit is capped at 0.6.
4. **Verdict.** Same order as core. Item confidence < 0.5 → can't judge. The top two guesses in different bins and within 0.25 → can't judge. Otherwise the catalog bin is compared with the configured bin type.

The bin type always comes from setup. CLIP read a RECYCLE-labelled bin as "trash".

If the camera moves, KLT feature tracking around the bins keeps the outline aligned. Use `--camera fixed` on a tripod.

## Results so far (17 Oct)

Seven clips: five handheld phone clips of Eymen's items, and two YouTube clips. The parameters were set before testing. Some logic fixes were made after seeing the first clip, so treat these clips as a smoke test, not an evaluation.

| Clip | Result |
|---|---|
| Kraft box → trash slot | Wrong bin ✅ |
| Clear cup → trash slot | Wrong bin ✅ |
| Paper cup → RECYCLE | Wrong bin ✅ (0.9) |
| Sauce cup → RECYCLE | Deposit found; can't judge (item unclear) |
| Crumpled paper → RECYCLE | Deposit found; can't judge (0.48, just under 0.5) |
| YouTube: masks into a street bin | 1 of 4 drops found; masks/tissues never detected |
| YouTube: bag into a lidded wheelie bin | Missed |

## Known limits

- **The detector is the bottleneck.** COCO YOLO misses items held in a hand near the opening, and thin, soft or light items (masks, tissues, bags).
- **`--hands` is experimental and off by default.** Crops around each hand do find the held item, but zero-shot CLIP calls 97% of hand crops "holding". It needs a small trained empty/holding classifier, about 100 labelled hand crops.
- **Handheld footage drifts.** The outline can slide during big camera moves, which makes the "new object" signal unreliable.
- **Side-facing or lidded openings** hide the contents, so only the path and no-return signals are left.
- **Junk detections** in the background (window panes, plates) are labelled too.
