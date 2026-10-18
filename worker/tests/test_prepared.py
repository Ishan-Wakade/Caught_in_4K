"""Prerecorded demo ("store-tuned"): pass 1 sees the whole clip and identifies each person's item once, with no
deadline; pass 2 is the normal causal guide with those answers ready, on the same skeletons."""

from concurrent.futures import ThreadPoolExecutor

import numpy as np

from recyclone_worker import demo_watcher as gi
from recyclone_worker import guide_message as gm
from recyclone_worker import prepared as pr

TABLE = gm.load_bin_table(gm.WORKER_RULES / "cambridge-ma-2022.bins.json")
FRAME = np.zeros((480, 640, 3), np.uint8)
CAN = {"bin": "recycle", "item": "aluminum can", "place": "recycling", "reason": "metal cans are recyclable in Cambridge"}


def arm_kp():
    k = np.zeros((17, 3), np.float32)
    k[7], k[9] = (300, 200, 0.9), (300, 300, 0.9)
    return k


class FakeScorer:
    def __init__(self, probs):
        self.cats = ["item_generic_can", "item_napkin", "item_chip_bag"]
        self.row = np.array([probs.get(c, 0.0) for c in self.cats], np.float32)

    def __call__(self, emb):
        return np.full(len(emb), 0.9, np.float32), np.tile(self.row, (len(emb), 1))


def embed(crops):
    return np.ones((len(crops), 4), np.float32)


class FakeNamer:
    def __init__(self, catalog_id=None):
        self.catalog_id, self.calls = catalog_id, 0

    def name(self, crops):
        self.calls += 1
        return {"catalog_item_id": self.catalog_id, "what": "a thing", "confidence": 0.9}

    def describe(self, crops):
        return {"name": "face mask", "material": "textile", "form": "mask", "condition": "clean", "hazardous": False}


def watched(probs, namer=None, frames=6):
    w = gi.DemoItemWatcher(embed, FakeScorer(probs), TABLE, namer=namer, executor=ThreadPoolExecutor(1))
    poses = pr.RecordingPose(lambda frame: [(1, arm_kp())])
    pr.observe_clip([(k, k * 0.6, FRAME) for k in range(frames)], poses, w)
    return w, poses


def test_pass_one_never_calls_the_llm_while_watching():
    namer = FakeNamer("item_napkin")
    w, _ = watched({"item_generic_can": 0.4, "item_napkin": 0.35}, namer=namer)
    assert namer.calls == 0 and w.people[1].crops  # crops kept for the one call afterwards


def test_each_person_is_identified_once_from_their_best_crops():
    namer = FakeNamer("item_napkin")
    w, _ = watched({"item_generic_can": 0.4, "item_napkin": 0.35}, namer=namer)
    answers = pr.prepare_answers(w)
    assert answers == {1: ({"bin": "compost", "item": "paper napkin", "place": "compost", "reason": "napkins and paper towels are compostable"}, "llm")}
    assert namer.calls == 1


def test_a_confident_catalog_item_needs_no_network():
    namer = FakeNamer()
    w, _ = watched({"item_generic_can": 0.9, "item_napkin": 0.1}, namer=namer)
    assert pr.prepare_answers(w) == {1: (CAN, "catalog")} and namer.calls == 0


def test_item_override_skips_identification_entirely():
    namer = FakeNamer("item_napkin")
    w, _ = watched({"item_generic_can": 0.4, "item_napkin": 0.35}, namer=namer)
    assert pr.prepare_answers(w, item="item_generic_can") == {1: (CAN, "store")} and namer.calls == 0


def test_replay_gives_pass_two_the_same_skeletons_in_order():
    script = iter([[(1, arm_kp())], [(2, arm_kp())], []])
    rec = pr.RecordingPose(lambda frame: next(script))
    for _ in range(3):
        rec(FRAME)
    replay = pr.ReplayPose(rec.frames)
    assert [[tid for tid, _ in replay(FRAME)] for _ in range(3)] == [[1], [2], []]


