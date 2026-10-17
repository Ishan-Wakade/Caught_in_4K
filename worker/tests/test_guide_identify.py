"""Early identification: catalog items from CLIP at once; otherwise DeepSeek + Jev once, in the background."""

from concurrent.futures import ThreadPoolExecutor

import numpy as np

from recyclone_worker import guide_identify as gi
from recyclone_worker import guide_message as gm

TABLE = gm.load_bin_table(gm.WORKER_RULES / "cambridge-ma-2022.bins.json")
FRAME = np.zeros((480, 640, 3), np.uint8)


def arm_kp():
    k = np.zeros((17, 3), np.float32)
    k[7], k[9] = (300, 200, 0.9), (300, 300, 0.9)   # left elbow, wrist: a hand box below the wrist
    return k


class FakeScorer:
    """p_item and category probabilities chosen by the test; cats like items.Scorer.cats."""

    def __init__(self, p_item, probs: dict):
        self.cats = ["item_generic_can", "item_napkin", "item_chip_bag"]
        self.p_item, self.row = p_item, np.array([probs.get(c, 0.0) for c in self.cats], np.float32)

    def __call__(self, emb):
        n = len(emb)
        return np.full(n, self.p_item, np.float32), np.tile(self.row, (n, 1))


def embed(crops):
    return np.ones((len(crops), 4), np.float32)


class FakeNamer:
    def __init__(self, catalog_id=None, generic=None, fail=False):
        self.catalog_id, self.generic, self.fail, self.calls = catalog_id, generic, fail, 0

    def name(self, crops):
        self.calls += 1
        if self.fail:
            raise RuntimeError("network down")
        return {"catalog_item_id": self.catalog_id, "what": "a thing", "confidence": 0.8}

    def describe(self, crops):
        return self.generic


class FakeAdvisor:
    available = True

    def suggest(self, gt):
        return dict(gt, suggested_destination="special", suggestion_confidence=0.95, rule_source="town")


def watch(scorer, namer=None, advisor=None, frames=4):
    w = gi.ItemWatcher(embed, scorer, TABLE, namer=namer, advisor=advisor, executor=ThreadPoolExecutor(1))
    for k in range(frames):
        w.observe(1, k * 0.6, FRAME, arm_kp())
    return w


def wait(w, track=1):
    for _ in range(200):
        a = w.answer(track, 10.0)
        if a is not None:
            return a
        import time
        time.sleep(0.01)
    return None


def test_catalog_item_answered_without_network():
    namer = FakeNamer()
    w = watch(FakeScorer(0.9, {"item_generic_can": 0.9, "item_napkin": 0.1}), namer=namer)
    assert w.answer(1, 3.0) == ({"bin": "recycle", "explanation": "aluminum can, placed in recycling"}, "catalog")
    assert namer.calls == 0


def test_unknown_item_goes_to_llm_then_jev_once():
    namer = FakeNamer(catalog_id=None, generic={"name": "battery", "material": "mixed", "form": "battery",
                                                 "condition": "clean", "hazardous": True})
    w = watch(FakeScorer(0.9, {"item_generic_can": 0.4, "item_napkin": 0.35}), namer=namer, advisor=FakeAdvisor())
    msg, source = wait(w)
    w.answer(1, 11.0)
    assert source == "llm" and msg["bin"] == "none" and "Recycle Center" in msg["explanation"]
    assert namer.calls == 1  # asked once, although answer() was called many times


def test_llm_catalog_match_uses_the_table():
    namer = FakeNamer(catalog_id="item_napkin")
    w = watch(FakeScorer(0.9, {"item_generic_can": 0.5, "item_napkin": 0.5}), namer=namer)
    assert wait(w) == ({"bin": "compost", "explanation": "paper napkin, placed in compost"}, "llm")


def test_llm_failure_gives_none_so_the_guide_defaults_to_trash():
    w = watch(FakeScorer(0.9, {"item_generic_can": 0.5, "item_napkin": 0.5}), namer=FakeNamer(fail=True))
    import time
    time.sleep(0.1)
    assert w.answer(1, 10.0) is None and w.failed(1)


def test_empty_hand_is_not_holding():
    w = watch(FakeScorer(0.1, {"item_napkin": 1.0}))
    assert not w.holding(1, 3.0) and w.answer(1, 3.0) is None
    w2 = watch(FakeScorer(0.9, {"item_napkin": 1.0}))
    assert w2.holding(1, 2.0) and not w2.holding(1, 5.0)  # last seen at 1.8 s; 1 s window
