"""Did the item go into the right bin? Annotated-video check for test footage.

Reuses the worker (YOLO11n + ByteTrack settings, CLIP prompts, throw_score) and adds:

  * setup: outline each bin opening on one frame and say what type it is (what a fixed camera gets
    in demo-site.json); camera-motion compensation keeps that outline aligned if the camera moves.
  * item lifecycle: every tracked item has a live, per-frame identity (CLIP on each crop, combined over
    its best views) and ends as DEPOSITED, LEFT, LOST or PARKED instead of on a fixed timeout.
  * re-ID: a new track whose CLIP vector matches a recently lost item is the same item.
  * hand-area identification (--hands, experimental, off by default): crop around each hand every
    frame; CLIP decides empty vs holding and what is held. 17 Oct test: the crops find the held item,
    but zero-shot CLIP calls 97% of hand crops "holding" (empty hands ~0.9), so it adds junk items.
    It needs a small trained empty/holding classifier before it can be on by default.
  * opening watcher: each opening goes CLEAR -> OCCUPIED -> decided. A deposit is decided only once the
    opening is clear again (no wrist over it, picture stable), from three signals: the item's path ended
    at the opening, it did not come back out, and something new is visible inside.

Nothing here is tuned to a particular clip. Every parameter is in RULES, chosen before testing.

    python tools/bincheck/bincheck.py setup VIDEO --at 9.4 --out setup.json   # click the openings
    python tools/bincheck/bincheck.py run setup.json --out result.mp4
    python tools/bincheck/bincheck.py reel a.mp4 b.mp4 --out reel.mp4
"""

import argparse
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

WORKER = Path(__file__).resolve().parents[2] / "worker"
sys.path.insert(0, str(WORKER))
from recyclone_worker.categories import CategoryClassifier  # noqa: E402
from recyclone_worker.entry import throw_score  # noqa: E402
from recyclone_worker.tracking import is_item_class  # noqa: E402

CATALOG = WORKER.parent / "contracts" / "fixtures" / "demo-site.json"

RULES = {
    # from core's demo profile / the worker
    "item_confidence_threshold": 0.5,   # demo-site.json config_profiles.demo
    "min_entry_score": 0.5,             # entered_bin() default, used for the "path" signal
    # proposals from the 17 Oct clip review
    "conflict_margin": 0.25,            # top-2 in different bins and closer than this -> unassessable
    "max_box_frac": 0.25,               # a box over 25% of the frame is not a disposed item
    "best_crops": 8,                    # identity from the sharpest, largest views
    "settle_updates": 10,               # label is "settled" after the top guess holds this many updates
    # item lifecycle
    "lost_after_frames": 5,             # unseen this long -> decide how it disappeared
    "edge_frac": 0.06,                  # last seen this close to the frame border -> LEFT
    "reid_cos": 0.85,                   # CLIP cosine to call a new track the same item (random litter ~0.71)
    "reid_window_frames": 150,          # a lost item can be revived for 5 s
    "young_obs": 5,                     # a new track can still be merged during its first 5 detections
    "chain_gap_frames": 15,             # position-based rejoin: restart within 0.5 s ...
    "chain_dist_frac": 0.15,            # ... and 15% of the frame diagonal
    "park_frames": 90,                  # still for 3 s outside an opening -> PARKED
    "park_move_frac": 0.02,
    "at_opening_wait_frames": 90,       # vanished at an opening but no watcher decision in 3 s -> path only
    # opening watcher (half-resolution grey, aligned to the reference frame)
    "diff_thr": 30,                     # grey-level change that counts as different (after blur)
    "occ_frac": 0.08,                   # this fraction of the opening changed -> OCCUPIED
    "stable_frac": 0.05,                # frame-to-frame change below this -> picture is stable
    "stable_frames": 10,                # stable (and no wrist) this long -> clear again
    "residual_max": 0.5,                # more than half the opening changed -> hand still there, keep waiting
    "blob_min_frac": 0.01,              # new-object blob at least 1% of the opening
    "confirm_frames": 15,               # wait 0.5 s after clear for the item to reappear before deciding
    "max_occupied_frames": 300,         # 10 s without clearing -> unresolved
    "wrist_conf": 0.3,
    # hand-area identification
    "hand_on": 0.6,                     # P(holding) above this ...
    "hand_on_frames": 3,                # ... for 3 frames -> the hand is holding something
    "hand_off": 0.4,                    # P(holding) below this ...
    "hand_off_frames": 5,               # ... for 5 frames -> the hand is empty again
    "hand_extend": 0.4,                 # hand centre = wrist + 0.4 x (wrist - elbow)
    "hand_crop_forearm": 1.0,           # crop side = 1.0 x forearm length ...
    "hand_crop_min_frac": 0.08,         # ... but at least 8% of the frame's long side
    "hand_quality_weight": 0.5,         # hand crops include the hand, so they count half vs a YOLO box
    "bin_box_cover": 0.5,
    "reach_frac": 1.0,
    # 17 Oct ablation on 7 clips: ignoring openings in camera tracking lost 2 deposits and added 4 false
    # events (too few features left near the bin), so it is off; the bin-box filter removed 1 false event
    # and fixed 1 mis-attribution with no losses, so it is on.
    "camera_ignore_openings": False,    # leave openings/lids out of camera tracking
    "bin_box_filter": True,             # drop YOLO boxes covering an opening (the bin itself)                  # a hidden item can be credited only if last seen this close (x opening size)               # a YOLO box covering half an opening is the bin, not an item
}
EMPTY_HAND = ["an empty hand", "an open hand with nothing in it", "a bare hand"]
HOLDING_HAND = ["a hand holding an object", "a hand holding a piece of trash", "a hand holding a cup",
                "a hand holding a bag", "a hand holding a wrapper", "a hand holding a box"]
BIN_PROMPTS = {"recycling": ["a recycling bin", "a blue recycling container"],
               "trash": ["a trash can", "a garbage bin", "a landfill waste bin"],
               "compost": ["a compost bin", "a green organics bin"]}
BGR = {"recycling": (255, 170, 80), "compost": (100, 215, 70), "trash": (185, 185, 185), None: (60, 170, 230)}
AMBER = (11, 158, 245)
S2 = np.float32([[2, 0, 0], [0, 2, 0], [0, 0, 1]])  # half-res -> full-res


# ---------------------------------------------------------------- setup

