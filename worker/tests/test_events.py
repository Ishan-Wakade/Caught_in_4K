import json
from datetime import UTC, datetime

import pytest

from recyclone_worker.events import build_event, dumps_event, make_event_id, validate_event

STARTED = datetime(2026, 10, 17, 15, 0, tzinfo=UTC)


def _event(item, **over):
    kwargs = dict(
        camera_id="cam_patio_1", clip_id="clip_demo_v1", track_id=17, bin_id="bin_patio_trash",
        started_at=STARTED, offset_s=41.3, destination_confidence=0.9, item=item,
        evidence=[{"kind": "crop", "uri": "evidence/clip_demo_v1/17_entry.jpg", "frame": 1239}],
    )
    kwargs.update(over)
    return build_event(**kwargs)


def test_id_matches_contract_vectors(contracts_dir):
    for row in json.loads((contracts_dir / "fixtures/event-id-vectors.json").read_text()):
        assert make_event_id(row["camera_id"], row["clip_id"], row["track_id"], row["bin_id"]) == row["event_id"]


@pytest.mark.parametrize("bad", [17.0, True])
def test_float_track_id_rejected(bad):
    with pytest.raises(TypeError):
        make_event_id("c", "k", bad, "b")


def test_built_event_is_valid():
    item = {"catalog_item_id": "item_beanco_cup", "label": None, "confidence": 0.8,
            "candidates": [{"catalog_item_id": "item_beanco_cup", "score": 0.8}]}
    e = _event(item)
    assert e["occurred_at"] == "2026-10-17T15:00:41.300Z"
    assert e["source"]["mode"] == "recorded"
    assert e["event_id"] == make_event_id("cam_patio_1", "clip_demo_v1", 17, "bin_patio_trash")
    validate_event(e)


def test_unknown_item_event_is_valid(unknown_item):
    validate_event(_event(unknown_item))


def test_invalid_event_raises(unknown_item):
    with pytest.raises(ValueError, match="destination_confidence|1.5"):
        validate_event(_event(unknown_item, destination_confidence=1.5))


def test_nan_cannot_be_serialized(unknown_item):
    e = _event(unknown_item)
    e["destination_confidence"] = float("nan")
    with pytest.raises(ValueError):
        dumps_event(e)
