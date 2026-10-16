import numpy as np

from recyclone_worker.motion import MotionTracker
from recyclone_worker.site import BinRegion

REGIONS = [BinRegion("bin_patio_trash", 0.1, 0.62, 0.22, 0.16)]


def background():
    rng = np.random.default_rng(0)
    return (rng.integers(80, 100, (720, 1280, 3))).astype(np.uint8)


def run(frames):
    t = MotionTracker(REGIONS)
    return [t.update(f) for f in frames]


def test_static_scene_has_no_tracks():
    bg = background()
    out = run([bg.copy() for _ in range(40)])
    assert all(o == [] for o in out[10:])


def test_moving_item_keeps_one_id():
    bg = background()
    frames = [bg.copy() for _ in range(20)]  # learn the background
    for k in range(15):  # a 40x40 bright square falls toward the trash opening
        f = bg.copy()
        x, y = 250, 300 + 12 * k
        f[y:y + 40, x:x + 40] = 230
        frames.append(f)
    out = run(frames)
    ids = {t.track_id for o in out[22:] for t in o}
    assert len(ids) == 1
    moving = [o for o in out[22:] if o]
    assert len(moving) >= 10 and moving[-1][0].cls_name == "motion"


def test_person_sized_blob_ignored():
    bg = background()
    frames = [bg.copy() for _ in range(20)]
    for k in range(10):
        f = bg.copy()
        f[150:700, 200 + 10 * k:520 + 10 * k] = 220  # a body-sized moving region
        frames.append(f)
    out = run(frames)
    assert all(o == [] for o in out[22:])


def test_cli_run_with_motion_tracker_end_to_end(tmp_path, capsys):
    """Real motion tracker + real throw_score: a square falls into the trash opening and vanishes."""
    import json
    import cv2
    from fakes import FakeEmbedder
    from recyclone_worker import cli
    bg = background()
    clip = tmp_path / "fall.mp4"
    out = cv2.VideoWriter(str(clip), cv2.VideoWriter_fourcc(*"mp4v"), 15, (1280, 720))
    for k in range(60):
        f = bg.copy()
        if 20 <= k < 40:  # falls from above the band into the trash opening (y 446..561), then is gone
            y = 340 + 9 * (k - 20)
            f[y:y + 36, 250:286] = 230
        out.write(f)
    out.release()
    code = cli.main(["run", "--clip", str(clip), "--clip-id", "fall", "--tracker", "motion", "--dry-run", "--no-stream",
                     "--evidence-dir", str(tmp_path / "ev")], make_embedder=FakeEmbedder)
    events = [json.loads(l) for l in capsys.readouterr().out.splitlines() if l.startswith("{")]
    assert code == 0 and len(events) == 1 and events[0]["bin_id"] == "bin_patio_trash"
