"""Item tracker: know every object a PERSON brings into view, then decide which one went into a bin.

Used by `recyclone-worker run --tracker items` and by scripts/item_tracker.py (dev-clip evaluation + videos).

Stage 1, perception (slow, ~2 fps on an M-series Mac; cached per video so a clip is analyzed once):
  - FastSAM proposes class-agnostic regions ("there is a thing here"); no object classes from YOLO.
  - CLIP embeds every region; CLIP alone decides item vs background (wall, floor, person, bin, ...).
  - YOLO11n-pose gives the skeleton; the hand crop past each wrist is also a proposal.
  - Camera motion (optical flow + RANSAC) per frame, for a hand-held or moving camera.
Stage 2, logic (under a second, but needs the whole clip: the veto looks 1.5 s ahead):
  - Item regions become tracks (appearance + camera-corrected position).
  - The skeleton's arms decide what counts: each hand holds at most one object per frame; a track held for a
    few frames was brought by a person. Posters, furniture and bin contents are never "carried".
  - When the arm leaves view, a track that looks like a carried item and never coexists with it is re-found.
  - Items first seen inside a bin box are its existing contents and are never counted as a drop.
  - A carried item that vanishes inside a bin box, or comes to rest there, is a drop into that bin.
"""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from .categories import ITEM_PROMPTS
from .site import CONTRACTS

WORKER = Path(__file__).resolve().parents[1]
CATALOG = {i["catalog_item_id"]: i for i in json.loads((CONTRACTS / "fixtures/demo-site.json").read_text())["catalog"]}
BACKGROUND = ["a wall", "a wooden wall panel", "a floor", "a wooden floor", "a ceiling", "a ceiling light", "a window", "a door",
              "a person", "a face", "a man's head", "a sweater", "a knit sleeve", "pants", "a shoe", "an arm", "a hand",
              "a trash can", "a garbage bin", "the dark opening of a trash can", "a plastic bin liner", "a wall disposal slot",
              "a chair", "a table", "a poster on a wall", "a framed painting", "a shadow", "a blurry background"]
SKELETON = [(5, 7), (7, 9), (6, 8), (8, 10), (5, 6), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (0, 5), (0, 6)]
MIN_AREA, MAX_AREA = 0.0015, 0.12   # region size as a share of the frame
ITEM_P = 0.5                        # P(item) from CLIP needed to keep a region as an item
MATCH_IOU, MATCH_SIM = 0.25, 0.85   # association: same look AND (overlap or near the camera-corrected spot)
MAX_GROWTH = 2.0                    # association: a box that more than doubles (or halves) in area from one frame
                                    #   to the next is another region, not the same object (17 Oct, IMG_9097)
LOST_AFTER = 8                      # frames unseen before a track counts as gone
WINDOW = 10                         # frames over which an item's own motion is measured
OWN_MOTION = 0.6                    # an item that moves less than half this on its own is at rest ("left in bin")
HAND_REACH = 1.3                    # hand region = hand crop grown by 30%
TOUCH = 0.5                         # an item touches a hand when half of the smaller of the two boxes overlaps the other
PART_OF = 0.7                       # a region this much inside another, similar-confidence one is a part of it
ATTACH_MIN = 3                      # frames as the object in a hand before an item counts as brought by a person
REID_SIM = 0.93                     # a track that starts where a carried item was last seen, looking like it,
REID_GAP = 30                       #   within 1 s, continues that item (the arm may be out of view by then)
MAIN_SHARE = 0.2                    # an object must be held >= 20% as long as the most-held object to count
STILL_MIN = 6                       # observations at rest inside a bin before "left in bin"
VETO_FRAMES = 45                    # the item back in a hand, outside every bin, within 1.5 s: not a drop
MERGE_FRAMES = 45                   # drops into one bin within 1.5 s are one drop (fragments of one item, or the hand)
BIN_MARGIN = 0.10
MIN_VOTES = 1e-3                    # category vote mass below this: item unknown


# ---------------------------------------------------------------- stage 1: perception (cached)

def weight(rel: str) -> Path:
    """Model weights live in worker/weights/ (not in git); any that are missing are downloaded on first run."""
    p = WORKER / "weights" / rel
    if not p.exists():
        p.parent.mkdir(parents=True, exist_ok=True)
        if rel.startswith("clip/"):
            import clip

            clip.load("ViT-B/32", device="cpu", download_root=str(p.parent))  # saves ViT-B-32.pt there
        else:
            from ultralytics.utils.downloads import attempt_download_asset

            attempt_download_asset(str(p))
    return p


