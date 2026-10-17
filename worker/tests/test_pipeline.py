from datetime import UTC, datetime

import pytest
from fakes import RED, FakeEmbedder, ScriptedTracker, frames, solid

from recyclone_worker import entry
from recyclone_worker.client import MemorySink
from recyclone_worker.events import validate_event
from recyclone_worker.identify import Gallery
from recyclone_worker.pipeline import Pipeline
from recyclone_worker.site import load_site
from recyclone_worker.tracking import Track

STARTED = datetime(2026, 10, 17, 15, 0, tzinfo=UTC)
SITE = load_site("cam_patio_1")
TRASH_CENTER = (269, 503)  # center of trash region (128, 446, 282, 115) in a 1280x720 frame


@pytest.fixture(autouse=True)
def simple_entry(monkeypatch):
    """Stand-in for Eymen's throw_score: inside the region at the end -> 0.9."""
    def score(history, roi):
        x, y, w, h = roi
        lx, ly = history[-1]
        return 0.9 if x <= lx <= x + w and y <= ly <= y + h else 0.0
    monkeypatch.setattr(entry, "throw_score", score)


def box_at(cx, cy, half=20):
    return (cx - half, cy - half, cx + half, cy + half)


def walk_into(end, steps=8, start=(100, 200)):
    return [(start[0] + (end[0] - start[0]) * k / (steps - 1), start[1] + (end[1] - start[1]) * k / (steps - 1)) for k in range(steps)]


def run(script, n_frames=40, gallery=None, tmp_path=None, sink=None):
    g = gallery or Gallery()
    sink = sink or MemorySink()
    p = Pipeline(SITE, ScriptedTracker(script), FakeEmbedder(), g, sink,
                 clip_id="clip_t", started_at=STARTED, evidence_dir=tmp_path)
    return p.run(frames(n_frames)), sink


def script_for(points, track_id=3, start_frame=0, skip=()):
    return {start_frame + k: [Track(track_id, box_at(*p), "bottle")] for k, p in enumerate(points) if k not in skip}


def test_one_drop_one_event(tmp_path):
    events, sink = run(script_for(walk_into(TRASH_CENTER)), tmp_path=tmp_path)
    assert len(events) == 1 and sink.events == events
    e = events[0]
    assert e["bin_id"] == "bin_patio_trash" and e["destination_confidence"] == 0.9
    assert e["source"]["track_id"] == 3 and e["clip_offset_s"] == 0.7
    validate_event(e)
    assert (tmp_path / "clip_t" / "3_entry.jpg").exists()
    assert e["evidence"][0]["uri"] == "evidence/clip_t/3_entry.jpg"


def test_replay_same_ids(tmp_path):
    first, _ = run(script_for(walk_into(TRASH_CENTER)), tmp_path=tmp_path)
    second, _ = run(script_for(walk_into(TRASH_CENTER)), tmp_path=tmp_path)
    assert [e["event_id"] for e in first] == [e["event_id"] for e in second]


def test_short_occlusion_no_double_event(tmp_path):
    pts = walk_into(TRASH_CENTER, steps=20)
    events, _ = run(script_for(pts, skip=range(6, 11)), tmp_path=tmp_path)  # missing 5 frames < 10
    assert len(events) == 1


def test_carried_away_no_event(tmp_path):
    there_and_back = walk_into(TRASH_CENTER) + walk_into((100, 200), start=TRASH_CENTER)
    events, _ = run(script_for(there_and_back), tmp_path=tmp_path)
    assert events == []


def test_box_outside_frame_clamped(tmp_path):
    script = {k: [Track(5, (-30, 480, 300, 530), "cup")] for k in range(5)}
    events, _ = run(script, tmp_path=tmp_path)
    assert len(events) == 1
    assert (tmp_path / "clip_t" / "5_entry.jpg").stat().st_size > 0


def test_unknown_item_still_sent(tmp_path):
    events, _ = run(script_for(walk_into(TRASH_CENTER)), tmp_path=tmp_path)
    assert events[0]["item"]["catalog_item_id"] is None


