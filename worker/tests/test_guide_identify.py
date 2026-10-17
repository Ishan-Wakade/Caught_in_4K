"""Early identification: catalog items from CLIP at once; otherwise DeepSeek + Jev once, in the background."""

from concurrent.futures import ThreadPoolExecutor

import numpy as np

from recyclone_worker import guide_identify as gi
from recyclone_worker import guide_message as gm

TABLE = gm.load_bin_table(gm.WORKER_RULES / "cambridge-ma-2022.bins.json")


import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def face_detector(monkeypatch):
    """Tests run without the YuNet file: pretend it is loaded and finds nothing (tests opt out explicitly)."""
    monkeypatch.setattr(gi, "face_detector_ready", lambda: True)
    monkeypatch.setattr(gi, "detect_faces", lambda crop: [])


def kept_or_dropped(w, track=1):
    crops = w.people[track].crops
    return crops[0][2] if crops else None
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


def test_clip_runs_at_most_every_observe_interval():
    calls = []
    sc = FakeScorer(0.9, {"item_generic_can": 1.0})

    def counting_embed(crops):
        calls.append(len(crops))
        return np.ones((len(crops), 4), np.float32)
    w = gi.ItemWatcher(counting_embed, sc, TABLE, executor=ThreadPoolExecutor(1))
    for k in range(30):  # one second at 30 fps
        w.observe(1, k / 30, FRAME, arm_kp())
    assert len(calls) <= 1 / gi.OBSERVE_EVERY_S + 1


# ---- review fixes (17 Oct)
def test_face_is_blanked_in_kept_crops():
    frame = np.full((480, 640, 3), 255, np.uint8)
    k = arm_kp()
    k[0] = (300, 330, 0.9)  # the nose sits inside the hand crop (drinking)
    w = gi.ItemWatcher(embed, FakeScorer(0.9, {"item_generic_can": 0.1}), TABLE, executor=ThreadPoolExecutor(1))
    w.observe(1, 0.0, frame, k)
    crop = kept_or_dropped(w)
    from recyclone_worker.items import hand_box
    x0, y0, _, _ = (int(v) for v in hand_box(k, "L", 640, 480))
    assert crop is None or crop[330 - y0, 300 - x0].sum() == 0  # dropped, or the face blanked


def test_guide_vocabulary_has_dangerous_items_that_are_not_in_the_catalog():
    prompts = gi.guide_prompts()
    hazards = [c for c in prompts if c.startswith("hazard:")]
    assert hazards and not set(hazards) & set(TABLE)  # never answered from the catalog: always the LLM path


def test_forget_drops_a_person():
    w = watch(FakeScorer(0.9, {"item_napkin": 1.0}))
    w.forget(1)
    assert 1 not in w.people and w.answer(1, 3.0) is None


# ---- security review (17 Oct): face blanking must fail closed
def test_another_persons_head_in_the_crop_is_blanked():
    frame = np.full((480, 640, 3), 255, np.uint8)
    w = gi.ItemWatcher(embed, FakeScorer(0.9, {"item_generic_can": 0.1}), TABLE, executor=ThreadPoolExecutor(1))
    other = np.zeros((17, 3), np.float32)
    other[0], other[5], other[6] = (310, 340, 0.9), (290, 380, 0.9), (330, 380, 0.9)  # someone's face behind the hand
    w.set_heads([gi.head_box(other)])
    w.observe(1, 0.0, frame, arm_kp())
    crop = w.people[1].crops[0][2]
    from recyclone_worker.items import hand_box
    x0, y0, _, _ = (int(v) for v in hand_box(arm_kp(), "L", 640, 480))
    assert crop[340 - y0, 310 - x0].sum() == 0


def test_low_confidence_face_points_are_still_blanked():
    frame = np.full((480, 640, 3), 255, np.uint8)
    k = arm_kp()
    k[0] = (300, 330, 0.1)  # the model is unsure about the nose, but it is a face: blank anyway
    w = gi.ItemWatcher(embed, FakeScorer(0.9, {"item_generic_can": 0.1}), TABLE, executor=ThreadPoolExecutor(1))
    w.observe(1, 0.0, frame, k)
    from recyclone_worker.items import hand_box
    x0, y0, _, _ = (int(v) for v in hand_box(k, "L", 640, 480))
    crop = kept_or_dropped(w)
    assert crop is None or crop[330 - y0, 300 - x0].sum() == 0


def test_faces_found_by_the_face_detector_are_blanked(monkeypatch):
    frame = np.full((480, 640, 3), 255, np.uint8)
    monkeypatch.setattr(gi, "detect_faces", lambda crop: [(2, 2, 10, 10)])  # x, y, w, h inside the crop
    w = gi.ItemWatcher(embed, FakeScorer(0.9, {"item_generic_can": 0.1}), TABLE, executor=ThreadPoolExecutor(1))
    w.observe(1, 0.0, frame, arm_kp())
    assert w.people[1].crops[0][2][6, 6].sum() == 0


# ---- security review 2 (17 Oct): no crop leaves the device unless faces can be removed
def test_without_a_face_detector_no_crop_is_sent(monkeypatch):
    monkeypatch.setattr(gi, "face_detector_ready", lambda: False)
    namer = FakeNamer(catalog_id=None, generic={"name": "x", "material": "mixed", "form": "thing", "condition": "clean", "hazardous": False})
    w = watch(FakeScorer(0.9, {"item_generic_can": 0.4, "item_napkin": 0.35}), namer=namer)
    import time
    time.sleep(0.1)
    assert namer.calls == 0 and w.holding(1, 2.0)  # still seen as holding (local CLIP), just never sent


def test_a_head_whose_size_cannot_be_estimated_drops_the_crop(monkeypatch):
    monkeypatch.setattr(gi, "face_detector_ready", lambda: True)
    frame = np.full((480, 640, 3), 255, np.uint8)
    k = arm_kp()
    k[0] = (300, 330, 0.9)  # a lone nose point inside the crop: no eyes, no shoulders, nothing to size the head by
    k[7, 2] = 0.25           # elbow barely visible: the body extent is unknown too
    w = gi.ItemWatcher(embed, FakeScorer(0.9, {"item_generic_can": 0.1}), TABLE, executor=ThreadPoolExecutor(1))
    w.observe(1, 0.0, frame, k)
    assert w.holding(1, 0.5) and w.people[1].crops == []


def test_head_size_scales_with_the_person():
    small, big = np.zeros((17, 3), np.float32), np.zeros((17, 3), np.float32)
    for k, s in ((small, 1.0), (big, 3.0)):
        k[0], k[1], k[2] = (100 * s, 50 * s, 0.9), (95 * s, 45 * s, 0.9), (105 * s, 45 * s, 0.9)
        k[5], k[6], k[15] = (80 * s, 80 * s, 0.9), (120 * s, 80 * s, 0.9), (100 * s, 300 * s, 0.9)
    (b_small, ok_small), (b_big, ok_big) = gi.head_box(small), gi.head_box(big)
    assert ok_small and ok_big and (b_big[2] - b_big[0]) > 2.5 * (b_small[2] - b_small[0])
