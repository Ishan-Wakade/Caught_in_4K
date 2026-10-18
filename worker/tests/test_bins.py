"""Bin openings found once per clip by a vision model, and which opening a held item went into."""

import json

import numpy as np

from recyclone_worker import bins

FRAME = np.zeros((1920, 1080, 3), np.uint8)
ANSWER = {"openings": [
    {"label_text": "RECYCLING", "bin": "recycle", "x0": 421, "y0": 955, "x1": 499, "y1": 992},
    {"label_text": "WASTE", "bin": "trash", "x0": 414, "y0": 1007, "x1": 508, "y1": 1055},
    {"label_text": "ORGANICS", "bin": "compost", "x0": 407, "y0": 1077, "x1": 517, "y1": 1147},
]}


def fake_post(calls, answer=ANSWER):
    def post(url, headers, body, timeout):
        calls.append(json.loads(body))
        return {"content": [{"type": "text", "text": json.dumps(answer)}], "usage": {"input_tokens": 2265, "output_tokens": 145}}
    return post


def test_openings_come_back_in_frame_pixels_and_are_cached(tmp_path):
    calls = []
    ops = bins.detect_openings(FRAME, tmp_path, key="k", post=fake_post(calls))
    assert [o["bin"] for o in ops] == ["recycle", "trash", "compost"] and ops[2]["label"] == "ORGANICS"
    s = 1920 / 1536  # the model saw the frame scaled so its long side is 1536
    assert ops[0]["box"] == (round(421 * s), round(955 * s), round(499 * s), round(992 * s))
    body = calls[0]
    assert body["model"] == "claude-sonnet-5-5" and body["output_config"]["format"]["type"] == "json_schema"
    assert body["thinking"] == {"type": "between_tools"}
    assert bins.detect_openings(FRAME, tmp_path, key="k", post=fake_post(calls)) == ops and len(calls) == 1


def test_no_key_or_no_openings_gives_an_empty_list(tmp_path):
    assert bins.detect_openings(FRAME, tmp_path, key="", post=fake_post([])) == []
    assert bins.detect_openings(FRAME, tmp_path / "b", key="k", post=fake_post([], {"openings": []})) == []


def test_the_bin_area_covers_the_openings_and_the_floor_in_front():
    ops = [{"bin": "trash", "label": "WASTE", "box": (400, 1000, 500, 1050)}]
    x0, y0, x1, y1 = bins.area_from_openings(ops, 1080, 1920)
    assert x0 < 400 and x1 > 500 and y0 < 1000 and y1 > 1100


def test_the_item_goes_into_the_opening_it_was_held_over_while_the_person_stood_at_the_bins():
    ops = [{"bin": "recycle", "label": "RECYCLING", "box": (420, 950, 500, 990)},
           {"bin": "compost", "label": "ORGANICS", "box": (410, 1080, 520, 1150)}]
    # (t, item box while held, feet distance to the bins in meters)
    trace = [(1.0, (300, 600, 380, 680), 3.0), (2.0, (430, 1060, 510, 1140), 0.0), (2.2, (440, 1080, 500, 1140), 0.0),
             (2.4, None, 0.0),
             (6.0, (420, 930, 500, 990), 2.5)]  # IMG_9117: walking away, the hand passes over RECYCLING in the image
    assert bins.thrown_into(trace, ops) == {"t": 2.2, "bin": "compost", "label": "ORGANICS"}
    assert bins.thrown_into([(1.0, (0, 0, 50, 50), 0.0), (1.5, None, 0.0)], ops) is None  # never over an opening
    assert bins.thrown_into([(1.0, (430, 1060, 510, 1140), 3.0)], ops) is None  # over it in the image, but far away


def test_outcome_text_says_correct_or_wrong():
    rec = {"bin": "compost", "item": "bread roll", "place": "compost", "reason": "food scraps are compostable"}
    assert bins.outcome_text(rec, {"t": 2.2, "bin": "compost", "label": "ORGANICS"}) == ("Thrown in: Organics", "CORRECT", True)
    assert bins.outcome_text(rec, {"t": 2.2, "bin": "trash", "label": "WASTE"}) == ("Thrown in: Waste", "WRONG BIN", False)


