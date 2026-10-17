"""Draw bin boxes on a few frames of your own clip and print the item_tracker config entry for it.

    uv run python scripts/pick_boxes.py CLIP.mov --bins bin_recycle,bin_trash --frames 120,200,260 [--name my_clip]

For each listed frame and each bin, a window opens: drag a box around that bin (the whole bin, not just the
opening), press Enter or Space to accept, or press c to skip a bin that is not in view on that frame.
A fixed camera needs one frame; a hand-held phone needs a frame every second or two while the bin is in view
(boxes are interpolated in between). The printed entry has "truths": [] — fill in each real drop as
{"frame": N, "bin": "bin_..."} (the frame number is shown in the item_tracker video's top-left corner).
"""

import argparse
import json
from pathlib import Path

import cv2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("clip")
    ap.add_argument("--bins", required=True, help="comma-separated bin ids, e.g. bin_recycle,bin_trash")
    ap.add_argument("--frames", required=True, help="comma-separated frame numbers to draw on")
    ap.add_argument("--name", help="config key (default: the clip's file name)")
    args = ap.parse_args()
    clip = Path(args.clip).expanduser().resolve()
    cap = cv2.VideoCapture(str(clip))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    keyframes = {b: [] for b in args.bins.split(",")}
    for f in sorted(int(x) for x in args.frames.split(",")):
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, img = cap.read()
        if not ok:
            raise SystemExit(f"cannot read frame {f} (clip has {n} frames)")
        scale = min(1.0, 900 / img.shape[0])  # fit a phone-portrait frame on a laptop screen
        small = cv2.resize(img, None, fx=scale, fy=scale)
        for bid in keyframes:
            title = f"frame {f}: box around {bid} (Enter = ok, c = not in view)"
            x, y, w, h = cv2.selectROI(title, small, showCrosshair=False)
            cv2.destroyWindow(title)
            if w and h:
                keyframes[bid].append([f, [round(v / scale) for v in (x, y, x + w, y + h)]])
    bins = []
    for bid, kf in keyframes.items():
        if not kf:
            continue
        # one box = a fixed camera: the bin is in view for the whole clip; otherwise only between the drawn frames
        visible = [0, n - 1] if len(kf) == 1 else [kf[0][0], kf[-1][0]]
        bins.append({"bin_id": bid, "visible": visible, "keyframes": kf})
    print(json.dumps({args.name or clip.stem: {"video": str(clip), "truths": [], "bins": bins}}, indent=1))


if __name__ == "__main__":
    main()