def test_prepared_watcher_answers_at_once_while_the_person_holds_the_item():
    w, _ = watched({"item_generic_can": 0.4, "item_napkin": 0.35})
    pw = pr.PreparedWatcher(w, {1: (CAN, "llm")})
    assert pw.holding(1, 3.0) and pw.answer(1, 3.0) == (CAN, "llm") and not pw.pending(1) and not pw.failed(1)
    assert pw.answer(7, 3.0) is None  # nobody prepared: the guide's usual rules apply


def test_cli_prepared_render_writes_the_video_and_a_json_for_the_ui(tmp_path):
    import json

    import cv2

    from recyclone_worker import cli

    clip = tmp_path / "c.mp4"
    out = cv2.VideoWriter(str(clip), cv2.VideoWriter_fourcc(*"mp4v"), 10, (1280, 720))
    for _ in range(50):
        out.write(np.zeros((720, 1280, 3), np.uint8))
    out.release()

    def walker():
        n = {"i": 0}

        def pose(frame):
            i = n["i"] % 50  # the same walk in both passes
            n["i"] += 1
            fx, fy, h = 300 + i * 12, 700, 340
            k = np.zeros((17, 3), np.float32)
            top = fy - h / 0.87
            k[0] = (fx, fy - h, 0.9)
            k[5], k[6] = (fx + 20, top + 60, 0.9), (fx - 20, top + 60, 0.9)
            k[7], k[9] = (fx + 30, top + 130, 0.9), (fx + 30, top + 200, 0.9)
            k[11], k[12] = (fx + 15, top + 180, 0.9), (fx - 15, top + 180, 0.9)
            k[15], k[16] = (fx + 10, fy, 0.9), (fx - 10, fy, 0.9)
            return [(1, k)]
        return pose

    def parts(args, area):
        return walker(), gi.DemoItemWatcher(embed, FakeScorer({"item_generic_can": 0.4, "item_napkin": 0.35}), TABLE,
                                        executor=ThreadPoolExecutor(1))

    code = cli.main(["guide", "--source", str(clip), "--area", "800,300,1000,700", "--voice", "silent", "--no-stream",
                     "--prepared", "--item", "item_generic_can", "--log", str(tmp_path / "g.jsonl"),
                     "--render", str(tmp_path / "demo.mp4")], make_guide_parts=parts)
    assert code == 0 and (tmp_path / "demo.mp4").exists()
    report = json.loads((tmp_path / "demo.json").read_text())
    assert report["prepared"] is True and report["video"].endswith("demo.mp4")
    assert [a["source"] for a in report["announcements"]] == ["store"]
    assert report["announcements"][0]["message"] == CAN
    assert report["items"] == [{"track_id": 1, "message": CAN, "source": "store"}]


def test_a_person_whose_item_cannot_be_identified_is_not_announced_in_the_prepared_demo():
    """Background passers-by: CLIP thought they held something, DeepSeek could not see any object."""

    class BlurNamer(FakeNamer):
        def name(self, crops):
            self.calls += 1
            return {"catalog_item_id": None, "what": "blurry image, unclear object", "confidence": 0.1}

        def describe(self, crops):
            return {"name": "unknown object", "identifiable": False, "material": "unknown", "form": "unknown"}

    w, _ = watched({"item_generic_can": 0.4, "item_napkin": 0.35}, namer=BlurNamer())
    answers = pr.prepare_answers(w)
    assert answers == {1: (None, "nothing")}
    pw = pr.PreparedWatcher(w, answers)
    assert not pw.holding(1, 3.0) and pw.answer(1, 3.0) is None


def test_a_failed_identification_is_trash_not_silence():
    """Every Claude call failed (HTTP 400) and everyone was silenced as "nothing identifiable"."""

    class DownNamer(FakeNamer):
        def name(self, crops):
            self.calls += 1
            return None

        def describe(self, crops):
            return None

    w, _ = watched({"item_generic_can": 0.4, "item_napkin": 0.35}, namer=DownNamer())
    assert pr.prepare_answers(w) == {1: (gm.default_trash(None), "default")}


