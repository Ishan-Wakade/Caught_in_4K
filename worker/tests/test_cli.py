import json
from datetime import UTC, datetime, timedelta

import cv2
import numpy as np
import pytest
from fakes import FakeEmbedder, ScriptedTracker

from recyclone_worker import cli, entry
from recyclone_worker.tracking import Track


@pytest.fixture(autouse=True)
def simple_entry(monkeypatch):
    monkeypatch.setattr(entry, "throw_score", lambda h, roi: 0.9 if roi[0] <= h[-1][0] <= roi[0] + roi[2] and roi[1] <= h[-1][1] <= roi[1] + roi[3] else 0.0)


def make_clip(path, n=20):
    out = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (1280, 720))
    for _ in range(n):
        out.write(np.full((720, 1280, 3), 90, np.uint8))
    out.release()


def tracker_into_trash():
    pts = [(100 + 169 * k / 7, 200 + 303 * k / 7) for k in range(8)]
    return ScriptedTracker({k: [Track(7, (x - 20, y - 20, x + 20, y + 20), "cup")] for k, (x, y) in enumerate(pts)})


def test_cli_dry_run_on_fixture_clip(tmp_path, capsys):
    clip = tmp_path / "c.mp4"
    make_clip(clip)
    code = cli.main(["run", "--clip", str(clip), "--clip-id", "t1", "--dry-run", "--no-stream",
                     "--evidence-dir", str(tmp_path / "ev")],
                    make_tracker=tracker_into_trash, make_embedder=FakeEmbedder)
    assert code == 0
    printed = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
    assert len(printed) == 1 and printed[0]["bin_id"] == "bin_patio_trash"


def test_fast_run_timestamps_are_not_in_the_future(tmp_path, capsys):
    """Core rejects occurred_at more than 5 s ahead; a faster-than-realtime run must back-date the clip start."""
    clip = tmp_path / "c.mp4"
    make_clip(clip, n=600)  # 60 s clip processed in well under 60 s
    script = {k: [Track(7, (229, 463, 309, 543), "cup")] for k in range(590, 600)}
    cli.main(["run", "--clip", str(clip), "--clip-id", "t2", "--dry-run", "--no-stream", "--evidence-dir", str(tmp_path / "ev")],
             make_tracker=lambda: ScriptedTracker(script), make_embedder=FakeEmbedder)
    event = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")][0]
    occurred = datetime.fromisoformat(event["occurred_at"].replace("Z", "+00:00"))
    assert occurred <= datetime.now(UTC) + timedelta(seconds=5)


class RecordingSink:
    def __init__(self, status="created"):
        from collections import Counter
        self.sent, self.status, self.stats = [], status, Counter()

    def send(self, e):
        self.sent.append(e)
        self.stats[self.status] += 1
        return self.status


def test_replay_labeled_shifts_old_timestamps_to_now(monkeypatch, contracts_dir):
    """The fixture is dated 17 Oct 15:00Z; core rejects stale-vs-now ordering only for the future, but
    replaying on demo day must look like it is happening now, with the original gaps kept."""
    sink = RecordingSink()
    monkeypatch.setattr(cli, "make_sink", lambda args: sink)
    path = contracts_dir / "fixtures/synthetic-events.jsonl"
    code = cli.main(["replay-labeled", "--file", str(path), "--no-wait"])
    assert code == 0 and len(sink.sent) == 11 and all(e["source"]["mode"] == "labeled" for e in sink.sent)
    original = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    t = lambda e: datetime.fromisoformat(e["occurred_at"].replace("Z", "+00:00"))
    now = datetime.now(UTC)
    assert all(t(e) <= now + timedelta(seconds=5) for e in sink.sent)
    assert t(sink.sent[-1]) > now - timedelta(seconds=30)
    assert [t(b) - t(a) for a, b in zip(sink.sent, sink.sent[1:])] == [t(b) - t(a) for a, b in zip(original, original[1:])]
    assert [e["event_id"] for e in sink.sent] == [e["event_id"] for e in original]


def test_all_duplicates_warns_about_reset(tmp_path, monkeypatch, capsys):
    clip = tmp_path / "c.mp4"
    make_clip(clip)
    sink = RecordingSink(status="duplicate")
    monkeypatch.setattr(cli, "make_sink", lambda args: sink)
    cli.main(["run", "--clip", str(clip), "--clip-id", "t3", "--no-stream", "--no-background", "--evidence-dir", str(tmp_path / "ev")],
             make_tracker=tracker_into_trash, make_embedder=FakeEmbedder)
    err = capsys.readouterr().err
    assert "duplicate 1" in err and "demo/reset" in err


def test_enroll_rejects_ids_not_in_catalog(tmp_path):
    clip = tmp_path / "c.mp4"
    make_clip(clip)
    segs = tmp_path / "s.json"
    segs.write_text(json.dumps([{"catalog_item_id": "item_typo", "start_s": 0, "end_s": 1}]))
    with pytest.raises(SystemExit, match="item_typo"):
        cli.main(["enroll", "--clip", str(clip), "--segments", str(segs), "--out", str(tmp_path / "g.npz")],
                 make_tracker=tracker_into_trash, make_embedder=FakeEmbedder)


def test_duration_when_container_reports_no_frame_count(tmp_path):
    from recyclone_worker.sources import RecordedClipSource
    clip = tmp_path / "c.mp4"
    make_clip(clip, n=20)
    src = RecordedClipSource(clip)
    src.frame_count = 0
    assert src.duration_s == pytest.approx(2.0)


def test_realtime_warns_when_falling_behind(capsys):
    import time as _t

    def slow_source():
        for i in range(3):
            yield i, i * 0.01, None
            _t.sleep(0.6)  # processing far slower than the clip
    list(cli._realtime(slow_source(), fps=100, warn_after_s=0.5))
    assert "behind" in capsys.readouterr().err
