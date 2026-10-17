"""Synthetic test videos for the worker: real item cut-outs thrown into drawn bins, with labels.

NOT evidence of real-camera performance (flat drawn scene, pasted items). Used to find failure modes
and regressions before real footage exists. Item photos are read from a local folder, never committed.
Every video comes with hand-free ground truth (`*.labels.jsonl`, DisposalEvent format, mode
"labeled") so `recyclone-worker evaluate` can score it.
"""

import json
import random
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import cv2
import numpy as np

from recyclone_worker.evaluate import labeled_event
from recyclone_worker.events import dumps_event

SITE = json.loads((Path(__file__).resolve().parents[2] / "contracts/fixtures/demo-site.json").read_text())
REGIONS = {r["bin_id"]: r for r in SITE["cameras"][0]["bin_regions"]}
BINS = list(REGIONS)
COLORS = {"bin_patio_trash": (70, 70, 70), "bin_patio_recycling": (170, 110, 30), "bin_patio_compost": (40, 120, 40)}

# cut-out name -> (photo stem, crop box in the 768x1024 preview, catalog_item_id)
CUTOUTS = {
    "biscoff": ("IMG_2467", (165, 185, 485, 865), "item_biscoff_wrapper"),
    "shakeshack_cup": ("IMG_2464", (120, 100, 450, 810), "item_shakeshack_cup"),
    "shakeshack_box": ("IMG_2472", (65, 165, 695, 445), "item_shakeshack_box"),
    "sauce_cup": ("IMG_2471", (205, 375, 515, 610), "item_sauce_cup"),
    "goldfish": ("IMG_2466", (70, 320, 635, 840), "item_goldfish_bag"),
    "granola": ("IMG_2468", (215, 235, 605, 880), "item_granola_wrapper"),
}
SHOT_LIST = [("biscoff", "bin_patio_trash"), ("shakeshack_cup", "bin_patio_trash"), ("shakeshack_cup", "bin_patio_recycling"),
             ("shakeshack_cup", "bin_patio_trash"), ("sauce_cup", None), ("shakeshack_box", "bin_patio_trash"),
             ("receipt", "bin_patio_compost"), ("goldfish", "bin_patio_trash"), ("granola", "bin_patio_trash")]


@dataclass
class Variant:
    name: str
    seed: int = 0
    w: int = 1280
    h: int = 720
    fps: int = 30
    item_height: int = 110        # px; real cameras may see items smaller
    fall_frames: int = 25         # frames from release to vanishing; fewer = faster throw
    brightness: float = 1.0
    noise: float = 0.0            # std of per-frame sensor noise
    blur: int = 0                 # motion-blur kernel length (px) while moving
    shake: int = 0                # camera jitter amplitude (px)
    jpeg_quality: int = 0         # 0 = off; else re-encode each frame (compression artifacts)
    busy_background: bool = False
    lighting_drift: float = 0.0   # slow brightness change over the clip (fraction)
    passerby: bool = False        # a person-sized shape walks across in front of the bins
    simultaneous: bool = False    # two throws into different bins at the same moment
    random_order: bool = False    # random items/bins instead of the shot list
    held_out: bool = False        # True = never used for tuning; results are the ones reported
    extra: dict = field(default_factory=dict)


def _cutout(photo_dir: Path, stem: str, box, height: int):
    img = cv2.imread(str(photo_dir / f"{stem}.jpg"))
    x1, y1, x2, y2 = box
    crop = img[y1:y2, x1:x2]
    mask = np.zeros(crop.shape[:2], np.uint8)
    m = 8
    cv2.grabCut(crop, mask, (m, m, crop.shape[1] - 2 * m, crop.shape[0] - 2 * m), np.zeros((1, 65)), np.zeros((1, 65)), 5, cv2.GC_INIT_WITH_RECT)
    alpha = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    s = height / crop.shape[0]
    return cv2.resize(crop, None, fx=s, fy=s), cv2.resize(alpha, None, fx=s, fy=s)