def keyframe_boxes(spec: dict, n: int) -> list:
    kf = sorted((int(f), b) for f, b in spec["keyframes"])
    lo, hi = spec.get("visible", [kf[0][0], kf[-1][0]])
    out = [None] * n
    for i in range(max(0, lo), min(n, hi + 1)):
        prev = max((k for k in kf if k[0] <= i), default=kf[0], key=lambda k: k[0])
        nxt = min((k for k in kf if k[0] >= i), default=kf[-1], key=lambda k: k[0])
        a = 0.0 if nxt[0] == prev[0] else (i - prev[0]) / (nxt[0] - prev[0])
        out[i] = tuple((1 - a) * p + a * q for p, q in zip(prev[1], nxt[1]))
    return out


def hand_box(kp, side: str, w: int, h: int):
    e, wr = (7, 9) if side == "L" else (8, 10)
    if kp[wr][2] < 0.3 or kp[e][2] < 0.2:
        return None
    ex, ey, wx, wy = kp[e][0], kp[e][1], kp[wr][0], kp[wr][1]
    fore = max(60.0, float(np.hypot(wx - ex, wy - ey)))
    cx, cy, s = wx + 0.35 * (wx - ex), wy + 0.35 * (wy - ey), 0.6 * fore
    b = (max(0, cx - s), max(0, cy - s), min(w, cx + s), min(h, cy + s))
    return b if b[2] - b[0] > 20 and b[3] - b[1] > 20 else None


class Clip:
    """Batched CLIP image/text embeddings (the package's ClipEmbedder embeds one image at a time)."""

    def __init__(self, weights: Path):
        import clip
        import torch
        from PIL import Image

        self.torch, self.Image, self.clip = torch, Image, clip
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        self.model, self.pre = clip.load(str(weights), device=self.device)

    def images(self, crops: list[np.ndarray]) -> np.ndarray:
        if not crops:
            return np.zeros((0, 512), np.float32)
        x = self.torch.stack([self.pre(self.Image.fromarray(c[:, :, ::-1])) for c in crops]).to(self.device)
        with self.torch.no_grad():
            v = self.model.encode_image(x).float().cpu().numpy()
        return v / np.linalg.norm(v, axis=1, keepdims=True)

    def texts(self, texts: list[str]) -> np.ndarray:
        with self.torch.no_grad():
            t = self.model.encode_text(self.clip.tokenize(texts).to(self.device)).float().cpu().numpy()
        return t / np.linalg.norm(t, axis=1, keepdims=True)


def perceive(video: Path, cache: Path, sam, pose, clip, min_area: float = MIN_AREA) -> dict:
    """Per frame: candidate boxes (FastSAM + hand crops), their CLIP embeddings, and the main skeleton."""
    if cache.exists():
        return dict(np.load(cache))
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    boxes, src, emb, kps = [], [], [], []
    i = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        h, w = f.shape[:2]
        r = sam.predict(f, device="mps", imgsz=1024, conf=0.25, iou=0.7, verbose=False)[0]
        cand = []
        for b in r.boxes.xyxy.cpu().numpy().tolist():
            a = (b[2] - b[0]) * (b[3] - b[1]) / (w * h)
            if min_area <= a <= MAX_AREA and max(b[2] - b[0], b[3] - b[1]) / max(1, min(b[2] - b[0], b[3] - b[1])) < 5:
                cand.append((b, 0))
        p = pose.predict(f, imgsz=960, device="mps", verbose=False, conf=0.3)[0]
        kp = np.zeros((17, 3), np.float32)
        if p.keypoints is not None and len(p.keypoints):
            areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in p.boxes.xyxy.tolist()]
            kp = p.keypoints.data.cpu().numpy()[int(np.argmax(areas))]
        for side in ("L", "R"):
            hb = hand_box(kp, side, w, h)
            if hb:
                cand.append((list(hb), 1 if side == "L" else 2))
        crops = []
        for b, _ in cand:
            pw, ph = 0.12 * (b[2] - b[0]) + 8, 0.12 * (b[3] - b[1]) + 8
            x0, y0, x1, y1 = int(max(0, b[0] - pw)), int(max(0, b[1] - ph)), int(min(w, b[2] + pw)), int(min(h, b[3] + ph))
            crops.append(f[y0:y1, x0:x1])
        e = clip.images(crops)
        for (b, s), v in zip(cand, e):
            boxes.append([i, *b]); src.append(s); emb.append(v.astype(np.float16))
        kps.append(kp)
        i += 1
        if i % 50 == 0:
            print(f"  {cache.stem}: {i} frames", flush=True)
    data = {"boxes": np.array(boxes, np.float32).reshape(-1, 5), "src": np.array(src, np.int8),
            "emb": np.array(emb, np.float16).reshape(-1, 512), "kps": np.array(kps, np.float32), "fps": np.float32(fps),
            "size": np.array([w, h])}
    np.savez_compressed(cache, **data)
    return data


