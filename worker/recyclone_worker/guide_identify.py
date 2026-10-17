"""What is this person carrying? Decided early, while they walk, so the answer is ready when they reach the bins.

Per person track: the crop past each wrist (items.hand_box) is embedded with CLIP; a crop that CLIP thinks is an item
(p_item >= 0.5) is "holding" and adds its catalog-category probabilities to the person's votes. Up to 3 crops of the
item, >= 0.5 s apart, are kept for the LLM.
- Catalog item: the top category has >= KNOWN_P of the votes over >= MIN_VOTES crops -> answered from the bin table,
  no network.
- Otherwise, once CLIP has voted MIN_VOTES times and MIN_CROPS crops exist: ONE background job per person: DeepSeek picks a catalog item (-> table), or
  describes it -> generic type -> Jev -> message. Any failure leaves no answer; the guide then says trash on arrival.
"""

import sys
from pathlib import Path
from concurrent.futures import Executor, Future, ThreadPoolExecutor

import cv2
import numpy as np

from . import guide_message as gm
from .generic import for_event, generic_type
from .categories import ITEM_PROMPTS
from .items import hand_box

# Dangerous items the catalog never has: CLIP may vote for them, and then the item always goes to the LLM path
# (never answered from the catalog), so a battery is never told "recycle" because it looked like a can.
HAZARD_PROMPTS = {
    "hazard:battery": ["a battery", "a lithium battery", "a AA battery"],
    "hazard:electronics": ["a phone", "a charging cable", "a small electronic device", "an e-cigarette vape"],
    "hazard:chemical": ["a can of paint", "a bottle of chemicals", "a propane canister", "an aerosol spray can"],
}
FACE_KPS = (0, 1, 2, 3, 4)  # nose, eyes, ears
FACE_KP_MIN = 0.05          # fail closed: blank even face points the pose model is unsure about


def head_box(kp) -> tuple[float, float, float, float] | None:
    """A person's head region in the frame: around any face keypoint (even low confidence), else the square above the
    shoulders. Used to blank EVERY tracked person's head in crops that leave the device."""
    face = [kp[j][:2] for j in FACE_KPS if kp[j][2] > FACE_KP_MIN]
    sh = [kp[j][:2] for j in (5, 6) if kp[j][2] > FACE_KP_MIN]
    width = float(abs(sh[0][0] - sh[1][0])) if len(sh) == 2 else None
    if face:
        xs, ys = [float(p[0]) for p in face], [float(p[1]) for p in face]
        r = max(25.0, 0.6 * (width or 0.0), 1.2 * (max(xs) - min(xs)))
        cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
        return cx - r, cy - r, cx + r, cy + r
    if width:
        cx, top = float(sh[0][0] + sh[1][0]) / 2, float(min(sh[0][1], sh[1][1]))
        return cx - 0.6 * width, top - 1.2 * width, cx + 0.6 * width, top
    return None


FACE_MODEL_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
FACE_MODEL = Path(__file__).resolve().parents[1] / "weights" / "face_detection_yunet_2023mar.onnx"
_DETECTOR: dict = {}


def ensure_face_detector() -> bool:
    """Download OpenCV's YuNet face detector (~230 KB, opencv_zoo) once; the guide calls this at start."""
    if not FACE_MODEL.exists():
        try:
            import urllib.request

            FACE_MODEL.parent.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(FACE_MODEL_URL, FACE_MODEL)
        except Exception as e:  # noqa: BLE001 - head boxes from the skeleton still blank faces
            print(f"note: face detector not available ({type(e).__name__}); blanking heads from the skeleton only", file=sys.stderr)
            return False
    return True


