"""Manual overlays interpolate locally and never alter the announcement trigger area."""

import json

import numpy as np
import pytest

from recyclone_worker.bin_layout import BinLayout
from recyclone_worker import cli
from recyclone_worker.prepared_render import AREA_COLOR, OPENING_COLOR, SKELETON_GREEN


def layout_file(tmp_path):
    p = tmp_path / "bins.json"
    p.write_text(json.dumps({"source_size": [640, 480], "keyframes": [
        {"t": 0, "boxes": {"recycle": [50, 100, 100, 130], "trash": [150, 100, 200, 130], "compost": [250, 100, 300, 130]}},
        {"t": 2, "boxes": {"recycle": [70, 100, 120, 130], "trash": [170, 100, 220, 130], "compost": [270, 100, 320, 130]}},
    ]}))
    return p


def test_manual_positions_interpolate_scale_and_hold_endpoints(tmp_path):
    layout = BinLayout(layout_file(tmp_path))
    assert layout.at(1, 320, 240)[0]["box"] == (30, 50, 55, 65)
    assert layout.at(-1, 640, 480)[0]["box"] == (50, 100, 100, 130)
    assert layout.at(99, 640, 480)[0]["box"] == (70, 100, 120, 130)
    assert [o["label"] for o in layout.at(0, 640, 480)] == ["RECYCLING", "TRASH", "COMPOST"]
    assert layout.report()["source"] == "manual_keyframes"


@pytest.mark.parametrize("change", ["missing_type", "reversed_box", "duplicate_time", "bad_size", "nan_time"])
def test_invalid_manual_annotations_are_rejected(tmp_path, change):
    p = layout_file(tmp_path)
    data = json.loads(p.read_text())
    if change == "missing_type":
        del data["keyframes"][0]["boxes"]["trash"]
    elif change == "reversed_box":
        data["keyframes"][0]["boxes"]["trash"] = [200, 100, 150, 130]
    elif change == "duplicate_time":
        data["keyframes"][1]["t"] = 0
    elif change == "bad_size":
        data["source_size"] = [0, 480]
    else:
        data["keyframes"][0]["t"] = float("nan")
    p.write_text(json.dumps(data))
    with pytest.raises(ValueError):
        BinLayout(p)


def test_offscreen_bins_are_hidden_or_clipped(tmp_path):
    p = layout_file(tmp_path)
    data = json.loads(p.read_text())
    for frame in data["keyframes"]:
        frame["boxes"]["recycle"] = [-100, 100, -10, 130]
        frame["boxes"]["compost"] = [620, 100, 700, 130]
    p.write_text(json.dumps(data))
    bins = BinLayout(p).at(0, 640, 480)
    assert [b["bin"] for b in bins] == ["trash", "compost"]
    assert bins[-1]["box"] == (620, 100, 639, 130)


def test_three_small_colored_overlays_leave_trigger_area_unchanged(tmp_path):
    from recyclone_worker.approach import Approach, BinArea
    from recyclone_worker.prepared_render import PreparedGuide as Guide
    from recyclone_worker.voice import SilentVoice

    area = BinArea(300, 300, 630, 470)
    g = Guide(lambda frame: [], object(), Approach(area), SilentVoice(), area=area)
    original_area = g.area
    g.bin_layout = BinLayout(layout_file(tmp_path))
    out = g.annotate(np.zeros((480, 640, 3), np.uint8), 1)
    assert g.area is original_area and not g.outcomes
    for color in OPENING_COLOR.values():
        assert np.any(np.all(out == color, axis=2))
        assert color != SKELETON_GREEN and color[1] < 200
    assert AREA_COLOR != SKELETON_GREEN


def test_manual_layout_rejects_live_or_automatic_cloud_bin_detection(capsys):
    assert cli.main(["guide", "--source", "0", "--area", "auto", "--prepared", "--bin-layout", "missing.json"]) == 2
    assert "recorded video" in capsys.readouterr().err