# ---------------------------------------------------------------- stage 2: logic

def iou(a, b) -> float:
    ix, iy = max(0, min(a[2], b[2]) - max(a[0], b[0])), max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


def center(b):
    return ((b[0] + b[2]) / 2, (b[1] + b[3]) / 2)


def in_box(pt, box, margin=BIN_MARGIN) -> bool:
    if box is None:
        return False
    mx, my = (box[2] - box[0]) * margin, (box[3] - box[1]) * margin
    return box[0] - mx <= pt[0] <= box[2] + mx and box[1] - my <= pt[1] <= box[3] + my


class Scorer:
    """CLIP zero-shot: P(item) vs background, and the item's category (bin rule comes from the catalog)."""

    def __init__(self, clip):
        self.cats = list(ITEM_PROMPTS)
        flat = [(c, p) for c in self.cats for p in ITEM_PROMPTS[c]]
        self.item_owner = np.array([self.cats.index(c) for c, _ in flat])
        self.item_text = clip.texts([p for _, p in flat])
        self.bg_text = clip.texts(BACKGROUND)

    def __call__(self, emb: np.ndarray):
        e = emb.astype(np.float32)
        si, sb = e @ self.item_text.T, e @ self.bg_text.T
        per_cat = np.full((len(e), len(self.cats)), -1.0, np.float32)
        for k in range(len(self.cats)):
            per_cat[:, k] = si[:, self.item_owner == k].max(1)
        logits = 100 * np.concatenate([per_cat, sb], 1)
        p = np.exp(logits - logits.max(1, keepdims=True))
        p /= p.sum(1, keepdims=True)
        p_item = p[:, :len(self.cats)].sum(1)
        return p_item, p[:, :len(self.cats)]


def ego_motion(video: Path, cache: Path) -> np.ndarray:
    """Camera motion: one 2x3 affine per frame mapping frame i-1 coordinates to frame i (identity for frame 0).

    Sparse optical flow on a quarter-size grey frame + RANSAC, so the person and the item (a minority of
    the points) do not drag it. Lets the tracker tell "moves with the scene" (a poster) from "moves on its
    own" (an item in a hand), even when the phone itself is moving."""
    if cache.exists():
        return np.load(cache)
    cap = cv2.VideoCapture(str(video))
    out, prev, s = [np.array([[1, 0, 0], [0, 1, 0]], np.float32)], None, 0.25
    while True:
        ok, f = cap.read()
        if not ok:
            break
        g = cv2.cvtColor(cv2.resize(f, None, fx=s, fy=s), cv2.COLOR_BGR2GRAY)
        if prev is not None:
            a = None
            pts = cv2.goodFeaturesToTrack(prev, 400, 0.01, 8)
            if pts is not None and len(pts) >= 12:
                nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, g, pts, None)
                good = st.ravel() == 1
                if good.sum() >= 12:
                    a, _ = cv2.estimateAffinePartial2D(pts[good], nxt[good], method=cv2.RANSAC, ransacReprojThreshold=2.0)
            if a is None:
                a = np.array([[1, 0, 0], [0, 1, 0]], np.float64)
            a = a.astype(np.float32)
            a[:, 2] /= s  # translation back to full-resolution pixels
            out.append(a)
        prev = g
    m = np.array(out, np.float32)
    np.save(cache, m)
    return m


def warp(pt, a):
    return (a[0, 0] * pt[0] + a[0, 1] * pt[1] + a[0, 2], a[1, 0] * pt[0] + a[1, 1] * pt[1] + a[1, 2])


def carry(pt, motion, f0, f1):
    """Where a point that is fixed in the scene at frame f0 appears at frame f1."""
    for g in range(f0 + 1, f1 + 1):
        pt = warp(pt, motion[g])
    return pt