def detect_faces(crop: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Faces in a crop (OpenCV YuNet), a second blanking layer that does not depend on the skeleton.
    Without the model file (not downloaded): no detections; the head boxes still apply."""
    if not FACE_MODEL.exists():
        return []
    h, w = crop.shape[:2]
    det = _DETECTOR.get("yunet")
    if det is None:
        det = _DETECTOR["yunet"] = cv2.FaceDetectorYN.create(str(FACE_MODEL), "", (w, h), 0.6, 0.3, 50)
    det.setInputSize((w, h))
    _, faces = det.detect(crop)
    if faces is None:
        return []
    return [(int(f[0]), int(f[1]), int(f[2]), int(f[3])) for f in faces]


def guide_prompts() -> dict:
    """CLIP vocabulary for the voice guide: the catalog (answers from the bin table) plus dangerous items."""
    return {**ITEM_PROMPTS, **HAZARD_PROMPTS}


def _blank_faces(crop: np.ndarray, x0: int, y0: int, heads: list) -> np.ndarray:
    """Fail closed: black out every head region (all tracked people) and every face the detector finds."""
    for h in heads:
        if h is not None:
            cv2.rectangle(crop, (int(h[0]) - x0, int(h[1]) - y0), (int(h[2]) - x0, int(h[3]) - y0), (0, 0, 0), -1)
    for fx, fy, fw, fh in detect_faces(crop):
        cv2.rectangle(crop, (fx, fy), (fx + fw, fy + fh), (0, 0, 0), -1)
    return crop


ITEM_P = 0.5        # CLIP P(item) for a hand crop to count as holding something
KNOWN_P = 0.6       # share of category votes needed to answer from the catalog without the LLM
MIN_VOTES = 3       # crops voting before a catalog answer
MIN_CROPS = 2       # item crops before the LLM is asked
CROP_GAP_S = 0.5    # kept crops at least this far apart (different moments/angles)
KEEP_CROPS = 3
HOLD_WINDOW_S = 1.0  # "holding" = an item seen in a hand within the last second
OBSERVE_EVERY_S = 0.1  # CLIP on a person's hands at most 10 times a second (speed; the hand moves little in 0.1 s)


class _Person:
    def __init__(self, n_cats: int):
        self.votes = np.zeros(n_cats, np.float64)
        self.n_votes = 0
        self.crops: list[tuple[float, float, np.ndarray]] = []  # (t, p_item, crop)
        self.last_held = -1e9
        self.job: Future | None = None


class ItemWatcher:
    def __init__(self, embed, scorer, table: dict, namer=None, advisor=None, executor: Executor | None = None):
        """embed(list[crop]) -> embeddings; scorer(emb) -> (p_item[n], p_cat[n, cats]) with scorer.cats."""
        self.embed, self.scorer, self.table = embed, scorer, table
        self.namer, self.advisor = namer, advisor
        self.executor = executor or ThreadPoolExecutor(max_workers=2)
        self.people: dict[int, _Person] = {}
        self.last_observed: dict[int, float] = {}
        self.heads: list = []

    def _person(self, track_id: int) -> _Person:
        return self.people.setdefault(track_id, _Person(len(self.scorer.cats)))

    def observe(self, track_id: int, t: float, frame: np.ndarray, kp) -> None:
        if t - self.last_observed.get(track_id, -1e9) < OBSERVE_EVERY_S:
            return
        self.last_observed[track_id] = t
        h, w = frame.shape[:2]
        crops = []
        for side in ("L", "R"):
            b = hand_box(kp, side, w, h)
            if b is not None:
                x0, y0, x1, y1 = (int(v) for v in b)
                if x1 > x0 + 4 and y1 > y0 + 4:
                    crops.append(_blank_faces(frame[y0:y1, x0:x1].copy(), x0, y0, [head_box(kp), *self.heads]))
        if not crops:
            return
        p_item, p_cat = self.scorer(self.embed(crops))
        k = int(np.argmax(p_item))
        if p_item[k] < ITEM_P:
            return
        p = self._person(track_id)
        p.last_held = t
        p.votes += p_cat[k] * p_item[k]
        p.n_votes += 1
        if all(abs(t - c[0]) >= CROP_GAP_S for c in p.crops):
            p.crops.append((t, float(p_item[k]), crops[k]))
            p.crops = sorted(p.crops, key=lambda c: -c[1])[:KEEP_CROPS]
        if (p.job is None and self.namer is not None and len(p.crops) >= MIN_CROPS and p.n_votes >= MIN_VOTES
                and self._catalog(p) is None):  # CLIP had its votes and still is not sure: ask the LLM
            p.job = self.executor.submit(self._identify, [c[2] for c in sorted(p.crops)])

    def holding(self, track_id: int, now: float) -> bool:
        p = self.people.get(track_id)
        return p is not None and now - p.last_held <= HOLD_WINDOW_S

    def _catalog(self, p: _Person) -> dict | None:
        if p.n_votes < MIN_VOTES or p.votes.sum() <= 0:
            return None
        k = int(np.argmax(p.votes))
        cid = self.scorer.cats[k]
        if p.votes[k] / p.votes.sum() >= KNOWN_P and cid in self.table:
            return gm.from_catalog(cid, self.table)
        return None

    def answer(self, track_id: int, now: float) -> tuple[dict, str] | None:
        """(message, "catalog" | "llm"), or None while nothing is known yet."""
        p = self.people.get(track_id)
        if p is None:
            return None
        known = self._catalog(p)
        if known is not None:
            return known, "catalog"
        if p.job is not None and p.job.done() and p.job.exception() is None and p.job.result() is not None:
            return p.job.result(), "llm"
        return None

    def set_heads(self, heads: list) -> None:
        """Head regions of everyone in the current frame (the guide sets this each frame)."""
        self.heads = [h for h in heads if h is not None]

    def forget(self, track_id: int) -> None:
        """The person is gone: drop their crops and votes, and cancel an LLM job that has not started."""
        p = self.people.pop(track_id, None)
        if p is not None and p.job is not None:
            p.job.cancel()
        self.last_observed.pop(track_id, None)

    def failed(self, track_id: int) -> bool:
        p = self.people.get(track_id)
        return p is not None and p.job is not None and p.job.done() and p.job.exception() is not None

    def _identify(self, crops: list[np.ndarray]) -> dict | None:
        try:
            ans = self.namer.name(crops)
            if ans and ans.get("catalog_item_id") in self.table:
                return gm.from_catalog(ans["catalog_item_id"], self.table)
            gt = generic_type({"what": (ans or {}).get("what"), "generic": self.namer.describe(crops) or {}})
            if gt is None:
                return gm.default_trash((ans or {}).get("what"))
            if self.advisor is not None and getattr(self.advisor, "available", True):
                gt = self.advisor.suggest(gt)
            return gm.from_suggestion(for_event(gt))
        except Exception as e:
            print(f"note: identification failed ({type(e).__name__}); trash on arrival", file=sys.stderr)
            raise
