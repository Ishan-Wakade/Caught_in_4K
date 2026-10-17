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