def warp_box(b, motion, f0, f1):
    (cx, cy), w, h = center(b), b[2] - b[0], b[3] - b[1]
    cx, cy = carry((cx, cy), motion, f0, f1)
    return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]


def track(data: dict, bins: dict, scorer: Scorer, motion: np.ndarray) -> tuple[list[dict], list[list]]:
    """Frame-to-frame association of item regions into tracks; the previous box is first moved by the camera motion."""
    n = len(data["kps"])
    p_item, p_cat = scorer(data["emb"]) if len(data["emb"]) else (np.zeros(0), np.zeros((0, 1)))
    by_frame = [[] for _ in range(n)]
    for k, row in enumerate(data["boxes"]):
        by_frame[int(row[0])].append(k)
    tracks, live = [], []
    per_frame = [[] for _ in range(n)]

    def vote(k, b, i):  # category evidence: confident looks outside every bin count, bin-interior looks do not
        outside = not any(in_box(center(b), boxes[i]) for boxes in bins.values())
        return p_cat[k] * (p_item[k] if outside and p_item[k] >= 0.8 else 0.0)

    for i in range(n):
        cands = sorted((k for k in by_frame[i] if p_item[k] >= ITEM_P), key=lambda k: -p_item[k])
        kept = []
        for k in cands:  # one region per object: drop regions mostly covered by a more confident one
            if all(iou(data["boxes"][k][1:], data["boxes"][j][1:]) < 0.5 for j in kept):
                kept.append(k)
        pairs = []
        for t in live:
            pred = warp_box(t["box"], motion, t["last"], i)
            diag = np.hypot(pred[2] - pred[0], pred[3] - pred[1])
            for k in kept:
                b = data["boxes"][k][1:]
                sim = float(t["emb"] @ data["emb"][k].astype(np.float32))
                o = iou(pred, b)
                c0, c1 = center(pred), center(b)
                near = np.hypot(c0[0] - c1[0], c1[1] - c0[1]) < 0.6 * diag * (1 + 0.25 * (i - t["last"] - 1))
                grow = max(1.0, (b[2] - b[0]) * (b[3] - b[1])) / max(1.0, (pred[2] - pred[0]) * (pred[3] - pred[1]))
                if sim >= MATCH_SIM and (o >= MATCH_IOU or near) and 1 / MAX_GROWTH <= grow <= MAX_GROWTH:
                    pairs.append((o + sim, t["id"], k))
        used = set()
        for _, tid, k in sorted(pairs, reverse=True):
            t = tracks[tid]
            if k in used or t["last"] == i:
                continue
            used.add(k)
            b = data["boxes"][k][1:]
            e = data["emb"][k].astype(np.float32)
            t["box"], t["last"] = b, i
            t["emb"] = 0.8 * t["emb"] + 0.2 * e
            t["emb"] /= np.linalg.norm(t["emb"])
            t["sum_emb"] += e
            t["frames"].append(i); t["boxes"].append(b.tolist()); t["cat"] += vote(k, b, i); t["src"].append(int(data["src"][k]))
            per_frame[i].append((tid, b, float(p_item[k])))
        for k in kept:
            if k in used:
                continue
            b = data["boxes"][k][1:]
            e = data["emb"][k].astype(np.float32)
            t = {"id": len(tracks), "box": b, "last": i, "emb": e.copy(), "sum_emb": e.copy(), "frames": [i],
                 "boxes": [b.tolist()], "cat": vote(k, b, i) + 1e-6, "src": [int(data["src"][k])]}
            tracks.append(t)
            live.append(t)
            per_frame[i].append((t["id"], b, float(p_item[k])))
        live = [t for t in live if i - t["last"] <= LOST_AFTER]
    for t in tracks:
        # no confident look outside every bin -> no category (argmax of all-equal votes would name cats[0])
        t["category"] = scorer.cats[int(np.argmax(t["cat"]))] if t["cat"].sum() >= MIN_VOTES else None
        t["cats"] = scorer.cats
        t["appearance"] = t["sum_emb"] / np.linalg.norm(t["sum_emb"])
        del t["emb"], t["box"], t["sum_emb"]
    return tracks, per_frame


