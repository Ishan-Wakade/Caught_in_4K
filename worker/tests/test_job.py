"""The upload page's job (job.py): ffmpeg and the guide subprocess are faked, so this runs without either."""

import io
import json
import subprocess

import cv2
import numpy as np
import pytest

from recyclone_worker import job
from recyclone_worker.cli import NO_BINS


def fake_run(width=1280, height=720, seconds=12.0, fail=False):
    calls = []

    def run(cmd, **kw):
        calls.append(cmd)
        if fail:
            raise subprocess.CalledProcessError(1, cmd)
        if cmd[0] == "ffprobe":
            out = {"streams": [{"width": width, "height": height}], "format": {"duration": str(seconds)}}
            return subprocess.CompletedProcess(cmd, 0, json.dumps(out), "")
        return subprocess.CompletedProcess(cmd, 0, b"", b"")
    run.calls = calls
    return run


class FakeProc:
    def __init__(self, cmd, code, lines, report):
        self.code, self.stderr = code, io.StringIO("".join(f"{l}\n" for l in lines))
        render = cmd[cmd.index("--render") + 1]
        if report is not None:
            open(render, "wb").write(b"mp4")
            open(render[:-4] + ".json", "w").write(json.dumps(report))

    def wait(self):
        return self.code


def fake_popen(code=0, lines=("stage: finding bins", "bins: RECYCLING (recycle)", "stage: identifying", "stage: rendering"),
               report=None):
    seen = []

    def popen(cmd, **kw):
        seen.append(cmd)
        return FakeProc(cmd, code, lines, report if code == 0 else None)
    popen.seen = seen
    return popen


REPORT = {"video": "/srv/jobs/x/result.mp4", "source": "/srv/jobs/x/work/clip.mp4", "items": [], "outcomes": []}


def test_area_pixels_from_the_box_drawn_on_the_page():
    assert job.area_pixels(None, 1280, 720) == "auto"
    assert job.area_pixels((0.5, 0.25, 1.0, 1.0), 1280, 720) == "640,180,1280,720"
    assert job.area_pixels((-0.2, 0.1, 1.4, 0.9), 1000, 1000) == "0,100,1000,900"  # clamped to the frame
    with pytest.raises(ValueError):
        job.area_pixels((0.5, 0.5, 0.505, 0.9), 1280, 720)


def test_a_finished_job_reports_stages_and_hides_server_paths(tmp_path):
    stages, popen = [], fake_popen(report=REPORT)
    result = job.run_job(tmp_path / "in.mov", tmp_path / "out", on_stage=stages.append, run=fake_run(), popen=popen)
    assert result["status"] == "done"
    assert result["report"]["video"] == "result.mp4" and result["report"]["source"] == "upload"
    assert stages == ["preparing video", "finding bins", "identifying", "rendering"]
    cmd = popen.seen[0]
    assert cmd[cmd.index("--area") + 1] == "auto" and "--headless" in cmd and "--prepared" in cmd and "--no-verdict" in cmd
    assert (tmp_path / "out/result.mp4").exists() and not (tmp_path / "out/work").exists()


def test_the_drawn_box_is_passed_in_pixels_of_the_normalised_clip(tmp_path):
    popen = fake_popen(report=REPORT)
    job.run_job(tmp_path / "in.webm", tmp_path / "out", area_norm=(0.1, 0.2, 0.9, 1.0), on_stage=lambda s: None,
                run=fake_run(width=720, height=1280), popen=popen)  # portrait phone clip
    cmd = popen.seen[0]
    assert cmd[cmd.index("--area") + 1] == "72,256,648,1280"


def test_too_long_is_refused_before_the_guide_runs(tmp_path):
    popen = fake_popen(report=REPORT)
    result = job.run_job(tmp_path / "in.mp4", tmp_path / "out", on_stage=lambda s: None,
                         run=fake_run(seconds=job.MAX_SECONDS + 0.9), popen=popen)
    assert result == {"status": "error", "code": "too_long"} and popen.seen == []


def test_a_file_ffmpeg_cannot_read_is_unreadable(tmp_path):
    result = job.run_job(tmp_path / "in.txt", tmp_path / "out", on_stage=lambda s: None, run=fake_run(fail=True),
                         popen=fake_popen())
    assert result == {"status": "error", "code": "unreadable"}


def test_no_bins_and_crashes_become_error_codes(tmp_path):
    common = dict(on_stage=lambda s: None, run=fake_run())
    assert job.run_job(tmp_path / "a", tmp_path / "o1", popen=fake_popen(code=NO_BINS), **common)["code"] == "no_bins"
    assert job.run_job(tmp_path / "a", tmp_path / "o2", popen=fake_popen(code=1), **common)["code"] == "failed"


def test_headless_guide_exits_no_bins_instead_of_opening_a_window(tmp_path, monkeypatch):
    from recyclone_worker import bins, cli

    clip = tmp_path / "c.mp4"
    out = cv2.VideoWriter(str(clip), cv2.VideoWriter_fourcc(*"mp4v"), 10, (640, 360))
    for _ in range(5):
        out.write(np.zeros((360, 640, 3), np.uint8))
    out.release()
    monkeypatch.setattr(bins, "detect_openings", lambda frame, cache_dir, **kw: [])
    monkeypatch.setattr(cv2, "selectROI", lambda *a, **k: pytest.fail("headless must never open a window"))
    code = cli.main(["guide", "--source", str(clip), "--area", "auto", "--voice", "silent", "--no-stream", "--headless",
                     "--log", str(tmp_path / "g.jsonl")], make_guide_parts=lambda args, area: pytest.fail("not reached"))
    assert code == NO_BINS
    assert cli.main(["guide", "--source", str(clip), "--area", "pick", "--voice", "silent", "--no-stream", "--headless",
                     "--log", str(tmp_path / "g.jsonl")]) == 2
