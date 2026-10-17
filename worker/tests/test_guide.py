"""The guide loop: a person holding an item comes close -> one spoken message (scripted skeletons, no models)."""

import json

import cv2
import numpy as np

from recyclone_worker import approach as ap
from recyclone_worker import guide as gd
from recyclone_worker.voice import SilentVoice

AREA = ap.BinArea(800, 300, 1000, 700)
PX_PER_M = 340 / 0.87 / 1.7
FRAME = np.zeros((720, 1280, 3), np.uint8)
CAN = {"bin": "recycle", "explanation": "aluminum can, placed in recycling"}
NAPKIN = {"bin": "compost", "explanation": "paper napkin, placed in compost"}


def person(feet_x, feet_y=700, height_px=340):
    k = np.zeros((17, 3), np.float32)
    top = feet_y - height_px / 0.87
    k[0] = (feet_x, feet_y - height_px, 0.9)
    k[5], k[6] = (feet_x + 20, top + 60, 0.9), (feet_x - 20, top + 60, 0.9)
    k[11], k[12] = (feet_x + 15, top + 180, 0.9), (feet_x - 15, top + 180, 0.9)
    k[15], k[16] = (feet_x + 10, feet_y, 0.9), (feet_x - 10, feet_y, 0.9)
    return k


class FakeWatcher:
    def __init__(self, answers: dict, ready_at: dict | None = None, holding=True):
        self.answers, self.ready_at, self.hold = answers, ready_at or {}, holding

    def observe(self, track_id, t, frame, kp):
        pass

    def holding(self, track_id, now):
        return self.hold

    def answer(self, track_id, now):
        if track_id in self.answers and now >= self.ready_at.get(track_id, 0.0):
            return self.answers[track_id], "catalog"
        return None

    def failed(self, track_id):
        return False


def scripted(positions):
    """positions(t) -> list[(track_id, feet_x)]"""
    return lambda t: [(tid, person(x)) for tid, x in positions(t)]


def run(guide, seconds=5.0, fps=30):
    out = []
    for k in range(int(seconds * fps)):
        out += guide.step(k, k / fps, FRAME)
    return out


def make(positions, watcher, tmp_path):
    clock = {"t": 0.0}
    pose = scripted(positions)
    g = gd.Guide(lambda frame: pose(clock["t"]), watcher, ap.Approach(AREA), SilentVoice(), log_path=tmp_path / "log.jsonl", area=AREA)
    orig = g.step

    def step(idx, t, frame):
        clock["t"] = t
        return orig(idx, t, frame)
    g.step = step
    return g


def test_two_people_each_get_their_own_announcement(tmp_path):
    g = make(lambda t: [(1, AREA.x0 - (4 - t) * PX_PER_M), (2, AREA.x0 - (4.5 - t) * PX_PER_M)],
             FakeWatcher({1: CAN, 2: NAPKIN}), tmp_path)
    said = run(g)
    assert sorted((a["track_id"], a["message"]["bin"]) for a in said) == [(1, "recycle"), (2, "compost")]
    assert all(a["source"] == "catalog" for a in said)
    assert len((tmp_path / "log.jsonl").read_text().splitlines()) == 2


def test_person_standing_in_area_announced_once(tmp_path):
    g = make(lambda t: [(1, 900)], FakeWatcher({1: CAN}), tmp_path)
    assert len(run(g, 4.0)) == 1


def test_no_answer_by_arrival_says_trash(tmp_path):
    g = make(lambda t: [(1, AREA.x0 - (3 - t) * PX_PER_M if t < 3 else 900)], FakeWatcher({}), tmp_path)
    said = run(g)
    assert len(said) == 1 and said[0]["message"]["bin"] == "trash" and said[0]["source"] == "default"
    assert said[0]["t"] >= 2.9  # waited until the person reached the bins


def test_late_answer_is_spoken_when_ready_before_arrival(tmp_path):
    g = make(lambda t: [(1, AREA.x0 - (4 - t) * PX_PER_M)], FakeWatcher({1: NAPKIN}, ready_at={1: 2.0}), tmp_path)
    said = run(g)
    assert len(said) == 1 and said[0]["message"] == NAPKIN and 2.0 <= said[0]["t"] < 4.0


def test_person_without_an_item_is_not_announced(tmp_path):
    g = make(lambda t: [(1, 900)], FakeWatcher({1: CAN}, holding=False), tmp_path)
    assert run(g, 3.0) == []


def test_voice_hears_the_spoken_sentence(tmp_path):
    g = make(lambda t: [(1, 900)], FakeWatcher({1: CAN}), tmp_path)
    run(g, 1.0)
    assert g.voice.spoken[0][1] == "Recycle. aluminum can, placed in recycling"