def _receipt(height: int):
    w = int(height * 0.55)
    item = np.full((height, w, 3), 235, np.uint8)
    cv2.putText(item, "$4.20", (3, height // 2), cv2.FONT_HERSHEY_SIMPLEX, height / 140, (60, 60, 60), 1)
    alpha = np.zeros((height, w), np.uint8)
    cv2.ellipse(alpha, (w // 2, height // 2), (w // 2 - 1, height // 2 - 1), 0, 0, 360, 255, -1)
    return item, alpha


class Scene:
    def __init__(self, v: Variant, photo_dir: Path):
        self.v, self.rng = v, np.random.default_rng(v.seed)
        bg = np.full((v.h, v.w, 3), (200, 205, 210), np.uint8)
        bg[int(v.h * 0.8):] = (120, 125, 130)
        if v.busy_background:  # posters, tiles: lots of texture for the background model
            for _ in range(40):
                x, y = self.rng.integers(0, v.w), self.rng.integers(0, int(v.h * 0.8))
                c = tuple(int(c) for c in self.rng.integers(40, 220, 3))
                cv2.rectangle(bg, (int(x), int(y)), (int(x + self.rng.integers(20, 160)), int(y + self.rng.integers(20, 120))), c, -1)
        self.bg = np.clip(bg.astype(int) + self.rng.integers(-6, 7, bg.shape), 0, 255).astype(np.uint8)
        self.items = {k: _cutout(photo_dir, stem, box, v.item_height) for k, (stem, box, _) in CUTOUTS.items()}
        self.items["receipt"] = _receipt(int(v.item_height * 0.7))

    def region_px(self, bin_id):
        r = REGIONS[bin_id]
        return r["x"] * self.v.w, r["y"] * self.v.h, r["w"] * self.v.w, r["h"] * self.v.h

    def draw_bins(self, f):
        for bin_id in BINS:
            x, y, w, h = map(int, self.region_px(bin_id))
            cv2.rectangle(f, (x - 10, y + h // 3), (x + w + 10, self.v.h - 10), COLORS[bin_id], -1)

    def paste(self, f, name, cx, cy):
        item, alpha = self.items[name]
        h, w = alpha.shape
        x1, y1 = int(cx - w / 2), int(cy - h / 2)
        fx1, fy1, fx2, fy2 = max(0, x1), max(0, y1), min(self.v.w, x1 + w), min(self.v.h, y1 + h)
        if fx2 <= fx1 or fy2 <= fy1:
            return
        a = (alpha[fy1 - y1:fy2 - y1, fx1 - x1:fx2 - x1] / 255.0)[..., None]
        f[fy1:fy2, fx1:fx2] = (a * item[fy1 - y1:fy2 - y1, fx1 - x1:fx2 - x1] + (1 - a) * f[fy1:fy2, fx1:fx2]).astype(np.uint8)

    def post(self, f, t_frac, moving):
        v = self.v
        if v.blur and moving:
            k = np.zeros((v.blur, v.blur), np.float32)
            k[:, v.blur // 2] = 1 / v.blur  # vertical blur: things are falling
            f = cv2.filter2D(f, -1, k)
        gain = v.brightness * (1 + v.lighting_drift * np.sin(2 * np.pi * t_frac))
        f = np.clip(f.astype(np.float32) * gain + (self.rng.normal(0, v.noise, f.shape) if v.noise else 0), 0, 255).astype(np.uint8)
        if v.shake:
            dx, dy = self.rng.integers(-v.shake, v.shake + 1, 2)
            f = cv2.warpAffine(f, np.float32([[1, 0, dx], [0, 1, dy]]), (v.w, v.h), borderMode=cv2.BORDER_REPLICATE)
        if v.jpeg_quality:
            f = cv2.imdecode(cv2.imencode(".jpg", f, [cv2.IMWRITE_JPEG_QUALITY, v.jpeg_quality])[1], cv2.IMREAD_COLOR)
        return f


def _path(scene: Scene, target, hover, start_x):
    v = scene.v
    gx, top, _, rh = scene.region_px(target or hover)
    gx += scene.region_px(target or hover)[2] / 2
    carry = [(start_x + (gx - start_x) * k / 40, 120 + (top - 140 - 120) * k / 40) for k in range(41)]
    if target:
        step = (140 + 0.5 * rh) / v.fall_frames
        return carry + [(gx, top - 140 + step * k) for k in range(1, v.fall_frames + 2)], top + 0.5 * rh
    return carry + [(gx, top - 60)] * (v.fps * 2) + list(reversed(carry)), None


def make(v: Variant, photo_dir: Path, out_dir: Path) -> tuple[Path, Path]:
    """Writes <name>.mp4 and <name>.labels.jsonl; returns their paths."""
    scene = Scene(v, photo_dir)
    rnd = random.Random(v.seed)
    shots = SHOT_LIST
    if v.random_order:
        names = [n for n in CUTOUTS] + ["receipt"]
        shots = [(rnd.choice(names), rnd.choice(BINS + [None]) if rnd.random() > 0.1 else None) for _ in range(9)]
    groups = [shots[i:i + 2] for i in range(0, len(shots), 2)] if v.simultaneous else [[s] for s in shots]
    out_dir.mkdir(parents=True, exist_ok=True)
    video, labels_path = out_dir / f"{v.name}.mp4", out_dir / f"{v.name}.labels.jsonl"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), v.fps, (v.w, v.h))
    est_total = (2 + len(groups) * 5.5) * v.fps
    frames, labels, row = [], [], 0
    t = 0

    def emit(f, moving):
        nonlocal t
        writer.write(scene.post(f, t / est_total, moving)); t += 1

    for _ in range(v.fps * 2):
        f = scene.bg.copy(); scene.draw_bins(f); emit(f, False)
    for group in groups:
        paths = []
        for k, (name, target) in enumerate(group):
            hover = None if target else rnd.choice(BINS)
            p, vanish_y = _path(scene, target, hover, start_x=120 + 900 * k)
            paths.append((name, target, p, vanish_y))
        length = max(len(p) for _, _, p, _ in paths)
        done = set()
        for i in range(length):
            f = scene.bg.copy()
            occluder = None
            if v.passerby and i % 60 < 25:  # someone walks across in front of the bins now and then
                ox = int((i % 60) / 25 * v.w)
                occluder = (ox, int(v.h * 0.35), ox + int(v.w * 0.18), v.h)
            visible = []
            for name, target, p, vanish_y in paths:
                if i >= len(p):
                    continue
                cx, cy = p[i]
                if vanish_y is not None and cy > vanish_y:
                    if name not in done:
                        done.add(name)
                        row += 1
                        labels.append(labeled_event(row=row, clip_id=v.name, camera_id="cam_patio_1", started_at=datetime(2026, 10, 17, tzinfo=UTC),
                                                    offset_s=(t) / v.fps, bin_id=target,
                                                    catalog_item_id=CUTOUTS[name][2] if name in CUTOUTS else None, business_id=None))
                    continue
                visible.append((name, cx, cy))
            for name, cx, cy in visible:
                scene.paste(f, name, cx, cy)
            scene.draw_bins(f)
            for name, cx, cy in visible:  # above the bin front: draw again over it
                if cy < scene.region_px(BINS[0])[1] + scene.region_px(BINS[0])[3] / 3:
                    scene.paste(f, name, cx, cy)
            if occluder:
                cv2.rectangle(f, occluder[:2], occluder[2:], (90, 80, 140), -1)
            emit(f, moving=True)
        for _ in range(v.fps * 3):
            f = scene.bg.copy(); scene.draw_bins(f); emit(f, False)
    writer.release()
    labels_path.write_text("".join(dumps_event(e) + "\n" for e in labels))
    return video, labels_path