def cmd_setup(a):
    """Click each bin opening's outline on one frame; type its id and type in the terminal."""
    cap = cv2.VideoCapture(str(a.video))
    cap.set(cv2.CAP_PROP_POS_MSEC, a.at * 1000)
    ok, frame = cap.read()
    if not ok:
        sys.exit(f"could not read {a.video} at {a.at}s")
    H, W = frame.shape[:2]
    s = min(1.0, 900 / max(H, W))
    shown = cv2.resize(frame, (int(W * s), int(H * s)))
    bins = []
    print("Click the corners of a bin OPENING, Enter to finish it, Esc when all bins are done.")
    while True:
        pts: list[tuple[int, int]] = []

        def click(ev, x, y, *_):
            if ev == cv2.EVENT_LBUTTONDOWN:
                pts.append((x, y))

        cv2.namedWindow("setup")
        cv2.setMouseCallback("setup", click)
        while True:
            im = shown.copy()
            for b in bins:
                cv2.polylines(im, [np.int32([(x * shown.shape[1], y * shown.shape[0]) for x, y in b["opening"]])], True, BGR[b["type"]], 2)
            if pts:
                cv2.polylines(im, [np.int32(pts)], len(pts) > 2, AMBER, 2)
            cv2.imshow("setup", im)
            k = cv2.waitKey(30) & 0xFF
            if k in (13, 10) and len(pts) >= 3:
                break
            if k == 27:
                cv2.destroyAllWindows()
                out = {"video": str(Path(a.video).resolve()), "camera": a.camera, "reference_time_s": a.at, "bins": bins}
                Path(a.out).write_text(json.dumps(out, indent=2))
                print(f"wrote {a.out}")
                return
        bin_type = ""
        while bin_type not in BIN_PROMPTS:
            bin_type = input("bin type (trash/recycling/compost): ").strip().lower()
        bin_id = input("bin id (e.g. bin_patio_recycling): ").strip() or f"bin_{len(bins) + 1}"
        bins.append({"bin_id": bin_id, "type": bin_type,
                     "opening": [[round(x / shown.shape[1], 4), round(y / shown.shape[0], 4)] for x, y in pts]})


# ---------------------------------------------------------------- detection + camera motion

@dataclass
class Det:
    tid: int
    box: tuple[float, float, float, float]
    cls: str
    quality: float
    crop: np.ndarray

    @property
    def center(self):
        x1, y1, x2, y2 = self.box
        return ((x1 + x2) / 2, (y1 + y2) / 2)