def own_motion(t: dict, motion: np.ndarray) -> list[float]:
    """Per observation: how far (in box diagonals) the item moved on its own over the last ~WINDOW frames,
    i.e. after removing the camera motion. ~0 for scenery and for an item lying in a bin."""
    out = []
    for k, (f, b) in enumerate(zip(t["frames"], t["boxes"])):
        j = k
        while j > 0 and f - t["frames"][j - 1] <= WINDOW:
            j -= 1
        if j == k:
            out.append(0.0)
            continue
        f0, b0 = t["frames"][j], t["boxes"][j]
        px, py = carry(center(b0), motion, f0, f)
        cx, cy = center(b)
        diag = np.hypot(b[2] - b[0], b[3] - b[1])
        out.append(float(np.hypot(cx - px, cy - py) / diag))
    return out


def wrists(kp) -> list:
    return [(kp[j][0], kp[j][1]) for j in (9, 10) if kp[j][2] >= 0.3]


def hand_regions(kp, w: int, h: int) -> list:
    """Per visible arm: (side, region where a held object can be, wrist point). The region is the hand crop
    (past the wrist along elbow->wrist) grown by HAND_REACH, so it follows the skeleton's forearm."""
    out = []
    for side, wr in (("L", 9), ("R", 10)):
        hb = hand_box(kp, side, w, h)
        if hb is None:
            continue
        cx, cy = center(hb)
        s = (hb[2] - hb[0]) * HAND_REACH / 2
        out.append((side, (cx - s, cy - s, cx + s, cy + s), (float(kp[wr][0]), float(kp[wr][1]))))
    return out


def inside_share(b, region) -> float:
    """Share of the item box that lies inside the hand region."""
    ix = max(0, min(b[2], region[2]) - max(b[0], region[0]))
    iy = max(0, min(b[3], region[3]) - max(b[1], region[1]))
    return ix * iy / max(1e-9, (b[2] - b[0]) * (b[3] - b[1]))


def hold_share(region, cands, crop_only):
    """Before 17 Oct: the region most inside the hand region (>= half of the ITEM inside it), hand-crop-only tracks
    weighted 0.6. Measured on 39 hand-checked frames: the held box matched the item (IoU >= 0.5) in only 10."""
    best, best_score = None, 0.0
    for tid, b, p, _ in cands:
        share = inside_share(b, region)
        if share < 0.5:
            continue
        score = p * share * (0.6 if tid in crop_only else 1.0)
        if score > best_score:
            best, best_score = tid, score
    return best


def overlap_small(a, b) -> float:
    """Intersection over the SMALLER box's area: 1.0 when one box lies inside the other, whatever their sizes."""
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return ix * iy / max(1e-9, min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])))


def hold_touch(region, cands, crop_only):
    """The object a hand holds, from this frame's item regions (tid, box, p_item, src); src 0 = segmented region.

    1. Touch: half of the smaller box (item or hand region) overlaps the other, so an item bigger than the hand counts.
    2. A real segmented region beats the synthetic hand crop; the crop is used only when nothing segmented touches.
    3. A part (lid, logo) mostly inside a similar-confidence, not much bigger region gives way to the whole object.
    Measured 17 Oct on 39 hand-checked frames of the 5 dev clips: held box at IoU >= 0.5 in 16 (was 10)."""
    c = [x for x in cands if overlap_small(x[1], region) >= TOUCH]
    if any(x[3] == 0 for x in c):
        c = [x for x in c if x[3] == 0]
    area = lambda b: max(1.0, (b[2] - b[0]) * (b[3] - b[1]))  # noqa: E731
    whole = [a for a in c if not any(o is not a and inside_share(a[1], o[1]) >= PART_OF and o[2] >= a[2] - 0.1
                                     and area(o[1]) <= 8 * area(a[1]) for o in c)]
    best = max(whole, key=lambda x: x[2] * overlap_small(x[1], region), default=None)
    return best[0] if best else None


HOLD_RULE = hold_touch