def test_people_with_small_hands_are_background_and_never_sent_to_the_llm():
    """IMG_2958: a passer-by across the street (72 px hand crops vs 170-196 px) was announced before the real person."""
    namer = FakeNamer("item_napkin")
    w, _ = watched({"item_generic_can": 0.4, "item_napkin": 0.35}, namer=namer)
    biggest = max(max(c[2].shape[:2]) for c in w.people[1].crops)
    assert pr.prepare_answers(w, min_hand_px=biggest + 1) == {1: (None, "nothing")} and namer.calls == 0
    assert pr.prepare_answers(w, min_hand_px=biggest)[1][1] == "llm"


def test_pass_one_records_where_each_persons_item_was_while_held():
    w = gi.DemoItemWatcher(embed, FakeScorer({"item_generic_can": 0.4, "item_napkin": 0.35}), TABLE, executor=ThreadPoolExecutor(1))
    trace = {}
    pr.observe_clip([(k, k * 0.6, FRAME) for k in range(6)], pr.RecordingPose(lambda frame: [(1, arm_kp())]), w, trace=trace)
    assert len(trace[1]) == 6 and trace[1][0][0] == 0.0
    assert any(box is not None for _, box, _ in trace[1])  # boxes while held


def test_cli_area_auto_finds_the_bins_and_reports_the_bin_it_went_into(tmp_path, monkeypatch):
    import json

    import cv2

    from recyclone_worker import bins, cli

    clip = tmp_path / "c.mp4"
    out = cv2.VideoWriter(str(clip), cv2.VideoWriter_fourcc(*"mp4v"), 10, (1280, 720))
    for _ in range(50):
        out.write(np.zeros((720, 1280, 3), np.uint8))
    out.release()
    # the hand box ends over this opening when the walker reaches x=900 (see walker below)
    monkeypatch.setattr(bins, "detect_openings", lambda frame, cache_dir, **kw: [
        {"bin": "recycle", "label": "RECYCLING", "box": (880, 300, 1000, 380)}])

    def walker():
        n = {"i": 0}

        def pose(frame):
            i = n["i"] % 50
            n["i"] += 1
            fx = 300 + min(i, 40) * 15
            k = np.zeros((17, 3), np.float32)
            k[0] = (fx, 300, 0.9)
            k[5], k[6] = (fx + 20, 360, 0.9), (fx - 20, 360, 0.9)
            k[7], k[9] = (fx + 30, 300, 0.9), (fx + 30, 330, 0.9)
            k[11], k[12] = (fx + 15, 480, 0.9), (fx - 15, 480, 0.9)
            k[15], k[16] = (fx + 10, 700, 0.9), (fx - 10, 700, 0.9)
            return [(1, k)]
        return pose

    def parts(args, area):
        return walker(), gi.DemoItemWatcher(embed, FakeScorer({"item_generic_can": 0.4, "item_napkin": 0.35}), TABLE,
                                            executor=ThreadPoolExecutor(1))

    code = cli.main(["guide", "--source", str(clip), "--area", "auto", "--voice", "silent", "--no-stream", "--prepared",
                     "--item", "item_generic_can", "--log", str(tmp_path / "g.jsonl"), "--render", str(tmp_path / "demo.mp4")],
                    make_guide_parts=parts)
    assert code == 0
    report = json.loads((tmp_path / "demo.json").read_text())
    assert report["openings"][0]["label"] == "RECYCLING"
    assert report["outcomes"] == [{"track_id": 1, "recommended": "recycle", "thrown_into": "recycle", "correct": True,
                                   "t": report["outcomes"][0]["t"]}]


def test_someone_seen_with_an_item_only_briefly_is_not_identified():
    """IMG_2960: 4 sightings of an empty hand became "metal handle bar"; real carriers had 18-76."""
    namer = FakeNamer("item_napkin")
    w, _ = watched({"item_generic_can": 0.4, "item_napkin": 0.35}, namer=namer, frames=3)
    assert pr.prepare_answers(w, min_votes=6) == {1: (None, "nothing")} and namer.calls == 0


def test_the_demo_memory_goes_next_to_the_log_not_into_the_real_state_folder(tmp_path):
    from recyclone_worker import cli
    assert cli.demo_memory_dir(tmp_path / "g.jsonl") == tmp_path / "demo-memory"
