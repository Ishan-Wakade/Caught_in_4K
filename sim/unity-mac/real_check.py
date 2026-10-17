"""Sim2real check: does a detector find Eymen's REAL items in his phone photos? (brief §6.3)

    worker/.venv/bin/python sim/unity-mac/real_check.py PHOTO_DIR WEIGHTS [WEIGHTS...]

Ground truth = the hand-drawn item boxes already used by worker/scripts/synth.py (photos at 768x1024,
one item each). Reports recall: an item counts as found if some detection overlaps its box with
IoU >= 0.3 (generous on purpose: hand boxes are loose). Precision is not reported, because other
real objects in these photos (laptop, flask) are unlabeled.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "worker" / "scripts"))
import synth  # noqa: E402  (CUTOUTS: photo stem -> box)

EXTRA = {"2470": (150, 20, 540, 900), "2465": (120, 280, 550, 800), "2469": (205, 380, 525, 915)}  # more labeled photos


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter)


def main():
    photo_dir = Path(sys.argv[1])
    truth = {stem: box for _, (stem, box, _) in synth.CUTOUTS.items()} | {f"IMG_{k}": v for k, v in EXTRA.items()}
    from ultralytics import YOLO

    for weights in sys.argv[2:]:
        model = YOLO(weights)
        found = 0
        for stem, box in sorted(truth.items()):
            r = model.predict(str(photo_dir / f"{stem}.jpg"), imgsz=640, conf=0.15, device="mps", verbose=False)[0]
            names = model.names
            dets = [b for b, c in zip(r.boxes.xyxy.tolist(), r.boxes.cls.int().tolist()) if names[c] != "person"]
            best = max((iou(d, box) for d in dets), default=0.0)
            found += best >= 0.3
            print(f"  {Path(weights).name:20s} {stem}: best IoU {best:.2f} {'FOUND' if best >= 0.3 else 'missed'}")
        print(f"{weights}: real-photo recall {found}/{len(truth)}\n")


if __name__ == "__main__":
    main()