def decide(tracks: list[dict], data: dict, bins: dict, fps: float, motion: np.ndarray, per_frame: list) -> tuple[list[dict], dict]:
    """Only objects BROUGHT BY A PERSON count. The skeleton's arm decides which those are:

    1. Each frame, each visible hand holds at most ONE object: the item region that sits most inside the hand
       region (past the wrist along the forearm). Hand-crop proposals lose to a real segmented region.
    2. A track that was the object in a hand for >= ATTACH_MIN frames is "carried": a person brought it in.
    3. Held tracks that are parts of one object (nested boxes) or hand over from one to the next are ONE item.
       Only items held for a real share of the time count, so a person brings one or a few objects.
    4. Later the arm may be out of view (only a sleeve over the bin). A track that starts where a carried item
       was last seen, shortly after and looking the same, or nests inside it, is that item "re-found".
    5. Everything else is ignored, except items first seen inside a bin ("already in bin", its contents).
    A carried item ends in a bin when its last sighting is inside the bin box ("vanished in bin"), or it stays
    there at the end and has stopped moving on its own ("left in bin")."""
    n = len(data["kps"])
    w, h = (int(v) for v in data["size"])
    by_id = {t["id"]: t for t in tracks}
    crop_only = {t["id"] for t in tracks if all(s > 0 for s in t["src"])}
    held, links = {}, [[] for _ in range(n)]
    src_at = {(t["id"], f): s for t in tracks for f, s in zip(t["frames"], t["src"])}
    for i in range(n):
        for side, region, wrist in hand_regions(data["kps"][i], w, h):
            best = HOLD_RULE(region, [(tid, b, p, src_at[(tid, i)]) for tid, b, p in per_frame[i]], crop_only)
            if best is not None:
                held[best] = held.get(best, 0) + 1
                links[i].append((side, best, wrist))
    direct = {tid for tid, k in held.items() if k >= ATTACH_MIN}

    def first_in_bin(t):
        where = [any(in_box(center(b), boxes[f]) for boxes in bins.values()) for f, b in zip(t["frames"], t["boxes"])]
        return where[0] and sum(not x for x in where) <= 1

    boxes_at = {t["id"]: dict(zip(t["frames"], t["boxes"])) for t in tracks}

    def nested(a, b) -> int:  # frames where one box lies mostly inside the other: parts of one object
        common = set(boxes_at[a]) & set(boxes_at[b])
        return sum(max(inside_share(boxes_at[a][f], boxes_at[b][f]), inside_share(boxes_at[b][f], boxes_at[a][f])) >= 0.5 for f in common)

    def area(b):
        return max(1.0, (b[2] - b[0]) * (b[3] - b[1]))

    def same_size(a, b) -> bool:  # a region 3x bigger than the item is the hand or arm around it, not the item
        ra = np.median([area(x) for x in by_id[a]["boxes"]])
        rb = np.median([area(x) for x in by_id[b]["boxes"]])
        return 1 / 3 <= ra / rb <= 3

    def follows(prev, nxt) -> bool:  # nxt starts where prev was last seen (camera-corrected), shortly after
        p, q = by_id[prev], by_id[nxt]
        gap = q["frames"][0] - p["frames"][-1]
        if not 0 < gap <= REID_GAP:
            return False
        pb, qb = p["boxes"][-1], q["boxes"][0]
        px, py = carry(center(pb), motion, p["frames"][-1], q["frames"][0])
        return np.hypot(center(qb)[0] - px, center(qb)[1] - py) <= 2 * np.hypot(pb[2] - pb[0], pb[3] - pb[1])

    parent = {tid: tid for tid in direct}

    def root(x):
        while parent[x] != x:
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = root(a), root(b)
        if ra != rb:
            parent[max(ra, rb)] = min(ra, rb)

    for a in direct:  # held at the same time, one inside the other, similar size: parts of one object
        for b in direct:
            if a < b and same_size(a, b) and nested(a, b) >= 2:
                union(a, b)

    def prototypes():  # an item's look = its held tracks' looks, weighted by how long each was held
        acc = {}
        for tid in direct:
            acc[root(tid)] = acc.get(root(tid), 0) + held[tid] * by_id[tid]["appearance"]
        return {r: v / np.linalg.norm(v) for r, v in acc.items()}

    proto = prototypes()
    for a in sorted(direct, key=lambda t: by_id[t]["frames"][0]):  # handed on from one track to the next
        for b in sorted(direct, key=lambda t: by_id[t]["frames"][0]):
            if root(a) != root(b) and follows(a, b) and same_size(a, b) and float(proto[root(a)] @ proto[root(b)]) >= REID_SIM:
                union(a, b)
                proto = prototypes()
    held_frames = {}
    for i in range(n):
        for _, tid, _ in links[i]:
            if tid in direct:
                held_frames.setdefault(root(tid), set()).add(i)
    top = max((len(v) for v in held_frames.values()), default=0)
    # "singular (few)": an object counts as brought by a person only if a hand held it for a real share of the
    # time the main object was held; a sleeve or finger that wins a hand for a few frames does not
    items = {r for r, v in held_frames.items() if len(v) >= max(ATTACH_MIN, MAIN_SHARE * top)}
    identity = {tid: root(tid) for tid in direct if root(tid) in items and float(proto[root(tid)] @ by_id[tid]["appearance"]) >= REID_SIM}
    roles = {tid: "carried" for tid in identity}
    for t in sorted(tracks, key=lambda t: t["frames"][0]):  # time order, so a chain of fragments is followed
        if t["id"] in roles or len(t["frames"]) < 3:
            continue
        if first_in_bin(t):
            roles[t["id"]] = "already in bin"
            continue
        for oid in list(identity):
            iid = identity[oid]
            if same_size(oid, t["id"]) and (follows(oid, t["id"]) or nested(oid, t["id"]) >= 2) \
                    and float(proto[iid] @ t["appearance"]) >= REID_SIM:
                identity[t["id"]] = iid
                roles[t["id"]] = "re-found"
                break
    for t in tracks:
        roles.setdefault(t["id"], "ignored")
    cand = []
    for t in tracks:
        if roles[t["id"]] not in ("carried", "re-found"):
            continue
        fr, bx = t["frames"], t["boxes"]
        where = []
        for f, b in zip(fr, bx):
            hit = [bid for bid, boxes in bins.items() if in_box(center(b), boxes[f])]
            where.append(hit[0] if hit else None)
        if where[-1] is None:
            continue
        mv = own_motion(t, motion)
        bid = where[-1]
        k0 = len(where) - 1
        while k0 > 0 and where[k0 - 1] == bid:
            k0 -= 1
        f_last = fr[-1]
        bin_after = any(bins[bid][g] is not None for g in range(f_last + 1, min(n, f_last + LOST_AFTER + 1)))
        if f_last < n - LOST_AFTER and bin_after:
            cand.append({"frame": int(f_last), "how": "vanished in bin", "bin": bid, "track": t})
        else:
            still = [k for k in range(k0, len(fr)) if mv[k] < OWN_MOTION / 2]
            if len(still) >= STILL_MIN:
                cand.append({"frame": int(fr[still[0]]), "how": "left in bin", "bin": bid, "track": t})
    # veto: shortly after, a hand holds the same item again (outside every bin) -> it was never let go
    kept = []
    for c in cand:
        cid = identity[c["track"]["id"]]
        back = [f for f in range(c["frame"] + 1, min(n, c["frame"] + VETO_FRAMES + 1)) for _, tid, _ in links[f]
                if identity.get(tid) == cid and not any(in_box(center(boxes_at[tid][f]), bx[f]) for bx in bins.values())]
        if not back:
            kept.append(c)
    # one drop seen through several tracks of the same item (or within 1.5 s into the same bin) is one drop
    kept.sort(key=lambda c: c["frame"])
    groups = []
    for c in kept:
        if groups and groups[-1][-1]["bin"] == c["bin"] and c["frame"] - groups[-1][-1]["frame"] <= MERGE_FRAMES:
            groups[-1].append(c)
        else:
            groups.append([c])
    events = []
    for g in groups:
        best = max(g, key=lambda c: len(c["track"]["frames"]))
        t = by_id[identity[best["track"]["id"]]]  # the item as it was held: its category votes are the cleanest
        f = max(c["frame"] for c in g) if best["how"] == "vanished in bin" else best["frame"]
        events.append({"frame": f, "t": round(f / fps, 2), "bin": best["bin"], "item_id": identity[best["track"]["id"]],
                       "track": best["track"]["id"], "item": t["category"], "item_bin_rule": CATALOG.get(t["category"], {}).get("destination"),
                       "how": best["how"], "held_frames": held.get(t["id"], 0), "fragments": len(g)})
    data["_links"], data["_identity"] = links, identity
    data["_debug"] = {"candidates": [(c["frame"], c["track"]["id"], c["how"]) for c in cand], "kept": [(c["frame"], c["track"]["id"]) for c in kept]}
    return events, roles


