from datetime import UTC, datetime

from fakes import BLUE, RED, FakeEmbedder, solid

from recyclone_worker.events import build_event, validate_event
from recyclone_worker.identify import Gallery, identify

emb = FakeEmbedder()


def gallery() -> Gallery:
    g = Gallery()
    g.add("item_red", emb.embed(solid(RED)))
    g.add("item_blue", emb.embed(solid(BLUE)))
    return g


def test_identifies_nearest():
    item = identify([solid(RED), solid(RED)], emb, gallery())
    assert item["catalog_item_id"] == "item_red"
    scores = [c["score"] for c in item["candidates"]]
    assert scores == sorted(scores, reverse=True)
    assert item["confidence"] == scores[0]
    assert all(0 <= s <= 1 for s in scores)


def test_empty_gallery_gives_unknown():
    assert identify([solid(RED)], emb, Gallery()) == {
        "catalog_item_id": None, "label": None, "confidence": None, "candidates": []}


def test_no_crops_gives_unknown():
    assert identify([], emb, gallery())["catalog_item_id"] is None


def test_gallery_roundtrip(tmp_path):
    g = gallery()
    g.save(tmp_path / "g.npz")
    back = Gallery.load(tmp_path / "g.npz")
    assert back.ids == g.ids
    assert (back.vecs == g.vecs).all()


def test_identify_output_validates():
    item = identify([solid(BLUE)], emb, gallery())
    validate_event(build_event(
        camera_id="cam_patio_1", clip_id="c", track_id=1, bin_id="bin_patio_trash",
        started_at=datetime(2026, 10, 17, tzinfo=UTC), offset_s=1.0, destination_confidence=0.9,
        item=item, evidence=[]))


def test_enroll_from_segments(tmp_path):
    import cv2
    import numpy as np
    from types import SimpleNamespace

    from recyclone_worker.enroll import enroll_from_segments

    video = tmp_path / "enroll.mp4"
    out = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 10, (64, 64))
    for f in range(40):  # 0-2 s red square, 2-4 s blue square
        frame = np.zeros((64, 64, 3), np.uint8)
        frame[16:48, 16:48] = RED if f < 20 else BLUE
        out.write(frame)
    out.release()

    class BoxTracker:
        def update(self, frame):
            return [SimpleNamespace(box=(16, 16, 48, 48))]

    g = Gallery()
    segs = [{"catalog_item_id": "item_red", "start_s": 0, "end_s": 2}, {"catalog_item_id": "item_blue", "start_s": 2, "end_s": 4}]
    n = enroll_from_segments(video, segs, BoxTracker(), emb, g, every_n=5)
    assert n == 8
    assert g.ids.count("item_red") == 4 and g.ids.count("item_blue") == 4
    assert identify([solid(BLUE)], emb, g)["catalog_item_id"] == "item_blue"


# --- business evidence from reference matching (enables the review-queue scenario) -------------

from recyclone_worker.identify import business_from_candidates

CATALOG_BIZ = {"item_shakeshack_cup": "biz_shakeshack", "item_generic_cup": None, "item_napkin": None}


def _item(*cands):
    c = [{"catalog_item_id": i, "score": s} for i, s in cands]
    return {"catalog_item_id": c[0]["catalog_item_id"] if c else None, "label": None,
            "confidence": c[0]["score"] if c else None, "candidates": c}


def test_branded_top_candidate_gives_its_business():
    assert business_from_candidates(_item(("item_shakeshack_cup", 0.8), ("item_generic_cup", 0.5)), CATALOG_BIZ) == \
        {"business_id": "biz_shakeshack", "confidence": 0.8, "basis": ["reference_match"]}


def test_generic_top_with_branded_runner_up_is_weak_evidence():
    assert business_from_candidates(_item(("item_generic_cup", 0.7), ("item_shakeshack_cup", 0.45)), CATALOG_BIZ) == \
        {"business_id": "biz_shakeshack", "confidence": 0.45, "basis": ["reference_match"]}


def test_no_branded_candidate_means_no_business():
    none = {"business_id": None, "confidence": None, "basis": []}
    assert business_from_candidates(_item(("item_generic_cup", 0.7), ("item_napkin", 0.2)), CATALOG_BIZ) == none
    assert business_from_candidates(_item(), CATALOG_BIZ) == none
    assert business_from_candidates(_item(("item_not_in_catalog", 0.9)), CATALOG_BIZ) == none
