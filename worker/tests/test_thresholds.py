import numpy as np
from fakes import BLUE, GREEN, RED, FakeEmbedder, solid

from recyclone_worker.identify import Gallery
from recyclone_worker.thresholds import best_scores, suggest_threshold


def test_threshold_sits_above_almost_all_distractors():
    scores = list(np.linspace(0.5, 0.8, 101))
    assert suggest_threshold(scores, quantile=0.99) == 0.797


def test_best_scores_against_gallery():
    emb = FakeEmbedder()
    g = Gallery()
    g.add("red", emb.embed(solid(RED)))
    s = best_scores([solid(RED), solid(BLUE)], emb, g)
    assert s[0] > 0.99 and s[1] < s[0]


def test_empty_distractors_give_no_suggestion():
    assert suggest_threshold([], quantile=0.99) is None
