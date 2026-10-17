"""Turn Unity clean frames + unity.json into the outputs the brief asks for (docs/sim/unity-sim-brief.md §5).

    worker/.venv/bin/python sim/unity-mac/pack.py sim/unity-mac/Output/<split>/<clip>  [...more clips]

Per clip: camera conditions are applied (decided by the seed, shares fixed in the brief §4), then:
video.mp4, labels.jsonl (DisposalEvent, mode "labeled"), non_disposals.jsonl, site.json (one camera,
two bins, regions projected from 3D), config.json, and yolo/ (every 3rd frame, train/dev only).
"""

import json
import random
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "worker"))
from recyclone_worker.evaluate import labeled_event  # noqa: E402
from recyclone_worker.events import dumps_event  # noqa: E402

CAMERA_ID = "cam_room_1"
CONDITIONS = [("clean", 40), ("dim_noise", 15), ("blur", 10), ("jpeg", 10), ("shake", 5), ("fps15", 10), ("res480", 10)]
HARD = ["dim_noise", "blur", "jpeg", "shake", "fps15", "res480"]


def pick_conditions(seed: int, split: str) -> list[str]:
    rng = random.Random(seed * 7919 + 13)
    if split == "test" and rng.random() < 0.20:  # fixed 20% "worst" clips in test
        return sorted(rng.sample(HARD, rng.randint(3, 4)))
    r, acc = rng.random() * 100, 0
    for name, share in CONDITIONS:
        acc += share
        if r < acc:
            return [name]
    return ["clean"]


def apply(frame: np.ndarray, conds: list[str], rng: np.random.Generator) -> np.ndarray:
    f = frame
    if "blur" in conds:
        k = np.zeros((11, 11), np.float32)
        k[:, 5] = 1 / 11
        f = cv2.filter2D(f, -1, k)
    if "dim_noise" in conds:
        f = np.clip(f.astype(np.float32) * 0.55 + rng.normal(0, 8, f.shape), 0, 255).astype(np.uint8)
    if "shake" in conds:
        dx, dy = rng.integers(-4, 5, 2)
        f = cv2.warpAffine(f, np.float32([[1, 0, dx], [0, 1, dy]]), (f.shape[1], f.shape[0]), borderMode=cv2.BORDER_REPLICATE)
    if "jpeg" in conds:
        f = cv2.imdecode(cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, 28])[1], cv2.IMREAD_COLOR)
    if "res480" in conds:
        f = cv2.resize(f, (854, 480), interpolation=cv2.INTER_AREA)
    return f


def site_json(unity: dict) -> dict:
    site = json.loads((REPO / "contracts/fixtures/demo-site.json").read_text())
    site["stations"] = [{"station_id": "st_room", "name": "Room"}]
    site["cameras"] = [{"camera_id": CAMERA_ID, "station_id": "st_room", "name": "Corner camera",
                        "bin_regions": [{k: b[k] for k in ("bin_id", "x", "y", "w", "h")} for b in unity["bins"]]}]
    site["bins"] = [{"bin_id": b["bin_id"], "station_id": "st_room", "name": f"Room {b['type']}", "type": b["type"],
                     "capacity_l": 60, "initial_volume_l": 0, "camera_id": CAMERA_ID, "emptying_contact_id": "ct_area_mgr"}
                    for b in unity["bins"]]
    return site


def pack(clip: Path) -> None:
    unity = json.loads((clip / "unity.json").read_text())
    seed, split = unity["seed"], unity["split"]
    conds = pick_conditions(seed, split)
    rng = np.random.default_rng(seed)
    fps_in = unity["fps"]
    step = 2 if "fps15" in conds else 1
    fps_out = fps_in // step
    frames = sorted((clip / "frames").glob("*.png"))
    first = apply(cv2.imread(str(frames[0])), conds, rng)
    h, w = first.shape[:2]
    ff = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                           "-r", str(fps_out), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                           "-pix_fmt", "yuv420p", str(clip / "video.mp4")], stdin=subprocess.PIPE)
    boxes = {}
    for line in (clip / "yolo_boxes.tsv").read_text().splitlines():
        idx, _, rest = line.partition("\t")
        boxes[int(idx)] = [b for b in rest.split(";") if b]
    yolo = clip / "yolo"
    if split in ("train", "dev"):
        (yolo / "images").mkdir(parents=True, exist_ok=True)
        (yolo / "labels").mkdir(parents=True, exist_ok=True)
    for i, path in enumerate(frames):
        if i % step:
            continue
        f = first if i == 0 else apply(cv2.imread(str(path)), conds, rng)
        ff.stdin.write(f.tobytes())
        if split in ("train", "dev") and i in boxes:
            cv2.imwrite(str(yolo / "images" / f"{clip.name}_{i:05d}.jpg"), f, [cv2.IMWRITE_JPEG_QUALITY, 90])
            (yolo / "labels" / f"{clip.name}_{i:05d}.txt").write_text("\n".join(boxes[i]) + ("\n" if boxes[i] else ""))
    ff.stdin.close()
    ff.wait()

    started = datetime(2026, 10, 17, tzinfo=UTC)
    labels, misses = [], []
    for row, it in enumerate(unity["items"], start=1):
        if it["labeled_bin"]:
            labels.append(labeled_event(row=row, clip_id=clip.name, camera_id=CAMERA_ID, started_at=started,
                                        offset_s=it["labeled_at"], bin_id=it["labeled_bin"],
                                        catalog_item_id=it["catalog_item_id"], business_id=None))
        else:
            misses.append({"row": row, "kind": it["kind"], "scenario": it["scenario"], "intended_bin": it["intended_bin"]})
    labels.sort(key=lambda e: e["clip_offset_s"])
    (clip / "labels.jsonl").write_text("".join(dumps_event(e) + "\n" for e in labels))
    (clip / "non_disposals.jsonl").write_text("".join(json.dumps(m) + "\n" for m in misses))
    (clip / "site.json").write_text(json.dumps(site_json(unity), indent=1))
    scen = {str(r): it["scenario"] for r, it in enumerate(unity["items"], start=1)}
    (clip / "config.json").write_text(json.dumps({"seed": seed, "split": split, "conditions": conds, "fps": fps_out, "release_at_by_row": {str(r): it.get("release_at", -1) for r, it in enumerate(unity["items"], start=1)},
                                                   "lighting": unity["lighting"], "camera": unity["camera"],
                                                   "scenario_by_row": scen}, indent=1))
    print(f"{clip.name}: {conds} -> {len(labels)} disposals, {len(misses)} non-disposals", flush=True)


if __name__ == "__main__":
    for c in sys.argv[1:]:
        pack(Path(c))