def test_the_drop_is_the_end_of_the_long_carrying_stretch_not_a_late_false_sighting():
    """IMG_9117: carried 0-7.1 s, dropped into WASTE at ~7.0 s; at 8.24 s, walking away, CLIP took the bin in the hand
    crop for an item over RECYCLING. Sightings are only frames where CLIP saw the item."""
    ops = [{"bin": "recycle", "label": "RECYCLING", "box": (420, 950, 500, 990)},
           {"bin": "trash", "label": "WASTE", "box": (414, 1007, 508, 1055)}]
    carry = [(t / 10, (200 + t * 3, 500 + t * 5, 260 + t * 3, 560 + t * 5), 1.0) for t in range(0, 65)]  # walking up
    reach = [(6.5, (430, 940, 490, 1000), 0.0), (6.8, (430, 1000, 500, 1060), 0.0), (7.0, (425, 1005, 505, 1060), 0.0)]
    gap = [(7.2 + k / 10, None, 0.0) for k in range(10)]
    late = [(8.24, (420, 945, 500, 995), 0.0)]
    assert bins.thrown_into(carry + reach + gap + late, ops) == {"t": 7.0, "bin": "trash", "label": "WASTE"}


def test_the_drop_point_is_where_the_item_hangs_not_the_hand_centre():
    """IMG_9117 (camera above and behind): at 7.31 s the item box was (478, 1158, 642, 1322); its centre (y 1240) looks
    over RECYCLING (1196-1241) because the raised hand projects higher, but the cup hung below the hand into WASTE."""
    ops = [{"bin": "recycle", "label": "RECYCLING", "box": (526, 1196, 625, 1241)},
           {"bin": "trash", "label": "WASTE", "box": (518, 1259, 635, 1320)},
           {"bin": "compost", "label": "ORGANICS", "box": (509, 1348, 648, 1435)}]
    trace = [(6.0 + k / 10, (300, 1060, 400, 1160), 0.0) for k in range(8)] + [(6.81, (504, 1121, 663, 1280), 0.04),
                                                                                (7.31, (478, 1158, 642, 1322), 0.04)]
    assert bins.thrown_into(trace, ops)["label"] == "WASTE"


def test_carry_end_is_the_end_of_the_longest_stretch():
    trace = [(t / 10, (0, 0, 10, 10), 0.0) for t in range(0, 50)] + [(6.0, None, 0.0), (8.0, (0, 0, 10, 10), 0.0)]
    assert bins.carry_end(trace) == 4.9
    assert bins.carry_end([(1.0, None, 0.0)]) is None


def test_openings_that_moved_mean_the_camera_moved():
    a = [{"bin": "trash", "label": "WASTE", "box": (400, 1000, 500, 1050)}]
    assert bins.same_openings(a, [{"bin": "trash", "label": "WASTE", "box": (410, 1005, 512, 1056)}], width=1080)
    assert not bins.same_openings(a, [{"bin": "trash", "label": "WASTE", "box": (800, 900, 900, 950)}], width=1080)  # IMG_9121 pan
    assert not bins.same_openings(a, [], width=1080)


def test_unknown_openings_take_their_type_from_the_reference_in_the_same_order():
    """Far away (IMG_9121 at the drop) the labels are unreadable; it is the same unit as in the first frame."""
    ref = [{"bin": "recycle", "label": "RECYCLING", "box": (501, 808, 654, 864)},
           {"bin": "trash", "label": "WASTE", "box": (658, 828, 852, 900)},
           {"bin": "compost", "label": "ORGANICS", "box": (878, 861, 1051, 922)}]
    here = [{"bin": "unknown", "label": "", "box": (864, 919, 976, 954)}, {"bin": "unknown", "label": "", "box": (706, 852, 802, 884)},
            {"bin": "unknown", "label": "", "box": (765, 880, 900, 921)}]
    fixed = bins.fill_from_reference(here, ref)
    assert [(o["box"][0], o["bin"], o["label"]) for o in fixed] == [(706, "recycle", "RECYCLING"), (765, "trash", "WASTE"),
                                                                     (864, "compost", "ORGANICS")]
    assert bins.fill_from_reference(here[:2], ref) == here[:2]  # different count: leave as is


def test_the_prompt_reads_icons_too():
    assert "icon" in bins.PROMPT


def test_an_arm_over_the_bins_is_not_a_moving_camera_but_a_pan_is():
    """IMG_9118-9120: at the drop the arm covers the openings and the boxes shift a little; IMG_9121 pans ~200 px."""
    a = [{"bin": "recycle", "label": "R", "box": (526, 1196, 625, 1241)}]
    assert bins.same_openings(a, [{"bin": "recycle", "label": "R", "box": (560, 1230, 660, 1280)}], width=1080)
    assert not bins.same_openings(a, [{"bin": "recycle", "label": "R", "box": (760, 1100, 860, 1150)}], width=1080)


def test_no_verdict_when_the_opening_type_is_unknown():
    rec = {"bin": "trash", "item": "cup", "place": "trash", "reason": "x"}
    assert bins.outcome_text(rec, {"t": 1.0, "bin": "unknown", "label": ""}) is None
