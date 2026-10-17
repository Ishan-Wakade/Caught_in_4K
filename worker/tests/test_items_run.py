"""`run --tracker items`: playing an analyzed clip back as events (no models: the analysis is built by hand)."""

import json

import cv2
import numpy as np
import pytest

from recyclone_worker import cli
from recyclone_worker.events import validate_event
from recyclone_worker.item_playback import ItemPlayback
from recyclone_worker.items import Analysis, destination_confidence, item_from_votes, site_bin_boxes
from recyclone_worker.site import load_site

CATS = ["item_shakeshack_cup", "item_generic_cup", "item_generic_box"]
N, FPS, W, H = 40, 10.0, 640, 360
TRASH = (100, 100, 300, 300)


def fake_analysis(drop_frame=20, votes=(0.0, 3.0, 1.0), bin_id="bin_patio_trash") -> Analysis:
    # one item (track 5) carried from the left into the trash box, last seen at drop_frame
    frames = list(range(5, drop_frame + 1))
    boxes = [[40 + 8 * k, 150, 80 + 8 * k, 190] for k in range(len(frames))]
    root = {"id": 5, "frames": frames, "boxes": boxes, "cat": np.array(votes, np.float32), "cats": CATS,
            "category": CATS[int(np.argmax(votes))] if sum(votes) else None, "src": [0] * len(frames)}
    per_frame = [[] for _ in range(N)]
    for f, b in zip(frames, boxes):
        per_frame[f].append((5, b, 0.9))
    data = {"fps": np.float32(FPS), "size": np.array([W, H]), "kps": np.zeros((N, 17, 3), np.float32), "_identity": {5: 5}}
    events = [{"frame": drop_frame, "bin": bin_id, "item_id": 5, "track": 5, "item": root["category"], "how": "vanished in bin"}]
    return Analysis(data, {bin_id: [TRASH] * N}, [root], per_frame, {5: "carried"}, events)


def frames(n=N):
    for i in range(n):
        yield i, i / FPS, np.full((H, W, 3), 90, np.uint8)


class ListSink:
    def __init__(self):
        self.sent = []

    def send(self, e):
        self.sent.append(e)


def play(analysis, tmp_path, n=N, **kw):
    sink = ListSink()
    from datetime import UTC, datetime

    pb = ItemPlayback(analysis, sink, camera_id="cam_patio_1", clip_id="c1", started_at=datetime(2026, 10, 17, tzinfo=UTC),
                      evidence_dir=tmp_path / "ev", **kw)
    return pb.run(frames(n)), sink


def test_one_valid_event_per_drop_sent_when_the_video_reaches_it(tmp_path):
    seen = []
    a = fake_analysis(drop_frame=20)
    sink = ListSink()
    from datetime import UTC, datetime

    def on_frame(img):
        seen.append(len(sink.sent))  # events sent so far, at each published frame

    ItemPlayback(a, sink, camera_id="cam_patio_1", clip_id="c1", started_at=datetime(2026, 10, 17, tzinfo=UTC),
                 evidence_dir=tmp_path / "ev", on_frame=on_frame).run(frames())
    assert len(sink.sent) == 1
    validate_event(sink.sent[0])
    assert seen[19] == 0 and seen[20] == 1  # not before the drop frame, at it
    e = sink.sent[0]
    assert e["bin_id"] == "bin_patio_trash" and e["source"]["track_id"] == 5 and e["clip_offset_s"] == 2.0


def test_replaying_gives_the_same_event_ids(tmp_path):
    (first, _), (second, _) = play(fake_analysis(), tmp_path), play(fake_analysis(), tmp_path)
    assert [e["event_id"] for e in first] == [e["event_id"] for e in second]


def test_evidence_crop_is_the_items_last_sighting(tmp_path):
    sent, _ = play(fake_analysis(drop_frame=20), tmp_path)
    ev = sent[0]["evidence"][0]
    assert ev["frame"] == 20 and (tmp_path / "ev" / ev["uri"].removeprefix("evidence/")).is_file()


def test_drop_after_the_source_ends_is_still_reported(tmp_path):
    sent, _ = play(fake_analysis(drop_frame=30), tmp_path, n=25)
    assert len(sent) == 1 and sent[0]["evidence"] == []  # no frame to crop from, but no lost event