def detect(video, weights, pose_weights, imgsz=960):
    """Worker tracker settings (YOLO11n + ByteTrack, imgsz 960) for items; YOLO pose for people/wrists."""
    import torch
    from ultralytics import YOLO

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model, pose = YOLO(str(weights)), YOLO(str(pose_weights))
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS)
    small, dets, people, wrists, hands = [], [], [], [], []
    idx = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        H, W = f.shape[:2]
        r = model.track(f, persist=True, imgsz=imgsz, device=device, verbose=False)[0]
        ds = []
        if r.boxes.id is not None:
            for b, tid, c in zip(r.boxes.xyxy.tolist(), r.boxes.id.int().tolist(), r.boxes.cls.int().tolist()):
                name = model.names[c]
                if not is_item_class(name) or (b[2] - b[0]) * (b[3] - b[1]) > RULES["max_box_frac"] * W * H:
                    continue
                x1, y1, x2, y2 = map(int, b)
                pad = int(0.1 * max(x2 - x1, y2 - y1))
                crop = f[max(0, y1 - pad):y2 + pad, max(0, x1 - pad):x2 + pad]
                if not crop.size:
                    continue
                sharp = cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
                quality = float(np.sqrt((x2 - x1) * (y2 - y1)) * min(sharp, 500) / 500)
                k = 320 / max(crop.shape[:2])
                if k < 1:
                    crop = cv2.resize(crop, (max(1, int(crop.shape[1] * k)), max(1, int(crop.shape[0] * k))))
                ds.append(Det(tid, tuple(b), name, quality, crop))
        ds = nms(ds)
        p = pose.track(f, persist=True, imgsz=imgsz, device=device, verbose=False)[0]
        ppl, wr, hs = [], [], []
        if p.boxes is not None and len(p.boxes):
            ppl = p.boxes.xyxy.tolist()
            pids = p.boxes.id.int().tolist() if p.boxes.id is not None else list(range(-1, -len(ppl) - 1, -1))
            if p.keypoints is not None and p.keypoints.conf is not None:
                kx, kc = p.keypoints.xy.cpu().numpy(), p.keypoints.conf.cpu().numpy()
                for pid, person_xy, person_c in zip(pids, kx, kc):
                    for side, wk, ek in (("L", 9, 7), ("R", 10, 8)):  # COCO wrist / elbow
                        if person_c[wk] < RULES["wrist_conf"]:
                            continue
                        wrist = np.float32(person_xy[wk])
                        wr.append((float(wrist[0]), float(wrist[1])))
                        side_len = RULES["hand_crop_min_frac"] * max(W, H)
                        center = wrist
                        if person_c[ek] >= RULES["wrist_conf"]:
                            fore = wrist - np.float32(person_xy[ek])
                            center = wrist + RULES["hand_extend"] * fore
                            side_len = max(side_len, RULES["hand_crop_forearm"] * float(np.hypot(*fore)))
                        h2 = side_len / 2
                        x1, y1 = max(0, int(center[0] - h2)), max(0, int(center[1] - h2))
                        x2, y2 = min(W, int(center[0] + h2)), min(H, int(center[1] + h2))
                        if x2 - x1 < 8 or y2 - y1 < 8:
                            continue
                        crop = f[y1:y2, x1:x2]
                        sharp = cv2.Laplacian(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var()
                        k = 224 / max(crop.shape[:2])
                        if k < 1:
                            crop = cv2.resize(crop, (max(1, int(crop.shape[1] * k)), max(1, int(crop.shape[0] * k))))
                        hs.append({"key": (pid, side), "center": (float(center[0]), float(center[1])),
                                   "box": (x1, y1, x2, y2), "crop": crop, "sharp": float(sharp)})
        small.append(cv2.cvtColor(cv2.resize(f, (W // 2, H // 2)), cv2.COLOR_BGR2GRAY))
        dets.append(ds)
        people.append(ppl)
        wrists.append(wr)
        hands.append(hs)
        idx += 1
    return fps, (W, H), small, dets, people, wrists, hands


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


def nms(ds, thr=0.5):
    """One box per object: YOLO sometimes boxes the same cup twice under different classes."""
    keep = []
    for d in sorted(ds, key=lambda d: -d.quality):
        if all(iou(d.box, k.box) < thr for k in keep):
            keep.append(d)
    return keep


def to_h(A):
    return np.vstack([A, [0, 0, 1]])


def camera_motion(frames_small, people, ref, bins_px, fixed):  # noqa: C901
    """T[i]: 2x3 affine mapping reference-frame pixels to frame i pixels (full res), or None when the
    bins have left the view. Tracks features around the bins with KLT."""
    n = len(frames_small)
    eye = np.float32([[1, 0, 0], [0, 1, 0]])
    if fixed:
        return [eye.copy() for _ in range(n)]
    T = [None] * n
    T[ref] = eye.copy()
    allpts = np.concatenate(bins_px)
    bx1, by1 = allpts.min(0)
    bx2, by2 = allpts.max(0)
    mx, my = 0.75 * (bx2 - bx1), 0.75 * (by2 - by1)
    region = np.float32([[bx1 - mx, by1 - my], [bx2 + mx, by1 - my], [bx2 + mx, by2 + my], [bx1 - mx, by2 + my]])

    def estimate(a, b, poly, ppl, excl):
        """People are masked first; if that leaves too little texture (an arm across the bin), RANSAC
        alone has to reject them."""
        for use_people_mask in (True, False):
            mask = np.zeros_like(a)
            cv2.fillPoly(mask, [np.int32(poly)], 255)
            for e in excl:  # openings and lids move; they are not the scene
                cv2.fillPoly(mask, [np.int32(e)], 0)
            if use_people_mask:
                for x1, y1, x2, y2 in ppl:
                    cv2.rectangle(mask, (int(x1 / 2), int(y1 / 2)), (int(x2 / 2), int(y2 / 2)), 0, -1)
            p0 = cv2.goodFeaturesToTrack(a, 400, 0.01, 7, mask=mask)
            if p0 is None or len(p0) < 30:
                continue
            p1, st, _ = cv2.calcOpticalFlowPyrLK(a, b, p0, None, winSize=(21, 21), maxLevel=3)
            good = st.ravel() == 1
            if good.sum() < 15:
                continue
            M, inl = cv2.estimateAffinePartial2D(p0[good], p1[good], ransacReprojThreshold=3)
            if M is not None and inl.sum() >= 15:
                return M
        return None

    MAX_MISSES = 3  # frames of failed motion estimates to bridge by assuming no motion
    for step in (1, -1):
        i, misses = ref, 0
        while 0 <= i + step < n:
            j = i + step
            h, w = frames_small[i].shape
            poly = cv2.transform(region[None], T[i])[0] / 2
            excl = []
            for bp in (bins_px if RULES["camera_ignore_openings"] else []):
                (ox1, oy1), (ox2, oy2) = bp.min(0), bp.max(0)
                ow_, oh_ = ox2 - ox1, oy2 - oy1
                rect = np.float32([[ox1 - .5 * ow_, oy1 - 1.5 * oh_], [ox2 + .5 * ow_, oy1 - 1.5 * oh_],
                                   [ox2 + .5 * ow_, oy2 + .5 * oh_], [ox1 - .5 * ow_, oy2 + .5 * oh_]])
                excl.append(cv2.transform(rect[None], T[i])[0] / 2)
            M = estimate(frames_small[i], frames_small[j], poly, people[i], excl)
            if M is None:
                misses += 1
                if misses > MAX_MISSES:
                    break
                T[j] = T[i].copy()
                i = j
                continue
            misses = 0
            Tj = (S2 @ to_h(M) @ np.linalg.inv(S2) @ to_h(T[i]))[:2].astype(np.float32)
            c = cv2.transform(np.float32(allpts)[None], Tj)[0].mean(0)
            if not (-0.25 * w * 2 < c[0] < 1.25 * w * 2 and -0.25 * h * 2 < c[1] < 1.25 * h * 2):
                break  # bins have left the frame
            T[j] = Tj
            i = j
    return T


def to_ref(T, pt):
    inv = cv2.invertAffineTransform(T)
    return tuple(cv2.transform(np.float32([[pt]]), inv)[0, 0])


# ---------------------------------------------------------------- identity

def probs_from_vec(clf, v, k=3):
    """CategoryClassifier.probabilities() for an already-combined image vector."""
    sims = clf.text @ v
    best: dict[str, float] = {}
    for (cid, _), s in zip(clf.flat, sims):
        best[cid] = max(best.get(cid, -np.inf), float(s))
    ids = list(best)
    logits = clf.logit_scale * np.array([best[c] for c in ids])
    p = np.exp(logits - logits.max())
    p /= p.sum()
    return sorted(zip(ids, p.tolist()), key=lambda z: -z[1])[:k]


def judge(top, bin_type, catalog):
    """Same order as core: confidence, then (proposed) bin conflict, then compare with the bin."""
    if not top:
        return "unassessable", "item not identified", None
    (a, pa), rest = top[0], top[1:]
    da = catalog[a]["destination"]
    if pa < RULES["item_confidence_threshold"]:
        return "unassessable", f"item confidence {pa:.2f} < {RULES['item_confidence_threshold']}", da
    if rest:
        b, pb = rest[0]
        db = catalog[b]["destination"]
        if db != da and pa - pb < RULES["conflict_margin"]:
            return "unassessable", f"top two disagree: {da} {pa:.2f} vs {db} {pb:.2f}", da
    if bin_type is None:
        return "unassessable", "bin type unknown", da
    return ("correct" if da == bin_type else "wrong_bin"), f"belongs in {da}, went in {bin_type}", da


# ---------------------------------------------------------------- lifecycle

@dataclass
class Item:
    iid: int
    tids: set = field(default_factory=set)
    hist: list = field(default_factory=list)       # (frame, image center, ref center or None, box)
    crops: list = field(default_factory=list)      # (quality, frame, emb)
    best_img: tuple = None                         # (quality, crop) for the final card
    state: str = "TRACKED"                         # TRACKED / AT_OPENING / LOST / LEFT / PARKED / DEPOSITED
    state_since: int = 0
    at_bin: str = None
    top: list = field(default_factory=list)
    settled: int = 0
    vec: np.ndarray = None
    revivals: int = 0
    hand_obs: int = 0

    @property
    def last_seen(self):
        return self.hist[-1][0]

    def update_identity(self, clf):
        best = sorted(self.crops, key=lambda c: -c[0])[:RULES["best_crops"]]
        v = np.mean([e for _, _, e in best], axis=0)
        self.vec = v / np.linalg.norm(v)
        top = probs_from_vec(clf, self.vec)
        self.settled = self.settled + 1 if self.top and top[0][0] == self.top[0][0] else 0
        self.top = top


class Opening:
    """CLEAR -> OCCUPIED -> clear again, on the opening aligned to the reference frame."""

    def __init__(self, bin_id, poly_small, shape_small):
        self.bin_id = bin_id
        h, w = shape_small
        x1, y1 = np.floor(poly_small.min(0)).astype(int)
        x2, y2 = np.ceil(poly_small.max(0)).astype(int)
        self.x1, self.y1, self.x2, self.y2 = max(0, x1), max(0, y1), min(w, x2), min(h, y2)
        m = np.zeros((h, w), np.uint8)
        cv2.fillPoly(m, [np.int32(poly_small)], 1)
        self.mask = m[self.y1:self.y2, self.x1:self.x2].astype(bool)
        self.state, self.since = "INIT", 0
        self.baseline = self.before = self.prev = None
        self.stable_run = self.occ_run = 0
        self.clear_at = None
        self.episode = None

    def patch(self, small, T):
        """Opening patch from this frame, warped into reference geometry; None if not observable."""
        Ts = (np.linalg.inv(S2) @ to_h(T) @ S2)[:2]
        h, w = small.shape
        warped = cv2.warpAffine(small, Ts, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP, borderValue=0)
        valid = cv2.warpAffine(np.full_like(small, 255), Ts, (w, h), flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP, borderValue=0)
        p = warped[self.y1:self.y2, self.x1:self.x2].astype(np.float32)
        v = valid[self.y1:self.y2, self.x1:self.x2] > 0
        if (v & self.mask).sum() < 0.6 * self.mask.sum():
            return None
        return cv2.GaussianBlur(p, (5, 5), 0)

    def changed(self, a, b):
        am, bm = a[self.mask].mean(), b[self.mask].mean()
        d = np.abs((a - am) - (b - bm)) > RULES["diff_thr"]
        return d & self.mask, float(d[self.mask].mean())


@dataclass
class Event:
    frame: int
    bin_id: str
    item: Item | None
    signals: dict
    confidence: float
    top: list
    verdict: str
    why: str
    blob: np.ndarray | None
    before: np.ndarray | None
    after: np.ndarray | None
    diff: np.ndarray | None
    origin: tuple | None = None  # top-left of the opening's half-res bbox; blob/diff are relative to it


def analyse(fps, size, small, dets, wrists, hands, T, bins, bins_px, clf, catalog):  # noqa: C901
    W, H = size
    diag = np.hypot(W, H)
    n = len(small)
    btype = {b["bin_id"]: b["type"] for b in bins}
    openings = [Opening(b["bin_id"], p / 2, small[0].shape) for b, p in zip(bins, bins_px)]
    obox = {b["bin_id"]: (p.min(0), p.max(0)) for b, p in zip(bins, bins_px)}  # full-res ref bbox

    def near_opening(ref_pt):
        """Bin whose opening (or the half-height band just above it, as in throw_score) contains ref_pt."""
        if ref_pt is None:
            return None
        for bid, ((x1, y1), (x2, y2)) in obox.items():
            if x1 <= ref_pt[0] <= x2 and y1 - 0.5 * (y2 - y1) <= ref_pt[1] <= y2:
                return bid
        return None

    def wrist_over(i, bid):
        if T[i] is None:
            return False
        (x1, y1), (x2, y2) = obox[bid]  # a wrist inside the opening itself; standing beside it doesn't count
        return any(x1 <= rx <= x2 and y1 <= ry <= y2 for rx, ry in (to_ref(T[i], w) for w in wrists[i]))

    def item_over(i, bid):
        if T[i] is None:
            return False
        (x1, y1), (x2, y2) = obox[bid]
        for d in dets[i]:
            cx, cy = to_ref(T[i], d.center)
            if x1 <= cx <= x2 and y1 - 0.5 * (y2 - y1) <= cy <= y2:
                return True
        return False

    items: list[Item] = []
    tid2item: dict[int, Item] = {}
    events: list[Event] = []
    hand_text = clf.embedder.embed_text(EMPTY_HAND + HOLDING_HAND)
    hand_state: dict = {}

    def observe(it, i, center, box, quality, emb, crop):
        ref_pt = to_ref(T[i], center) if T[i] is not None else None
        it.hist.append((i, center, ref_pt, box))
        it.crops.append((quality, i, emb))
        if it.best_img is None or quality > it.best_img[0]:
            it.best_img = (quality, crop)
        it.update_identity(clf)

    def revive(it, i):
        it.revivals += 1
        it.state, it.state_since, it.at_bin = "TRACKED", i, None

    def reid(emb, i):
        best, bc = None, -1.0
        for x in items:
            if x.state in ("LOST", "AT_OPENING") and x.vec is not None and i - x.last_seen <= RULES["reid_window_frames"]:
                c = float(emb @ x.vec)
                if c > bc:
                    best, bc = x, c
        return best if bc >= RULES["reid_cos"] else None

    def within_reach(it, bid):
        """Last seen no further from the opening than its own size: an item lost across the room did not
        just go in. Items never seen with camera alignment can't be placed, so they don't qualify."""
        ref_pts = [h[2] for h in it.hist if h[2] is not None]
        if not ref_pts:
            return False
        (x1, y1), (x2, y2) = obox[bid]
        px, py = ref_pts[-1]
        dx, dy = max(x1 - px, 0, px - x2), max(y1 - py, 0, py - y2)
        return float(np.hypot(dx, dy)) <= RULES["reach_frac"] * max(x2 - x1, y2 - y1)

    def covers_opening(i, box):
        """A YOLO box that covers most of an opening is the bin itself (the beach video's "bottle")."""
        if T[i] is None:
            return False
        a = to_ref(T[i], (box[0], box[1]))
        b = to_ref(T[i], (box[2], box[3]))
        bx1, by1, bx2, by2 = min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])
        for (x1, y1), (x2, y2) in obox.values():
            inter = max(0, min(bx2, x2) - max(bx1, x1)) * max(0, min(by2, y2) - max(by1, y1))
            if inter >= RULES["bin_box_cover"] * (x2 - x1) * (y2 - y1):
                return True
        return False

    def duplicate(bid, it, i):
        """Same bin, within 1.5 s, and the same look as an item already deposited -> same throw."""
        for e in events:
            if e.bin_id == bid and i - e.frame <= int(1.5 * fps) and e.item is not None and it is not None \
                    and e.item.vec is not None and it.vec is not None and float(e.item.vec @ it.vec) >= RULES["reid_cos"]:
                return True
        return False
    frames = []  # per-frame render info
    pending = []  # (bin_id, episode dict) awaiting confirm_frames

    for i in range(n):
        info = {"items": [], "bins": {}, "wrists": wrists[i], "hands": []}
        frame_dets = [d for d in dets[i] if not (RULES["bin_box_filter"] and covers_opening(i, d.box))]
        # ---- 0. hands: empty or holding; a holding hand carries an item
        held = []  # (hand box, item) for this frame
        for hd in hands[i]:
            emb = clf.embedder.embed(hd["crop"])
            sims = hand_text @ emb
            gap = float(sims[len(EMPTY_HAND):].max() - sims[:len(EMPTY_HAND)].max())
            p_hold = float(1 / (1 + np.exp(-clf.logit_scale * gap)))
            hs = hand_state.setdefault(hd["key"], {"on": 0, "off": 0, "holding": False, "item": None})
            if p_hold >= RULES["hand_on"]:
                hs["on"], hs["off"] = hs["on"] + 1, 0
            elif p_hold <= RULES["hand_off"]:
                hs["on"], hs["off"] = 0, hs["off"] + 1
            if not hs["holding"] and hs["on"] >= RULES["hand_on_frames"]:
                hs["holding"] = True
            elif hs["holding"] and hs["off"] >= RULES["hand_off_frames"]:
                hs["holding"], hs["item"] = False, None
            it = None
            if hs["holding"] and p_hold >= 0.5:
                it = hs["item"]
                if it is not None and it.state in ("LOST", "AT_OPENING"):
                    # same hand holding again: it came back out only if it still looks the same
                    it = it if float(emb @ it.vec) >= RULES["reid_cos"] else None
                    if it is not None:
                        revive(it, i)
                if it is None or it.state not in ("TRACKED",):
                    x1, y1, x2, y2 = hd["box"]
                    inside = [tid2item[d.tid] for d in frame_dets if d.tid in tid2item and tid2item[d.tid].state == "TRACKED"
                              and x1 <= d.center[0] <= x2 and y1 <= d.center[1] <= y2]
                    it = inside[0] if inside else reid(emb, i)
                    if it is not None and it.state != "TRACKED":
                        revive(it, i)
                    if it is None:
                        it = Item(len(items) + 1, state_since=i)
                        items.append(it)
                    hs["item"] = it
                q = RULES["hand_quality_weight"] * float(np.sqrt((hd["box"][2] - hd["box"][0]) * (hd["box"][3] - hd["box"][1]))) \
                    * min(hd["sharp"], 500) / 500 * p_hold
                observe(it, i, hd["center"], hd["box"], q, emb, hd["crop"])
                it.hand_obs += 1
                held.append((hd["box"], it))
                info["items"].append((it.iid, hd["box"], list(it.top), it.settled >= RULES["settle_updates"]))
            info["hands"].append((hd["box"], p_hold, hs["holding"]))
        # ---- 1. detections -> items (with re-ID)
        for d in frame_dets:
            emb = clf.embedder.embed(d.crop)
            it = tid2item.get(d.tid)
            for (x1, y1, x2, y2), hit in held:  # a box inside a holding hand is that hand's item
                if x1 <= d.center[0] <= x2 and y1 <= d.center[1] <= y2 and (it is None or len(it.hist) < RULES["young_obs"]):
                    it = tid2item[d.tid] = hit
                    break
            if it is None:
                it = None
                # re-ID: a recently lost / at-opening item with the same look, or (fallback) one that
                # vanished just before, close by
                cands = [x for x in items if x.state in ("LOST", "AT_OPENING") and i - x.last_seen <= RULES["reid_window_frames"]]
                best, bc = None, -1.0
                for x in cands:
                    c = float(emb @ x.vec) if x.vec is not None else -1
                    if c > bc:
                        best, bc = x, c
                if best is not None and bc >= RULES["reid_cos"]:
                    it = best
                else:
                    for x in cands:
                        if i - x.last_seen <= RULES["chain_gap_frames"] and \
                                np.hypot(*np.subtract(d.center, x.hist[-1][1])) <= RULES["chain_dist_frac"] * diag:
                            it = x
                            break
                if it is not None:
                    it.revivals += 1
                    it.state, it.state_since, it.at_bin = "TRACKED", i, None
                else:
                    it = Item(len(items) + 1, state_since=i)
                    items.append(it)
                tid2item[d.tid] = it
            elif it.state in ("LOST", "AT_OPENING"):
                revive(it, i)  # same track came back
            # young track that now matches an older lost item -> merge into it
            if len(it.hist) < RULES["young_obs"] and it.revivals == 0:
                for x in items:
                    if x is not it and x.vec is not None and x.state in ("LOST", "AT_OPENING") and \
                            i - x.last_seen <= RULES["reid_window_frames"] and float(emb @ x.vec) >= RULES["reid_cos"]:
                        x.hist += it.hist
                        x.crops += it.crops
                        x.tids |= it.tids
                        x.revivals += 1
                        x.state, x.state_since, x.at_bin = "TRACKED", i, None
                        for t_, v_ in list(tid2item.items()):
                            if v_ is it:
                                tid2item[t_] = x
                        it.state = "MERGED"
                        it = x
                        break
            it.tids.add(d.tid)
            observe(it, i, d.center, d.box, d.quality, emb, d.crop)
            info["items"].append((it.iid, d.box, list(it.top), it.settled >= RULES["settle_updates"]))

        # ---- 2. lifecycle for items not seen
        for it in items:
            if it.state == "TRACKED" and i - it.last_seen >= RULES["lost_after_frames"]:
                _, c, ref_pt, _ = it.hist[-1]
                bid = near_opening(ref_pt)
                if bid:
                    it.state, it.at_bin = "AT_OPENING", bid
                elif min(c[0], W - c[0]) < RULES["edge_frac"] * W or min(c[1], H - c[1]) < RULES["edge_frac"] * H:
                    it.state = "LEFT"
                else:
                    it.state = "LOST"
                it.state_since = i
            elif it.state == "TRACKED" and len(it.hist) >= RULES["park_frames"]:
                recent = [h for h in it.hist if i - h[0] < RULES["park_frames"]]
                pts = [h[2] if h[2] is not None else h[1] for h in recent]
                if len(recent) > 0.5 * RULES["park_frames"] and np.ptp(np.array(pts), axis=0).max() < RULES["park_move_frac"] * diag \
                        and near_opening(recent[-1][2]) is None:
                    it.state, it.state_since = "PARKED", i
            elif it.state == "LOST" and i - it.last_seen > RULES["reid_window_frames"]:
                it.state = "GONE"

        # ---- 3. opening watchers
        for op in openings:
            p = op.patch(small[i], T[i]) if T[i] is not None else None
            wr = wrist_over(i, op.bin_id)
            if p is None:
                if op.state == "OCCUPIED":
                    pending.append((op.bin_id, dict(op.episode, end=i, resolved=False, note="bin left view")))
                op.state, op.prev, op.stable_run = "INIT", None, 0
                info["bins"][op.bin_id] = "OUT OF VIEW"
                continue
            stable = op.prev is not None and op.changed(p, op.prev)[1] < RULES["stable_frac"]
            op.stable_run = op.stable_run + 1 if stable else 0
            op.prev = p
            if op.state == "INIT":
                if op.stable_run >= RULES["stable_frames"] and not wr:
                    op.state, op.baseline = "CLEAR", p
            elif op.state == "CLEAR":
                _, frac = op.changed(p, op.baseline)
                occupied = frac > RULES["occ_frac"] or wr
                op.occ_run = op.occ_run + 1 if occupied else 0
                if op.occ_run >= 2:
                    op.state, op.before, op.since = "OCCUPIED", op.baseline, i
                    op.episode = {"start": i, "before": op.baseline}
                elif stable and not occupied:
                    op.baseline = p  # follow slow lighting changes
            elif op.state == "OCCUPIED":
                diffmask, frac = op.changed(p, op.before)
                if op.stable_run >= RULES["stable_frames"] and not wr and not item_over(i, op.bin_id) and frac <= RULES["residual_max"]:
                    clean = cv2.morphologyEx(diffmask.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
                    num, lab, stats, _ = cv2.connectedComponentsWithStats(clean)
                    blob = None
                    if num > 1:
                        k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
                        if stats[k, cv2.CC_STAT_AREA] >= RULES["blob_min_frac"] * op.mask.sum():
                            blob = (lab == k)
                    pending.append((op.bin_id, dict(op.episode, end=i, resolved=True, blob=blob, after=p,
                                                    diff=diffmask, origin=(op.x1, op.y1))))
                    op.state, op.baseline = "CLEAR", p
                elif i - op.since > RULES["max_occupied_frames"]:
                    pending.append((op.bin_id, dict(op.episode, end=i, resolved=False, note="never cleared")))
                    op.state, op.baseline = "CLEAR", p
            if i == n - 1 and op.state == "OCCUPIED":
                pending.append((op.bin_id, dict(op.episode, end=i, resolved=False, note="clip ended while occupied")))
            info["bins"][op.bin_id] = op.state + (" + WRIST" if wr else "")

        # ---- 4. decide deposits confirm_frames after the opening cleared
        still = []
        for bid, ep in pending:
            if i - ep["end"] < RULES["confirm_frames"] and i < n - 1:
                still.append((bid, ep))
                continue
            new_obj = bool(ep.get("resolved") and ep.get("blob") is not None)
            (x1, y1), (x2, y2) = obox[bid]
            roi = (int(x1), int(y1), int(x2 - x1), int(y2 - y1))
            scored = []
            # (a) items whose track ended at this opening during the visit
            for it in items:
                if it.state == "AT_OPENING" and it.at_bin == bid and it.last_seen >= ep["start"] - 30 \
                        and len(it.hist) >= RULES["young_obs"]:
                    ref_hist = [h[2] for h in it.hist if h[2] is not None]
                    path = throw_score(ref_hist, roi) if ref_hist else 0.0
                    sig = {"path": bool(path >= RULES["min_entry_score"]), "no_return": bool(ep.get("resolved")),
                           "new_object": new_obj}
                    scored.append((sum(sig.values()), len(it.hist), it, sig, "track ended at the opening"))
            # (b) occlusion case: nothing ended at the opening, but something went in -> the item that was
            # lost most recently (hidden in a hand on the way) and never came back
            if not scored and new_obj:
                lost = [x for x in items if x.state == "LOST" and len(x.hist) >= RULES["young_obs"]
                        and ep["end"] - x.last_seen <= RULES["reid_window_frames"] and within_reach(x, bid)]
                if lost:
                    it = max(lost, key=lambda x: x.last_seen)
                    sig = {"path": False, "no_return": True, "new_object": True}
                    scored.append((2, len(it.hist), it, sig, "last item seen before the opening was used"))
            if scored:
                count, _, it, sig, basis = max(scored, key=lambda z: (z[0], z[1]))  # one deposit per visit
                if count and not duplicate(bid, it, i):
                    conf = {1: 0.4, 2: 0.75, 3: 0.9}[count]
                    if basis.startswith("last item"):
                        conf = min(conf, 0.6)  # attribution is inferred, not seen
                    verdict, why, _ = judge(it.top, btype[bid], catalog)
                    ev = Event(i, bid, it, sig, conf, list(it.top), verdict, why, ep.get("blob"), ep.get("before"),
                               ep.get("after"), ep.get("diff"), ep.get("origin"))
                    ev.basis = basis
                    events.append(ev)
                for _, _, other, _, _ in scored:
                    if other.state == "AT_OPENING":
                        other.state, other.state_since = "DEPOSITED" if other is it else "LOST", i
                it.state, it.state_since = "DEPOSITED", i
            elif new_obj:
                ev = Event(i, bid, None, {"path": False, "no_return": False, "new_object": True}, 0.4, [],
                           "unassessable", "something went in, item not seen", ep.get("blob"), ep.get("before"),
                           ep.get("after"), ep.get("diff"), ep.get("origin"))
                ev.basis = "opening change only"
                events.append(ev)
            info.setdefault("decided", []).append((bid, ep))
        pending = still

        # ---- 5. vanished at an opening but the watcher never decided: path-only fallback
        for it in items:
            watching = it.state == "AT_OPENING" and \
                next(op for op in openings if op.bin_id == it.at_bin).state == "OCCUPIED"
            if it.state == "AT_OPENING" and (i - it.state_since >= RULES["at_opening_wait_frames"] or i == n - 1) \
                    and not watching and not any(bid == it.at_bin for bid, _ in pending):
                ref_hist = [h[2] for h in it.hist if h[2] is not None]
                (x1, y1), (x2, y2) = obox[it.at_bin]
                path = throw_score(ref_hist, (int(x1), int(y1), int(x2 - x1), int(y2 - y1))) if ref_hist else 0.0
                if path >= RULES["min_entry_score"] and duplicate(it.at_bin, it, i):
                    it.state = "DEPOSITED"
                elif path >= RULES["min_entry_score"]:
                    verdict, why, _ = judge(it.top, btype[it.at_bin], catalog)
                    ev = Event(i, it.at_bin, it, {"path": True, "no_return": False, "new_object": False}, 0.4,
                               list(it.top), verdict, why, None, None, None, None)
                    ev.basis = "path only (opening never seen clear)"
                    events.append(ev)
                    it.state = "DEPOSITED"
                else:
                    it.state = "LOST"
                it.state_since = i

        info["states"] = {it.iid: it.state for it in items if it.state not in ("MERGED",)}
        info["active"] = [(it.iid, list(it.top), it.settled >= RULES["settle_updates"], it.state, len(it.hist))
                          for it in items if it.top and it.state in ("TRACKED", "AT_OPENING", "LOST", "DEPOSITED")
                          and (it.state != "DEPOSITED" or i - it.state_since < int(3 * fps))]
        frames.append(info)
    return items, events, frames, openings


# ---------------------------------------------------------------- run

def cmd_run(a):
    for kv in a.rule or []:  # --rule name=value, for ablations
        k, v = kv.split("=", 1)
        RULES[k] = json.loads(v)
    setup = json.loads(Path(a.setup).read_text())
    video = Path(setup["video"])
    catalog = {c["catalog_item_id"]: c for c in json.loads(CATALOG.read_text())["catalog"]}
    print(f"[1/4] detecting items, people, wrists: {video.name}")
    fps, (W, H), small, dets, people, wrists, hands = detect(video, a.weights, a.pose_weights)
    if not a.hands:
        hands = [[] for _ in hands]
    n = len(small)
    ref = min(n - 1, int(round(setup["reference_time_s"] * fps)))
    bins = setup["bins"]
    bins_px = [np.float32([(x * W, y * H) for x, y in b["opening"]]) for b in bins]
    print("[2/4] camera motion")
    T = camera_motion(small, people, ref, bins_px, setup.get("camera") == "fixed")
    print("[3/4] item lifecycle, openings, deposits")
    from recyclone_worker.identify import ClipEmbedder

    clf = CategoryClassifier(ClipEmbedder(Path(a.clip_weights).expanduser()))
    items, events, frames, _ = analyse(fps, (W, H), small, dets, wrists, hands, T, bins, bins_px, clf, catalog)

    summary = {
        "video": video.name, "frames": n, "fps": fps, "camera_tracked_frames": sum(t is not None for t in T),
        "rules": RULES, "label": setup.get("label"),
        "items": [{"item": it.iid, "tracks": sorted(it.tids), "detections": len(it.hist), "hand_frames": it.hand_obs, "revived": it.revivals,
                   "end_state": it.state, "top": [(c, round(p, 3)) for c, p in it.top]} for it in items if it.state != "MERGED"],
        "events": [{"t_s": round(e.frame / fps, 2), "bin_id": e.bin_id, "item": e.item.iid if e.item else None,
                    "signals": e.signals, "confidence": e.confidence, "top": [(c, round(p, 3)) for c, p in e.top],
                    "verdict": e.verdict, "why": e.why, "basis": getattr(e, "basis", "")} for e in events],
    }
    print(json.dumps({k: summary[k] for k in ("video", "camera_tracked_frames", "items", "events")}, indent=1, default=str))
    Path(a.out).with_suffix(".json").write_text(json.dumps(summary, indent=2, default=str))
    print(f"[4/4] rendering {a.out}")
    render(video, a.out, fps, (W, H), T, bins, bins_px, frames, events, catalog, setup.get("label"))


# ---------------------------------------------------------------- rendering

RGB = {"recycling": (47, 125, 246), "compost": (45, 184, 77), "trash": (122, 122, 122), None: (255, 149, 0)}
VERDICT_STYLE = {"correct": ((45, 184, 77), (255, 255, 255), "CORRECT BIN"),
                 "wrong_bin": ((229, 56, 59), (255, 255, 255), "WRONG BIN"),
                 "unassessable": ((245, 165, 36), (0, 0, 0), "CAN'T JUDGE")}
_FONT_PATH = None


def label_font(size):
    """The font Ultralytics draws YOLO labels with (Arial; downloaded by Ultralytics if missing)."""
    global _FONT_PATH
    from PIL import ImageFont

    if _FONT_PATH is None:
        try:
            from ultralytics.utils.checks import check_font

            _FONT_PATH = str(check_font("Arial.ttf"))
        except Exception:  # noqa: BLE001 - fall back to PIL's built-in font
            _FONT_PATH = ""
    try:
        return ImageFont.truetype(_FONT_PATH, size)
    except OSError:
        return ImageFont.load_default()


def short_name(cid, catalog, k=26):
    name = catalog[cid]["name"] if cid in catalog else cid
    name = name.split(" (")[0]  # "Paper coffee cup (generic)" -> "Paper coffee cup"
    return name if len(name) <= k else name[:k - 1] + "…"


def tab(draw, x, y, label, bg, fg, font, below=False):
    """YOLO-style filled label: above (x, y) by default, or starting at y when below=True.
    Returns the tab's bottom edge."""
    l, t, r, b = draw.textbbox((0, 0), label, font=font)
    w, h = r - l, b - t
    pad = max(3, h // 3)
    fw, fh = draw.im.size
    x = int(min(max(0, x), fw - w - 2 * pad))
    y0 = int(y if below else y - h - 2 * pad)
    if y0 < 0:
        y0 = int(y)
    draw.rectangle([x, y0, x + w + 2 * pad, y0 + h + 2 * pad], fill=bg)
    draw.text((x + pad - l, y0 + pad - t), label, font=font, fill=fg)
    return y0 + h + 2 * pad


def render(video, out, fps, size, T, bins, bins_px, frames, events, catalog, label):
    """Boxes and labels only, drawn the way YOLO draws them: no bars, no end card."""
    from PIL import Image, ImageDraw

    W, H = size
    s = 1280 / max(W, H)
    ow, oh = int(W * s) // 2 * 2, int(H * s) // 2 * 2
    lw = max(2, round(min(ow, oh) / 240))
    font = label_font(max(14, round(min(ow, oh) * 0.026)))
    writer = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*"avc1"), fps, (ow, oh))
    cap = cv2.VideoCapture(str(video))
    btype = {b["bin_id"]: b["type"] for b in bins}
    shown_for = int(fps * 3)  # a verdict stays next to its bin for 3 s
    for idx in range(len(frames)):
        ok, f = cap.read()
        if not ok:
            break
        im = cv2.resize(f, (ow, oh))
        info = frames[idx]
        recent = [e for e in events if 0 <= idx - e.frame < shown_for]
        polys = {}
        if T[idx] is not None:
            for b, p in zip(bins, bins_px):
                poly = cv2.transform(p[None], T[idx])[0] * s
                polys[b["bin_id"]] = poly
                flash = any(e.bin_id == b["bin_id"] and idx - e.frame < 6 for e in recent)
                over = im.copy()
                fill = (255, 255, 255) if flash else RGB[b["type"]][::-1]
                cv2.fillPoly(over, [np.int32(poly)], fill)
                a_ = 0.35 if flash else 0.15
                im = cv2.addWeighted(over, a_, im, 1 - a_, 0)
        pil = Image.fromarray(cv2.cvtColor(im, cv2.COLOR_BGR2RGB))
        d = ImageDraw.Draw(pil)
        for bid, poly in polys.items():
            col = RGB[btype[bid]]
            pts = [tuple(map(float, pt)) for pt in poly]
            d.line(pts + [pts[0]], fill=col, width=lw)
            in_use = info["bins"].get(bid, "").startswith("OCCUPIED")
            x0, y0 = float(poly[:, 0].min()), float(poly[:, 1].min())
            bottom = tab(d, x0, y0, btype[bid].upper() + ("  ·  in use" if in_use else ""), col, (255, 255, 255), font)
            for e in [e for e in recent if e.bin_id == bid][-1:]:
                bg, fg, word = VERDICT_STYLE[e.verdict]
                if e.top:
                    name, dest = short_name(e.top[0][0], catalog, 22), catalog[e.top[0][0]]["destination"]
                    detail = {"wrong_bin": f"{name} belongs in {dest}", "correct": f"{name} → {dest}",
                              "unassessable": f"{name}? not sure enough"}[e.verdict]
                else:
                    detail = "something went in, item not seen"
                tab(d, x0, bottom + lw, f"{word}  ·  {detail}", bg, fg, font, below=True)
        for iid, box, top, settled in info["items"]:
            x1, y1, x2, y2 = [float(v) * s for v in box]
            if top:
                cid, p = top[0]
                col, lab = RGB[catalog[cid]["destination"]], f"{short_name(cid, catalog)} {p:.0%}"
            else:
                col, lab = RGB[None], f"item {iid}"
            d.rectangle([x1, y1, x2, y2], outline=col, width=lw)
            tab(d, x1, y1, lab, col, (255, 255, 255), font)
        for (x1, y1, x2, y2), p_hold, holding in info["hands"]:  # only with --hands
            col = (0, 200, 220) if holding else (150, 150, 150)
            d.rectangle([x1 * s, y1 * s, x2 * s, y2 * s], outline=col, width=max(1, lw - 1))
            tab(d, x1 * s, y2 * s, f"hand {'holding' if holding else 'empty'}", col, (0, 0, 0), font, below=True)
        writer.write(cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR))
    writer.release()


def cmd_reel(a):
    first = cv2.VideoCapture(a.videos[0])
    W, H, fps = int(first.get(3)), int(first.get(4)), first.get(5)
    writer = cv2.VideoWriter(a.out, cv2.VideoWriter_fourcc(*"avc1"), fps, (W, H))
    for v in a.videos:
        cap = cv2.VideoCapture(v)
        from PIL import Image, ImageDraw

        pil = Image.new("RGB", (W, H), (0, 0, 0))
        tab(ImageDraw.Draw(pil), 40, H // 2, Path(v).stem.replace("_bincheck", ""), (0, 0, 0), (255, 255, 255),
            label_font(max(18, H // 24)), below=True)
        title = np.asarray(pil)[:, :, ::-1].copy()
        for _ in range(int(fps * 1.2)):
            writer.write(title)
        while True:
            ok, f = cap.read()
            if not ok:
                break
            writer.write(f if f.shape[:2] == (H, W) else cv2.resize(f, (W, H)))
    writer.release()
    print(f"wrote {a.out}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("setup")
    s.add_argument("video")
    s.add_argument("--at", type=float, required=True, help="seconds into the video where the openings are clearly visible")
    s.add_argument("--camera", choices=["fixed", "moving"], default="fixed")
    s.add_argument("--out", default="setup.json")
    r = sub.add_parser("run")
    r.add_argument("setup")
    r.add_argument("--out", default="bincheck.mp4")
    r.add_argument("--weights", default="yolo11n.pt")
    r.add_argument("--pose-weights", default="yolo11n-pose.pt")
    r.add_argument("--rule", action="append", help="override a RULES entry, e.g. --rule bin_box_filter=true")
    r.add_argument("--hands", action="store_true", help="experimental hand-area identification (see docstring)")
    r.add_argument("--clip-weights", default="~/.cache/clip/ViT-B-32.pt")
    m = sub.add_parser("reel")
    m.add_argument("videos", nargs="+")
    m.add_argument("--out", default="reel.mp4")
    a = p.parse_args()
    {"setup": cmd_setup, "run": cmd_run, "reel": cmd_reel}[a.cmd](a)


if __name__ == "__main__":
    main()
