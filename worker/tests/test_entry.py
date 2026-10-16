"""Bin-entry decision. The throw_score cases describe behavior Eymen's implementation must satisfy."""

import pytest

from recyclone_worker import entry
from recyclone_worker.entry import entered_bin, throw_score
from recyclone_worker.site import BinRegion

FRAME = (1280, 720)
TRASH = BinRegion("bin_patio_trash", 0.1, 0.62, 0.22, 0.16)  # (128, 446, 282, 115) px
RECYCLING = BinRegion("bin_patio_recycling", 0.39, 0.62, 0.22, 0.16)
TRASH_PX = TRASH.to_pixels(*FRAME)


def path(*points):
    return [tuple(map(float, p)) for p in points]


# --- throw_score: Eymen's implementation must pass these -------------------------------------

def test_falls_into_bin():
    h = path((100, 200), (150, 280), (200, 360), (240, 430), (260, 470), (268, 490), (270, 500))
    assert throw_score(h, TRASH_PX) >= 0.5


def test_held_near_and_carried_away():
    h = path((100, 200), (200, 380), (260, 440), (262, 450), (240, 400), (150, 300), (100, 200))
    assert throw_score(h, TRASH_PX) < 0.5


def test_passes_over_bin():
    h = path((50, 470), (200, 470), (300, 470), (450, 470), (700, 470), (900, 470))
    assert throw_score(h, TRASH_PX) < 0.5


def test_too_short_history():
    assert throw_score(path((270, 500)), TRASH_PX) < 0.5


# --- entered_bin: picks among regions using throw_score -----------------------------------------

@pytest.fixture
def scores(monkeypatch):
    table = {}
    monkeypatch.setattr(entry, "throw_score", lambda history, roi: table.get(roi, 0.0))
    return table


def test_entered_bin_picks_best_region(scores):
    scores[TRASH_PX] = 0.6
    scores[RECYCLING.to_pixels(*FRAME)] = 0.8
    assert entered_bin(path((0, 0), (1, 1)), [TRASH, RECYCLING], FRAME) == ("bin_patio_recycling", 0.8)


def test_entered_bin_none_when_no_region_scores(scores):
    scores[TRASH_PX] = 0.4
    assert entered_bin(path((0, 0), (1, 1)), [TRASH, RECYCLING], FRAME) is None


def test_entered_bin_tie_is_ambiguous(scores):
    scores[TRASH_PX] = 0.7
    scores[RECYCLING.to_pixels(*FRAME)] = 0.7
    assert entered_bin(path((0, 0), (1, 1)), [TRASH, RECYCLING], FRAME) is None


# --- added after review: gaps in the original spec -------------------------------------------

def test_stationary_object_in_region_is_not_a_throw():
    """A bin lid or a cup left on the bin, tracked until the clip ends, never moved: not a disposal."""
    assert throw_score(path(*[(270, 500)] * 8), TRASH_PX) < 0.5


def test_vanishes_at_rim_while_falling():
    """Real throws often disappear just above the opening (the rim hides them)."""
    x, y, w, h = TRASH_PX
    h_ = path((200, 200), (220, 300), (240, 380), (250, y - 30), (255, y - 10))
    assert throw_score(h_, TRASH_PX) >= 0.5


def test_rising_above_rim_is_not_a_throw():
    x, y, w, h = TRASH_PX
    h_ = path((255, y - 10), (250, y - 30), (240, y - 50), (230, y - 60))
    assert throw_score(h_, TRASH_PX) < 0.5


def test_score_is_python_float_in_unit_range():
    s = throw_score(path((100, 200), (200, 360), (260, 470), (270, 500)), TRASH_PX)
    assert type(s) is float and 0.0 <= s <= 1.0


def test_entered_bin_clamps_and_converts(monkeypatch):
    import numpy as np
    monkeypatch.setattr(entry, "throw_score", lambda h, roi: np.float32(1.3) if roi == TRASH_PX else 0.0)
    bin_id, conf = entered_bin(path((0, 0), (1, 1)), [TRASH, RECYCLING], FRAME)
    assert bin_id == "bin_patio_trash" and type(conf) is float and conf == 1.0