# ---------------------------------------------------------------- package API (recyclone-worker run --tracker items)

CONFIDENCE_WINDOW = 10              # last sightings of the item used for destination_confidence


@dataclass
class Analysis:
    """Everything `run` needs to play a clip back: per-frame tracker output and the decided drops."""

    data: dict
    bins: dict          # bin_id -> per-frame pixel box (or None where the bin is out of view)
    tracks: list[dict]
    per_frame: list     # frame -> [(track_id, box, p_item)]
    roles: dict         # track_id -> carried | re-found | already in bin | ignored
    events: list[dict]  # decide()'s drops, sorted by frame

    @property
    def identity(self) -> dict:
        return self.data["_identity"]


def site_bin_boxes(regions, size: tuple[int, int], n: int) -> dict:
    """A fixed camera's bin openings (normalized, from the site fixture) as the per-frame pixel boxes decide() uses."""
    w, h = size
    out = {}
    for r in regions:
        x, y, rw, rh = r.to_pixels(w, h)
        out[r.bin_id] = [(x, y, x + rw, y + rh)] * n
    return out


def cache_key(video: Path) -> str:
    """Re-analyze when the file changes (name, size or modification time), not on every run."""
    st = Path(video).stat()
    return hashlib.sha256(f"{Path(video).resolve()}|{st.st_size}|{st.st_mtime_ns}".encode()).hexdigest()[:12]