def test_item_is_the_vote_distribution_and_unknown_without_votes():
    item = item_from_votes(fake_analysis(votes=(0.0, 3.0, 1.0)).tracks[0])
    assert item["catalog_item_id"] == "item_generic_cup" and item["confidence"] == 0.75
    assert [c["catalog_item_id"] for c in item["candidates"]][:2] == ["item_generic_cup", "item_generic_box"]
    unknown = item_from_votes(fake_analysis(votes=(0.0, 0.0, 0.0)).tracks[0])
    assert unknown == {"catalog_item_id": None, "label": None, "confidence": None, "candidates": []}


def test_branded_item_carries_its_business(tmp_path):
    sent, _ = play(fake_analysis(votes=(5.0, 1.0, 0.0)), tmp_path, catalog_business={"item_shakeshack_cup": "biz_shakeshack"})
    assert sent[0]["business"]["business_id"] == "biz_shakeshack"


def test_destination_confidence_is_the_share_of_last_sightings_inside_the_bin():
    a = fake_analysis(drop_frame=20)  # x centers 60..188 over frames 5..20; TRASH (with 10% margin) starts at 80
    c = destination_confidence(a, a.events[0])
    inside = sum(80 <= 60 + 8 * k <= 320 for k in range(16)[-10:])
    assert c == round(inside / 10, 4) and 0 < c <= 1


def test_site_bin_boxes_from_normalized_regions():
    boxes = site_bin_boxes(load_site("cam_patio_1").regions, (1280, 720), 3)
    assert set(boxes) == {"bin_patio_trash", "bin_patio_recycling", "bin_patio_compost"}
    x0, y0, x1, y1 = boxes["bin_patio_trash"][0]
    assert 0 <= x0 < x1 <= 1280 and 0 <= y0 < y1 <= 720 and len(boxes["bin_patio_trash"]) == 3


def make_clip(path, n=N):
    out = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), FPS, (W, H))
    for _ in range(n):
        out.write(np.full((H, W, 3), 90, np.uint8))
    out.release()


def test_cli_run_items_dry_run(tmp_path, capsys):
    clip = tmp_path / "c.mp4"
    make_clip(clip)
    calls = []

    def analyze(video, cache, bins_for):
        calls.append(bins_for((W, H), N))
        return fake_analysis()

    code = cli.main(["run", "--tracker", "items", "--clip", str(clip), "--clip-id", "t1", "--dry-run", "--no-stream",
                     "--evidence-dir", str(tmp_path / "ev"), "--items-cache", str(tmp_path / "cache")], analyze_items=analyze)
    assert code == 0
    assert set(calls[0]) == {"bin_patio_trash", "bin_patio_recycling", "bin_patio_compost"}  # site regions by default
    printed = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
    assert len(printed) == 1 and printed[0]["bin_id"] == "bin_patio_trash"


def test_cli_item_bins_file_and_unknown_bin_warning(tmp_path, capsys):
    clip = tmp_path / "c.mp4"
    make_clip(clip)
    cfg = tmp_path / "bins.json"
    cfg.write_text(json.dumps({"t1": {"bins": [{"bin_id": "bin_wall_slot", "keyframes": [[0, [10, 10, 50, 50]]], "visible": [0, N - 1]}]}}))
    got = []

    def analyze(video, cache, bins_for):
        got.append(bins_for((W, H), N))
        return fake_analysis(bin_id="bin_wall_slot")

    cli.main(["run", "--tracker", "items", "--clip", str(clip), "--clip-id", "t1", "--dry-run", "--no-stream",
              "--evidence-dir", str(tmp_path / "ev"), "--item-bins", str(cfg)], analyze_items=analyze)
    assert list(got[0]) == ["bin_wall_slot"] and got[0]["bin_wall_slot"][0] == (10.0, 10.0, 50.0, 50.0)
    assert "bin_wall_slot" in capsys.readouterr().err  # not in the site config: warned, core would reject it


def test_enroll_does_not_accept_the_items_tracker():
    with pytest.raises(SystemExit):
        cli.main(["enroll", "--clip", "x", "--segments", "y", "--out", "z", "--tracker", "items"])


# ---------------------------------------------------------------- IoU rules in the item tracker (17 Oct)

from recyclone_worker import items as it  # noqa: E402

HAND = (100, 100, 200, 200)