def test_identifies_with_gallery(tmp_path):
    g = Gallery()
    g.add("item_beanco_cup", FakeEmbedder().embed(solid(RED)))
    events, _ = run(script_for(walk_into(TRASH_CENTER)), gallery=g, tmp_path=tmp_path)
    assert events[0]["item"]["catalog_item_id"] == "item_beanco_cup"


def test_track_open_at_clip_end_is_finalized(tmp_path):
    events, _ = run(script_for(walk_into(TRASH_CENTER)), n_frames=8, tmp_path=tmp_path)
    assert len(events) == 1


# --- added after review ----------------------------------------------------------------------

def test_long_occlusion_then_carried_away_no_event(tmp_path):
    """A hand hides the cup over the bin for 20 frames (ByteTrack keeps the ID for 30), then it is carried off."""
    over_bin = walk_into(TRASH_CENTER)
    away = walk_into((100, 200), start=TRASH_CENTER)
    script = script_for(over_bin)
    script.update(script_for(away, start_frame=len(over_bin) + 20))
    events, _ = run(script, n_frames=80, tmp_path=tmp_path)
    assert events == []


def test_failing_sink_does_not_stop_the_run(tmp_path, capsys):
    class Flaky(MemorySink):
        def send(self, event):
            if not self.events and not getattr(self, "failed", False):
                self.failed = True
                raise RuntimeError("boom")
            return super().send(event)
    script = script_for(walk_into(TRASH_CENTER), track_id=1)
    script.update(script_for(walk_into(TRASH_CENTER), track_id=2, start_frame=60))
    sink = Flaky()
    events, _ = run(script, n_frames=120, tmp_path=tmp_path, sink=sink)
    assert [e["source"]["track_id"] for e in sink.events] == [2]
    assert "boom" in capsys.readouterr().err


def test_evidence_is_the_last_frame_seen(tmp_path):
    pts = walk_into(TRASH_CENTER)
    script = {k: [Track(3, box_at(*p, half=60 - 5 * k), "cup")] for k, p in enumerate(pts)}  # shrinks as it falls
    events, _ = run(script, tmp_path=tmp_path)
    assert events[0]["evidence"][0]["frame"] == len(pts) - 1


def test_runner_up_brand_is_not_sent(tmp_path):
    from fakes import BLUE
    g = Gallery()
    g.add("item_generic_cup", FakeEmbedder().embed(solid(RED)))
    g.add("item_beanco_cup", FakeEmbedder().embed(solid((40, 0, 255))))  # close to red: a runner-up
    sink = MemorySink()
    p = Pipeline(SITE, ScriptedTracker(script_for(walk_into(TRASH_CENTER))), FakeEmbedder(), g, sink,
                 clip_id="clip_t", started_at=STARTED, evidence_dir=tmp_path,
                 catalog_business={"item_generic_cup": None, "item_beanco_cup": "biz_beanco"})
    e = p.run(frames(40))[0]
    assert e["item"]["catalog_item_id"] == "item_generic_cup"
    assert e["business"]["business_id"] is None
    validate_event(e)


def test_unregistered_item_gets_generic_category(tmp_path):
    from recyclone_worker.categories import CategoryClassifier
    cats = CategoryClassifier(FakeEmbedder(), {"item_generic_wrapper": ["a red wrapper"], "item_generic_can": ["a blue can"]})
    p = Pipeline(SITE, ScriptedTracker(script_for(walk_into(TRASH_CENTER))), FakeEmbedder(), Gallery(), MemorySink(),
                 clip_id="clip_t", started_at=STARTED, evidence_dir=tmp_path, categories=cats, reference_threshold=0.8)
    e = p.run(frames(40))[0]  # frames are solid red
    assert e["item"]["catalog_item_id"] == "item_generic_wrapper" and e["item"]["label"] == "a red wrapper"
    validate_event(e)


def test_identification_crop_is_padded(tmp_path):
    from recyclone_worker.pipeline import pad_box
    assert pad_box((100, 100, 200, 160), (1280, 720), 0.2) == (80, 88, 220, 172)
    assert pad_box((0, 0, 50, 50), (1280, 720), 0.2) == (0, 0, 60, 60)  # clamped at the frame edge
