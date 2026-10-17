"""Multi-camera station: facing, one drop across cameras, the active camera (no models: skeletons built by hand)."""

from types import SimpleNamespace

import numpy as np
import pytest

from recyclone_worker import multicam as mc

FPS = 10.0


def skeleton(view: str) -> np.ndarray:
    """COCO keypoints of a standing person: facing the camera ("front"), back to it ("back"), or absent ("none")."""
    k = np.zeros((17, 3), np.float32)
    if view == "none":
        return k
    left, right = (200, 100) if view == "front" else (100, 200)  # the person's left shoulder: image right when facing
    k[5], k[6] = (left, 100, 1.0), (right, 100, 1.0)
    k[11], k[12] = (left - 10 if view == "front" else left + 10, 300, 1.0), (right + 10 if view == "front" else right - 10, 300, 1.0)
    return k


def cam(camera_id, views: list[str], events=(), offset_s=0.0):
    kps = np.stack([skeleton(v) for v in views])
    return mc.CameraRun(camera_id, SimpleNamespace(data={"kps": kps, "fps": np.float32(FPS)}, events=list(events)), offset_s)


def drop(frame, bin_id="bin_t", held=10):
    return {"frame": frame, "bin": bin_id, "item_id": 1, "held_frames": held}


def test_facing_follows_the_shoulder_order_and_ignores_one_bad_frame():
    views = ["front"] * 10 + ["back"] * 10
    views[3] = "back"  # one wrong skeleton inside a front stretch
    f = mc.facing_series(np.stack([skeleton(v) for v in views]), FPS)
    assert f[3] == "front" and f[1] == "front" and f[15] == "back"
    assert mc.facing_series(np.stack([skeleton("none")] * 3), FPS) == ["none"] * 3


def test_same_drop_seen_by_two_cameras_is_one_drop_from_the_camera_the_person_faces():
    a = cam("cam_back", ["back"] * 40, [drop(20, held=30)])
    b = cam("cam_front", ["front"] * 40, [drop(22, held=5)])
    fused = mc.fuse([a, b])
    assert len(fused) == 1
    assert fused[0]["camera_id"] == "cam_front" and fused[0]["seen_by"] == ["cam_back", "cam_front"] and fused[0]["view"] == "front"


def test_drop_only_the_back_view_camera_saw_is_still_reported():
    a = cam("cam_back", ["back"] * 40, [drop(20)])
    b = cam("cam_front", ["front"] * 40)
    assert [d["camera_id"] for d in mc.fuse([a, b])] == ["cam_back"]


def test_different_bins_or_far_apart_times_stay_separate_and_clocks_are_aligned():
    a = cam("a", ["front"] * 80, [drop(10, "bin_x"), drop(60, "bin_x")])
    b = cam("b", ["front"] * 80, [drop(10, "bin_y")])
    assert len(mc.fuse([a, b])) == 3
    # camera b started 2 s later: its frame 0 is station time 2.0, so its frame 5 (2.5 s) is a's frame 25
    a2 = cam("a", ["back"] * 80, [drop(25)])
    b2 = cam("b", ["front"] * 80, [drop(5)], offset_s=2.0)
    fused = mc.fuse([a2, b2])
    assert len(fused) == 1 and fused[0]["camera_id"] == "b" and fused[0]["t"] == 2.5


def test_one_camera_never_merges_two_of_its_own_drops():
    a = cam("a", ["front"] * 40, [drop(10), drop(15)])  # two items into one bin 0.5 s apart, same camera
    b = cam("b", ["front"] * 40)
    assert len(mc.fuse([a, b])) == 2


def test_active_camera_switches_when_the_person_turns_but_not_on_a_flicker():
    a = cam("a", ["front"] * 20 + ["back"] * 20)
    b = cam("b", ["back"] * 20 + ["front"] * 20)
    timeline = dict(mc.active_timeline([a, b], 1 / FPS))
    assert timeline[0.5] == "a" and timeline[3.5] == "b"
    blip = ["front"] * 40
    blip[20:22] = ["back", "back"]  # a 0.2 s glitch on a; b is front only during the glitch
    a2, b2 = cam("a", blip), cam("b", ["back"] * 20 + ["front"] * 2 + ["back"] * 18)
    assert set(dict(mc.active_timeline([a2, b2], 1 / FPS)).values()) == {"a"}


def test_station_needs_two_distinct_cameras(tmp_path):
    p = tmp_path / "s.json"
    p.write_text('{"station_id": "s", "cameras": [{"camera_id": "a", "video": "x"}]}')
    with pytest.raises(ValueError):
        mc.load_station(p)


def test_cli_run_station_dry_run_reports_one_event_from_the_facing_camera(tmp_path, capsys):
    """Two cameras saw the same drop; the camera the person faced reports it, once."""
    import json

    import cv2

    from recyclone_worker import cli
    from test_items_run import N, fake_analysis, make_clip

    for name in ("a", "b"):
        make_clip(tmp_path / f"{name}.mp4")
    station = {"station_id": "st1", "cameras": [
        {"camera_id": "cam_back", "video": str(tmp_path / "a.mp4"), "bins": [{"bin_id": "bin_patio_trash", "keyframes": [[0, [100, 100, 300, 300]]], "visible": [0, N - 1]}]},
        {"camera_id": "cam_front", "video": str(tmp_path / "b.mp4"), "bins": [{"bin_id": "bin_patio_trash", "keyframes": [[0, [100, 100, 300, 300]]], "visible": [0, N - 1]}]}]}
    (tmp_path / "st.json").write_text(json.dumps(station))

    def analyze(video, cache, bins_for):
        a = fake_analysis(drop_frame=20)
        a.data["kps"] = np.stack([skeleton("back" if video.stem == "a" else "front")] * N)
        return a

    code = cli.main(["run-station", "--station", str(tmp_path / "st.json"), "--clip-id", "c1", "--dry-run", "--no-stream",
                     "--evidence-dir", str(tmp_path / "ev"), "--render", str(tmp_path / "grid.mp4")], analyze_items=analyze)
    assert code == 0
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
    assert len(events) == 1 and events[0]["source"]["camera_id"] == "cam_front"
    cap = cv2.VideoCapture(str(tmp_path / "grid.mp4"))
    ok, frame = cap.read()
    assert ok and frame.shape[1] > frame.shape[0]  # two views side by side