def test_a_large_item_covering_the_hand_is_held():
    # the old rule needed half of the ITEM inside the hand region, so a box bigger than the hand was never held
    big_item = (60, 60, 300, 260)
    assert it.hold_touch(HAND, [(1, big_item, 0.95, 0)], set()) == 1
    assert it.hold_share(HAND, [(1, big_item, 0.95, 0)], set()) is None


def test_a_segmented_region_beats_the_hand_crop():
    hand_crop, cup = (100, 100, 200, 200), (120, 120, 180, 190)
    assert it.hold_touch(HAND, [(1, hand_crop, 1.0, 1), (2, cup, 0.9, 0)], set()) == 2
    assert it.hold_touch(HAND, [(1, hand_crop, 1.0, 1)], set()) == 1  # nothing segmented: the crop is still used


def test_a_part_gives_way_to_the_whole_object():
    lid, cup = (105, 100, 185, 130), (100, 100, 190, 200)  # lid 2400 px², cup 9000 px²: within the 8x part-of limit
    assert it.hold_touch(HAND, [(1, lid, 0.95, 0), (2, cup, 0.9, 0)], set()) == 2


def test_overlap_small_is_one_when_nested_whatever_the_sizes():
    assert it.overlap_small((0, 0, 10, 10), (-50, -50, 100, 100)) == 1.0
    assert it.overlap_small((0, 0, 10, 10), (20, 20, 30, 30)) == 0.0


def _two_frame_data(box0, box1):
    emb = np.zeros((2, 512), np.float16)
    emb[:, 0] = 1  # identical look: only geometry decides
    return {"boxes": np.array([[0, *box0], [1, *box1]], np.float32), "src": np.zeros(2, np.int8), "emb": emb,
            "kps": np.zeros((2, 17, 3), np.float32), "fps": np.float32(30), "size": np.array([640, 480])}


class _ItemScorer:
    cats = ["item_generic_cup"]

    def __call__(self, emb):
        return np.ones(len(emb), np.float32), np.ones((len(emb), 1), np.float32)


def test_tracks_do_not_jump_to_a_region_twice_the_size():
    still = np.tile(np.array([[1, 0, 0], [0, 1, 0]], np.float32), (2, 1, 1))
    same = it.track(_two_frame_data((100, 100, 160, 160), (104, 102, 166, 162)), {}, _ItemScorer(), still)[0]
    jump = it.track(_two_frame_data((100, 100, 160, 160), (90, 100, 200, 200)), {}, _ItemScorer(), still)[0]  # overlaps, 3.4x area
    assert len(same) == 1 and len(jump) == 2


def _carried_into_bin(votes):
    """A hand carries one object down into a bin box, where it vanishes (frames 0-19), bin visible to frame 39."""
    n = 40
    kps = np.zeros((n, 17, 3), np.float32)
    boxes, frames = [], list(range(20))
    for i in frames:
        y = 100 + 6 * i
        kps[i, 7] = (100, y, 1.0)        # left elbow
        kps[i, 9] = (100, y + 60, 1.0)   # left wrist: the hand region is just below it
        boxes.append([80, y + 62, 120, y + 102])
    app = np.zeros(512, np.float32)
    app[0] = 1
    track = {"id": 0, "frames": frames, "boxes": boxes, "src": [0] * 20, "appearance": app,
             "cat": np.array(votes, np.float32), "category": "item_generic_cup" if sum(votes) else None, "cats": ["item_generic_cup"]}
    per_frame = [[(0, b, 0.95)] for b in boxes] + [[] for _ in range(n - 20)]
    data = {"kps": kps, "size": np.array([640, 480]), "fps": np.float32(30)}
    bins = {"bin_t": [(40, 180, 200, 460)] * n}
    still = np.tile(np.array([[1, 0, 0], [0, 1, 0]], np.float32), (n, 1, 1))
    return it.decide([track], data, bins, 30.0, still, per_frame)[0]


def test_a_drop_needs_an_item_seen_as_an_item_outside_the_bin():
    # a bin lid/hinge a hand passes over never looks like an item outside the bin (no category votes): no drop
    assert len(_carried_into_bin([2.0])) == 1
    assert _carried_into_bin([0.0]) == []


# ---------------------------------------------------------------- 17 Oct: veto at the vanish spot, LLM naming, back view

from recyclone_worker import namer  # noqa: E402


