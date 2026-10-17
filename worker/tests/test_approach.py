"""Getting close to the bin area: distance from the person's own height (or a floor calibration) and speed."""

import numpy as np

from recyclone_worker import approach as ap

AREA = ap.BinArea(800, 300, 1000, 700)  # one box around all the bins, pixels


def person(feet_x: float, feet_y: float = 700, height_px: float = 340) -> np.ndarray:
    """Standing skeleton whose ankles are at (feet_x, feet_y) and nose height_px above them (1.7 m person)."""
    k = np.zeros((17, 3), np.float32)
    top = feet_y - height_px / 0.87
    k[0] = (feet_x, feet_y - height_px, 0.9)  # nose, height_px above the ankles
    k[5], k[6] = (feet_x + 20, top + 60, 0.9), (feet_x - 20, top + 60, 0.9)
    k[11], k[12] = (feet_x + 15, top + 180, 0.9), (feet_x - 15, top + 180, 0.9)
    k[15], k[16] = (feet_x + 10, feet_y, 0.9), (feet_x - 10, feet_y, 0.9)
    return k


def test_person_height_is_the_ruler():
    m = ap.person_meters_per_px(person(100))
    assert abs(m * 340 / 0.87 - 1.7) < 0.05  # whole body ~1.7 m


def test_walking_toward_area_triggers_once_before_arrival():
    a = ap.Approach(AREA)
    px_per_m = 340 / 0.87 / 1.7  # ~230 px per meter at this depth
    fired = []
    for k in range(100):  # 30 fps, 1 m/s toward the box, starting 4 m away
        t = k / 30
        x = AREA.x0 - (4 - t) * px_per_m
        if a.update(1, t, person(x)):
            fired.append(t)
    arrival = 4.0
    assert len(fired) == 1 and arrival - fired[0] >= 1.5


def test_walking_away_never_triggers():
    a = ap.Approach(AREA)
    assert not any(a.update(1, k / 30, person(AREA.x0 - 300 - 8 * k)) for k in range(60))


def test_standing_inside_triggers_once():
    a = ap.Approach(AREA)
    assert sum(a.update(1, k / 30, person(900, 650)) for k in range(90)) == 1


def test_announces_again_only_after_leaving_and_cooldown():
    a = ap.Approach(AREA)
    assert sum(a.update(1, k / 30, person(900, 650)) for k in range(30)) == 1
    for k in range(30, 30 + 30 * 9):  # away for 9 s
        a.update(1, k / 30, person(100))
    assert sum(a.update(1, (300 + k) / 30, person(900, 650)) for k in range(30)) == 1


def test_no_ankles_returns_none_no_trigger():
    k = person(900, 650)
    k[15, 2] = k[16, 2] = 0.0
    assert ap.distance_m(k, AREA) is None
    assert not ap.Approach(AREA).update(1, 0.0, k)


def test_homography_overrides_ruler():
    h = np.eye(3)  # pixels are "meters" under this calibration
    d = ap.distance_m(person(AREA.x0 - 100), AREA, homography=h)
    assert abs(d - 100) < 1e-6


def test_live_source_reads_any_opencv_source_with_wall_clock_times(tmp_path):
    import cv2
    import pytest

    from recyclone_worker.sources import LiveCameraSource

    clip = tmp_path / "c.mp4"
    out = cv2.VideoWriter(str(clip), cv2.VideoWriter_fourcc(*"mp4v"), 10, (64, 48))
    for _ in range(5):
        out.write(np.zeros((48, 64, 3), np.uint8))
    out.release()
    frames = list(LiveCameraSource(str(clip)))  # a URL, a device index, or (for this test) a file
    assert [f[0] for f in frames] == [0, 1, 2, 3, 4] and all(b[1] >= a[1] for a, b in zip(frames, frames[1:]))
    with pytest.raises(FileNotFoundError):
        LiveCameraSource("rtsp://127.0.0.1:1/nothing", open_timeout_s=1)
