import json

from recyclone_worker.calibrate import normalize_roi, write_regions


def test_normalize_roi():
    assert normalize_roi((128, 446, 282, 115), (1280, 720)) == (0.1, 0.6194, 0.2203, 0.1597)


def test_write_regions_updates_only_that_camera(tmp_path, contracts_dir):
    fixture = tmp_path / "site.json"
    fixture.write_text((contracts_dir / "fixtures/demo-site.json").read_text())
    write_regions(fixture, "cam_patio_1", {"bin_patio_trash": (0.05, 0.5, 0.2, 0.2)})
    cam = json.loads(fixture.read_text())["cameras"][0]
    trash = next(r for r in cam["bin_regions"] if r["bin_id"] == "bin_patio_trash")
    assert (trash["x"], trash["y"], trash["w"], trash["h"]) == (0.05, 0.5, 0.2, 0.2)
    recycling = next(r for r in cam["bin_regions"] if r["bin_id"] == "bin_patio_recycling")
    assert recycling["x"] == 0.39  # untouched


def test_cli_evaluate_prints_report(tmp_path, capsys):
    from recyclone_worker import cli
    row = lambda t, b, i: json.dumps({"clip_offset_s": t, "bin_id": b, "source": {"mode": "x"}, "item": {"catalog_item_id": i}})
    (tmp_path / "labels.jsonl").write_text(row(5, "bin_t", "a") + "\n" + row(9, "bin_r", "b") + "\n")
    (tmp_path / "pred.jsonl").write_text(row(5.2, "bin_t", "a") + "\n")
    assert cli.main(["evaluate", "--labels", str(tmp_path / "labels.jsonl"), "--predicted", str(tmp_path / "pred.jsonl")]) == 0
    out = capsys.readouterr().out
    assert "counted right:  1" in out and "missed:         1" in out


def test_run_writes_events_file(tmp_path):
    from fakes import FakeEmbedder
    from test_cli import make_clip, tracker_into_trash
    from recyclone_worker import cli
    clip = tmp_path / "c.mp4"
    make_clip(clip)
    out = tmp_path / "events.jsonl"
    cli.main(["run", "--clip", str(clip), "--clip-id", "t9", "--dry-run", "--no-stream", "--evidence-dir", str(tmp_path / "ev"),
              "--events-out", str(out)], make_tracker=tracker_into_trash, make_embedder=FakeEmbedder)
    assert len(out.read_text().splitlines()) == 1
