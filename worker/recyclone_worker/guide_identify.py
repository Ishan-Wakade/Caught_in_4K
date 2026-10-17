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
FACE_KPS = (0, 1, 2, 3, 4)  # nose, eyes, ears: blanked in every kept crop (faces never leave the device)


def guide_prompts() -> dict:
    """CLIP vocabulary for the voice guide: the catalog (answers from the bin table) plus dangerous items."""
    return {**ITEM_PROMPTS, **HAZARD_PROMPTS}


def _blank_face(crop: np.ndarray, kp, x0: int, y0: int) -> np.ndarray:
    eyes = [kp[j][:2] for j in (1, 2) if kp[j][2] > 0.3]
    r = int(max(12, 1.5 * float(np.hypot(*(eyes[0] - eyes[1]))) if len(eyes) == 2 else 0.12 * max(crop.shape[:2])))
    for j in FACE_KPS:
        if kp[j][2] > 0.3:
            cv2.circle(crop, (int(kp[j][0]) - x0, int(kp[j][1]) - y0), r, (0, 0, 0), -1)
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
                    crops.append(_blank_face(frame[y0:y1, x0:x1].copy(), kp, x0, y0))
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