def test_llm_answer_becomes_the_item_and_unknown_ids_are_refused(tmp_path):
    llm = namer.DeepSeekNamer(tmp_path, use_key_file=False, catalog=[("item_napkin", "Paper napkin"), ("item_generic_cup", "Clear cup")])
    assert llm.available is False and llm.name([np.zeros((8, 8, 3), np.uint8)]) is None  # no key, no cache: CLIP stays
    good = llm._clean({"catalog_item_id": "item_napkin", "what": "crumpled napkin", "material": "paper", "confidence": 1.7})
    assert good["catalog_item_id"] == "item_napkin" and good["confidence"] == 1.0
    assert llm._clean({"catalog_item_id": "item_face_mask", "what": "mask"})["catalog_item_id"] is None  # never invents an id
    item = namer.item_from_answer(good, {"candidates": [{"catalog_item_id": "item_generic_cup", "score": 0.6}]})
    assert item["catalog_item_id"] == "item_napkin" and item["label"] == "crumpled napkin"
    assert [c["catalog_item_id"] for c in item["candidates"]] == ["item_napkin", "item_generic_cup"]
    none = namer.item_from_answer(llm._clean({"catalog_item_id": None, "what": "face mask", "confidence": 0.9}), {"candidates": []})
    assert none["catalog_item_id"] is None and none["confidence"] is None and none["label"] == "face mask"


def test_cached_llm_answers_replay_without_a_key(tmp_path):
    crops = [np.full((20, 20, 3), 120, np.uint8)]
    llm = namer.DeepSeekNamer(tmp_path, use_key_file=False, catalog=[("item_napkin", "Paper napkin")])
    images = [namer._jpeg(c) for c in crops]
    import hashlib
    import json as _json
    prompt = namer.PROMPT.format(n=1, catalog="item_napkin: Paper napkin")
    key = hashlib.sha256(_json.dumps([namer.MODEL, prompt] + ([] if namer.THINKING else ["no-think"])).encode() + b"".join(images)).hexdigest()[:24]
    (tmp_path / f"{key}.json").write_text(_json.dumps({"catalog_item_id": "item_napkin", "what": "napkin", "confidence": 0.8}))
    assert llm.name(crops)["catalog_item_id"] == "item_napkin" and llm.usage["cached"] == 1


def test_llm_item_is_used_by_playback(tmp_path):
    a = fake_analysis()
    a.events[0]["llm"] = {"catalog_item_id": "item_generic_box", "what": "kraft box", "material": "paper", "brand_visible": None, "confidence": 0.7}
    sent, _ = play(a, tmp_path)
    assert sent[0]["item"]["catalog_item_id"] == "item_generic_box" and sent[0]["item"]["label"] == "kraft box"
    validate_event(sent[0])


def test_back_view_drop_off_by_default_and_needs_an_arm_at_the_bin():
    assert it.BACK_VIEW_DROPS is False
    n = 40
    kps = np.zeros((n, 17, 3), np.float32)
    for i in range(n):  # a person's back: shoulders, hips, knees seen; the item last seen at frame 10 on the body
        for j, (x, y) in {5: (100, 100), 6: (200, 100), 11: (110, 250), 12: (190, 250), 13: (110, 350), 14: (190, 350)}.items():
            kps[i, j] = (x, y, 1.0)
    app = np.zeros(512, np.float32)
    app[0] = 1
    t = {"id": 0, "frames": list(range(11)), "boxes": [[140, 150, 170, 190]] * 11, "appearance": app, "cat": np.array([2.0])}
    bins = {"bin_t": [(260, 120, 360, 220)] * n}
    data = {"kps": kps.copy()}
    assert it.hidden_drops([t], data, bins, 30.0, {0: 0}, set(), {0: 2.0}) == []  # arm never reaches the bin
    for i in range(12, 20):
        data["kps"][i, 10] = (300, 170, 1.0)  # right wrist at the opening right after the item disappears
    d = it.hidden_drops([t], data, bins, 30.0, {0: 0}, set(), {0: 2.0})
    assert len(d) == 1 and d[0]["bin"] == "bin_t" and d[0]["how"] == "hidden by the body"
    assert it.hidden_drops([t], data, bins, 30.0, {0: 0}, set(), {0: 0.0}) == []  # never seen as an item: no drop