def analyze(video: Path, cache_dir: Path, bins_for, *, min_area: float = MIN_AREA, models=None) -> Analysis:
    """Run both stages on a whole clip. `bins_for(size, n)` gives the bin boxes once the frame size is known.
    Perception is cached in cache_dir; `models` = (sam, pose, clip) to reuse loaded models (loaded lazily otherwise)."""
    video, cache_dir = Path(video), Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{video.stem}-{cache_key(video)}"
    perception = cache_dir / f"{stem}.npz"
    sam, pose, clip = models or (None, None, None)
    if clip is None:
        clip = Clip(weight("clip/ViT-B-32.pt"))
    if not perception.exists() and sam is None:
        from ultralytics import YOLO, FastSAM

        sam, pose = FastSAM(str(weight("FastSAM-s.pt"))), YOLO(str(weight("yolo11n-pose.pt")))
    data = perceive(video, perception, sam, pose, clip, min_area)
    n = len(data["kps"])
    bins = bins_for(tuple(int(v) for v in data["size"]), n)
    motion = ego_motion(video, cache_dir / f"{stem}_motion.npy")
    tracks, per_frame = track(data, bins, Scorer(clip), motion)
    events, roles = decide(tracks, data, bins, float(data["fps"]), motion, per_frame)
    return Analysis(data, bins, tracks, per_frame, roles, sorted(events, key=lambda e: e["frame"]))


def item_from_votes(track: dict, top_k: int = 3) -> dict:
    """The contract `item` object from a held track's category votes (CLIP zero-shot probabilities, summed over
    confident looks outside every bin). Raw scores, no threshold (contract §6); no votes -> unknown."""
    votes = np.asarray(track["cat"], np.float64)
    if track.get("category") is None or votes.sum() < MIN_VOTES:
        return {"catalog_item_id": None, "label": None, "confidence": None, "candidates": []}
    p = votes / votes.sum()
    order = np.argsort(-p)[:top_k]
    candidates = [{"catalog_item_id": track["cats"][k], "score": round(float(min(max(p[k], 0.0), 1.0)), 4)} for k in order]
    top = candidates[0]["catalog_item_id"]
    label = ITEM_PROMPTS[top][0] if top in ITEM_PROMPTS else None
    return {"catalog_item_id": top, "label": label, "confidence": candidates[0]["score"], "candidates": candidates}


def destination_confidence(analysis: Analysis, drop: dict) -> float:
    """Share of the item's last sightings (all its tracks, up to the drop) that lie inside the chosen bin box.

    A plain, explainable heuristic, not a calibrated probability: an item that was over the opening for its
    whole final approach scores 1.0; one that only touched the box edge on its last frame scores low."""
    iid, bid = drop["item_id"], drop["bin"]
    sightings = sorted((f, b) for t in analysis.tracks if analysis.identity.get(t["id"]) == iid
                       for f, b in zip(t["frames"], t["boxes"]) if f <= drop["frame"])[-CONFIDENCE_WINDOW:]
    if not sightings:
        return 0.0
    inside = sum(in_box(center(b), analysis.bins[bid][f]) for f, b in sightings)
    return round(inside / len(sightings), 4)


def item_box_at(analysis: Analysis, drop: dict) -> tuple[int, list] | None:
    """The item's last sighting at or before the drop frame: (frame, box), for the evidence crop."""
    iid = drop["item_id"]
    seen = [(f, b) for t in analysis.tracks if analysis.identity.get(t["id"]) == iid
            for f, b in zip(t["frames"], t["boxes"]) if f <= drop["frame"]]
    return max(seen, key=lambda s: s[0]) if seen else None
