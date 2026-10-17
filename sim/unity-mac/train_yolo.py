"""Fine-tune YOLO11n on the Unity renders: classes 0 = item, 1 = person (docs/sim/unity-sim-brief.md §6.2).

    worker/.venv/bin/python sim/unity-mac/train_yolo.py [--epochs 30] [--imgsz 640]

train = Output/train/*/yolo, val = Output/dev/*/yolo (epoch chosen on dev only). Test clips have no
YOLO data at all, so they cannot leak into training. Weights land in Output/yolo_run/weights/best.pt.
"""

import argparse
import os
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "Output"


def collect(split: str, dest: Path) -> int:
    """Symlink every clip's yolo images/labels into one ultralytics-style folder (no copies: disk is tight)."""
    (dest / "images").mkdir(parents=True, exist_ok=True)
    (dest / "labels").mkdir(parents=True, exist_ok=True)
    n = 0
    for clip in sorted((OUT / split).glob("sim_*")):
        for img in (clip / "yolo" / "images").glob("*.jpg"):
            label = clip / "yolo" / "labels" / (img.stem + ".txt")
            for src, sub in ((img, "images"), (label, "labels")):
                link = dest / sub / src.name
                if not link.exists() and src.exists():
                    os.symlink(src, link)
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--imgsz", type=int, default=640)
    args = ap.parse_args()
    ds = OUT / "yolo_dataset"
    n_train, n_val = collect("train", ds / "train"), collect("dev", ds / "val")
    print(f"train images {n_train}, val (dev) images {n_val}")
    (ds / "dataset.yaml").write_text(f"path: {ds}\ntrain: train/images\nval: val/images\nnames:\n  0: item\n  1: person\n")
    from ultralytics import YOLO

    model = YOLO(str(HERE.parents[1] / "worker/weights/yolo11n.pt"))
    model.train(data=str(ds / "dataset.yaml"), epochs=args.epochs, imgsz=args.imgsz, device="mps", batch=16,
                patience=10, project=str(OUT), name="yolo_run", exist_ok=True, seed=0, deterministic=True, verbose=False)


if __name__ == "__main__":
    main()