def test_cli_guide_dry_run_on_a_file(tmp_path, capsys):
    from recyclone_worker import cli

    clip = tmp_path / "c.mp4"
    out = cv2.VideoWriter(str(clip), cv2.VideoWriter_fourcc(*"mp4v"), 10, (1280, 720))
    for _ in range(30):
        out.write(FRAME)
    out.release()

    def parts(args, area):
        return (lambda frame: [(1, person(900))]), FakeWatcher({1: CAN})

    code = cli.main(["guide", "--source", str(clip), "--area", "800,300,1000,700", "--voice", "silent", "--no-stream",
                     "--log", str(tmp_path / "g.jsonl"), "--render", str(tmp_path / "out.mp4")], make_guide_parts=parts)
    assert code == 0
    lines = [json.loads(line) for line in (tmp_path / "g.jsonl").read_text().splitlines()]
    assert len(lines) == 1 and lines[0]["message"] == CAN
    assert (tmp_path / "out.mp4").exists() and "fps" in capsys.readouterr().err


def test_same_person_with_a_new_track_id_is_not_announced_again(tmp_path):
    # the tracker re-numbers the person (turning around) while standing at the bins: one announcement, not two
    g = make(lambda t: [(1 if t < 1.0 else 7, 900)], FakeWatcher({1: CAN, 7: CAN}), tmp_path)
    assert len(run(g, 3.0)) == 1


# ---- review fixes (17 Oct)
class TimedWatcher(FakeWatcher):
    """holding(track, t) from a function; answers like FakeWatcher; records forget()."""

    def __init__(self, answers, hold_fn, ready_at=None):
        super().__init__(answers, ready_at)
        self.hold_fn, self.forgotten = hold_fn, []

    def holding(self, track_id, now):
        return self.hold_fn(track_id, now)

    def forget(self, track_id):
        self.forgotten.append(track_id)


def test_item_first_seen_inside_the_area_waits_briefly_for_its_answer(tmp_path):
    g = make(lambda t: [(1, 900)], FakeWatcher({1: CAN}, ready_at={1: 0.3}), tmp_path)
    said = run(g, 2.0)
    assert len(said) == 1 and said[0]["message"] == CAN  # not an instant "trash"


def test_side_by_side_person_is_not_mistaken_for_a_renumbered_one(tmp_path):
    # A (1) and B (2) walk in together, both visible from the start; A is announced, then hidden behind B; B picks
    # up an item and must still be told
    positions = lambda t: ([(1, 900)] if t < 1.0 else []) + [(2, 930)]  # noqa: E731
    w = TimedWatcher({1: CAN, 2: NAPKIN}, lambda tid, t: tid == 1 or t >= 1.05)
    said = run(make(positions, w, tmp_path), 3.0)
    assert sorted(a["track_id"] for a in said) == [1, 2]


def test_person_out_of_view_hears_their_real_answer_not_trash(tmp_path):
    positions = lambda t: [(1, AREA.x0 - (4 - t) * PX_PER_M)] if t < 1.6 else []  # noqa: E731
    said = run(make(positions, FakeWatcher({1: NAPKIN}, ready_at={1: 2.0}), tmp_path), 5.0)
    assert len(said) == 1 and said[0]["message"] == NAPKIN


def test_gone_people_are_forgotten(tmp_path):
    w = TimedWatcher({1: CAN}, lambda tid, t: True)
    g = make(lambda t: [(1, 900)] if t < 1.0 else [], w, tmp_path)
    run(g, 15.0)
    assert 1 in w.forgotten and 1 not in g.approach.hist and 1 not in g.announced_at


def test_ctrl_c_still_writes_the_video_and_prints_fps(tmp_path, capsys):
    from recyclone_worker import cli

    clip = tmp_path / "c.mp4"
    out = cv2.VideoWriter(str(clip), cv2.VideoWriter_fourcc(*"mp4v"), 10, (1280, 720))
    for _ in range(30):
        out.write(FRAME)
    out.release()
    calls = {"n": 0}

    def pose(frame):
        calls["n"] += 1
        if calls["n"] > 15:
            raise KeyboardInterrupt
        return [(1, person(900))]

    code = cli.main(["guide", "--source", str(clip), "--area", "800,300,1000,700", "--voice", "silent", "--no-stream",
                     "--log", str(tmp_path / "g.jsonl"), "--render", str(tmp_path / "out.mp4")],
                    make_guide_parts=lambda args, area: (pose, FakeWatcher({1: CAN})))
    assert code == 0 and (tmp_path / "out.mp4").exists() and "fps" in capsys.readouterr().err


# ---- filming helpers (17 Oct)
def test_list_cameras_reports_each_working_index():
    class Cap:
        def __init__(self, i):
            self.i = i

        def isOpened(self):
            return self.i in (0, 1)

        def read(self):
            return (True, np.zeros((1080 if self.i else 720, 1920 if self.i else 1280, 3), np.uint8))

        def release(self):
            pass
    assert gd.list_cameras(max_index=3, opener=Cap) == [(0, 1280, 720), (1, 1920, 1080)]


def test_cctv_look_adds_a_camera_label_and_clock(tmp_path):
    g = make(lambda t: [], FakeWatcher({}), tmp_path)
    g.step(0, 0.0, FRAME)
    plain, cctv = g.annotate(FRAME, 0.0), g.annotate(FRAME, 0.0, cctv="CAM 01")
    assert (cctv[:120, :700] != plain[:120, :700]).any()
