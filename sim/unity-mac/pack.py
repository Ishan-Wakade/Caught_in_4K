"""Turn Unity clean frames + unity.json into the outputs the brief asks for (docs/sim/unity-sim-brief.md §5).

v2: every clip first goes through a CCTV camera model (barrel lens distortion, vignette, sensor noise,
on-screen timestamp, low-bitrate H.264). Boxes and bin regions are pushed through the same lens
distortion so labels stay aligned with pixels.

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


class Lens:
    """Barrel distortion as a remap: output pixel (x_d) samples source x_u = x_d * (1 + k r_d^2)."""

    def __init__(self, w: int, h: int, k: float):
        self.w, self.h, self.k = w, h, k
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        nx, ny = (xs - w / 2) / (w / 2), (ys - h / 2) / (w / 2)
        r2max = 1 + (h / w) ** 2
        self.zoom = 1 / (1 + k * r2max)  # zoom in so even the corners sample inside the source (no smeared edges)
        f = (1 + k * (nx * nx + ny * ny)) * self.zoom
        self.map_x = (nx * f * (w / 2) + w / 2).astype(np.float32)
        self.map_y = (ny * f * (w / 2) + h / 2).astype(np.float32)
        r = np.sqrt(nx * nx + (ny * w / h) ** 2 * (h / w) ** 2)
        self.vignette = (1 - 0.35 * np.clip(r / 1.2, 0, 1) ** 2)[..., None].astype(np.float32)

    def frame(self, img):
        return cv2.remap(img, self.map_x, self.map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    def point(self, x: float, y: float) -> tuple[float, float]:
        """Source (undistorted, normalized 0..1) -> output (distorted, normalized), by fixed-point iteration."""
        ux, uy = (x * self.w - self.w / 2) / (self.w / 2), (y * self.h - self.h / 2) / (self.w / 2)
        dx, dy = ux, uy
        for _ in range(30):
            f = (1 + self.k * (dx * dx + dy * dy)) * self.zoom
            dx, dy = ux / f, uy / f
        return (dx * (self.w / 2) + self.w / 2) / self.w, (dy * (self.w / 2) + self.h / 2) / self.h

    def box(self, x0, y0, x1, y1):
        pts = [self.point(x, y) for x in (x0, (x0 + x1) / 2, x1) for y in (y0, (y0 + y1) / 2, y1)]
        xs, ys = [p[0] for p in pts], [p[1] for p in pts]
        return max(0, min(xs)), max(0, min(ys)), min(1, max(xs)), min(1, max(ys))


def cctv(img, lens: Lens, rng: np.random.Generator, t: float, start_hms: tuple[int, int, int]):
    f = lens.frame(img).astype(np.float32) * lens.vignette
    f = np.clip(f + rng.normal(0, 3, f.shape), 0, 255).astype(np.uint8)
    secs = start_hms[0] * 3600 + start_hms[1] * 60 + start_hms[2] + int(t)
    stamp = f"2026-10-17  {secs // 3600 % 24:02d}:{secs // 60 % 60:02d}:{secs % 60:02d}  CAM-01"
    for color, thick in (((0, 0, 0), 4), ((235, 235, 235), 1)):
        cv2.putText(f, stamp, (18, 34), cv2.FONT_HERSHEY_SIMPLEX, 0.7, color, thick, cv2.LINE_AA)
    return f


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


def site_json(unity: dict, lens: Lens) -> dict:
    site = json.loads((REPO / "contracts/fixtures/demo-site.json").read_text())
    site["stations"] = [{"station_id": "st_room", "name": "Room"}]
    site["cameras"] = [{"camera_id": CAMERA_ID, "station_id": "st_room", "name": "Corner camera",
                        "bin_regions": [region(b, lens) for b in unity["bins"]]}]
    site["bins"] = [{"bin_id": b["bin_id"], "station_id": "st_room", "name": f"Room {b['type']}", "type": b["type"],
                     "capacity_l": 60, "initial_volume_l": 0, "camera_id": CAMERA_ID, "emptying_contact_id": "ct_area_mgr"}
                    for b in unity["bins"]]
    return site


def region(b: dict, lens: Lens) -> dict:
    x0, y0, x1, y1 = lens.box(b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"])
    return {"bin_id": b["bin_id"], "x": round(x0, 4), "y": round(y0, 4), "w": round(x1 - x0, 4), "h": round(y1 - y0, 4)}


def pack(clip: Path) -> None:
    unity = json.loads((clip / "unity.json").read_text())
    seed, split = unity["seed"], unity["split"]
    conds = pick_conditions(seed, split)
    rng = np.random.default_rng(seed)
    fps_in = unity["fps"]
    step = 2 if "fps15" in conds else 1
    fps_out = fps_in // step
    frames = sorted((clip / "frames").glob("*.png"))
    lens = Lens(unity["width"], unity["height"], float(rng.uniform(0.08, 0.25)))
    start_hms = (int(rng.integers(6, 22)), int(rng.integers(0, 60)), int(rng.integers(0, 60)))
    bitrate = f"{int(rng.integers(600, 1600))}k"
    first = apply(cctv(cv2.imread(str(frames[0])), lens, rng, 0, start_hms), conds, rng)
    h, w = first.shape[:2]
    ff = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                           "-r", str(fps_out), "-i", "-", "-c:v", "libx264", "-preset", "veryfast", "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", "2M",
                           "-pix_fmt", "yuv420p", str(clip / "video.mp4")], stdin=subprocess.PIPE)
    boxes, kinds = {}, {}
    for line in (clip / "yolo_boxes.tsv").read_text().splitlines():
        idx, _, rest = line.partition("\t")
        out, ks = [], []
        for b in (b for b in rest.split(";") if b):
            parts = b.split()
            cx, cy, bw, bh = map(float, parts[1:5])
            x0, y0, x1, y1 = lens.box(cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2)
            if x1 - x0 > 0.002 and y1 - y0 > 0.002:
                out.append(f"{parts[0]} {(x0 + x1) / 2:.5f} {(y0 + y1) / 2:.5f} {x1 - x0:.5f} {y1 - y0:.5f}")
                ks.append(parts[6] if len(parts) > 6 else "?")
        boxes[int(idx)], kinds[int(idx)] = out, ks
    yolo = clip / "yolo"
    if split in ("train", "dev"):
        (yolo / "images").mkdir(parents=True, exist_ok=True)
        (yolo / "labels").mkdir(parents=True, exist_ok=True)
        (yolo / "kinds").mkdir(parents=True, exist_ok=True)
    for i, path in enumerate(frames):
        if i % step:
            continue
        f = first if i == 0 else apply(cctv(cv2.imread(str(path)), lens, rng, i / fps_in, start_hms), conds, rng)
        ff.stdin.write(f.tobytes())
        if split in ("train", "dev") and i in boxes:
            cv2.imwrite(str(yolo / "images" / f"{clip.name}_{i:05d}.jpg"), f, [cv2.IMWRITE_JPEG_QUALITY, 90])
            (yolo / "labels" / f"{clip.name}_{i:05d}.txt").write_text("\n".join(boxes[i]) + ("\n" if boxes[i] else ""))
            (yolo / "kinds" / f"{clip.name}_{i:05d}.txt").write_text("\n".join(kinds[i]) + ("\n" if kinds[i] else ""))
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
    (clip / "site.json").write_text(json.dumps(site_json(unity, lens), indent=1))
    scen = {str(r): it["scenario"] for r, it in enumerate(unity["items"], start=1)}
    (clip / "config.json").write_text(json.dumps({"seed": seed, "split": split, "conditions": conds, "fps": fps_out, "release_at_by_row": {str(r): it.get("release_at", -1) for r, it in enumerate(unity["items"], start=1)},
                                                   "lighting": unity["lighting"], "camera": unity["camera"], "version": unity.get("version", "v1"),
                                                   "lens_k": lens.k, "bitrate": bitrate, "floor": unity.get("floor"), "walls": unity.get("walls"), "bin_style": unity.get("bin_style"),
                                                   "scenario_by_row": scen}, indent=1))
    print(f"{clip.name}: {conds} -> {len(labels)} disposals, {len(misses)} non-disposals", flush=True)


if __name__ == "__main__":
    for c in sys.argv[1:]:
        pack(Path(c))
