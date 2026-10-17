"""The spoken message: JSON-forced, first word compost / trash / recycle (or None for dangerous items)."""

import json

import pytest

from recyclone_worker import guide_message as gm
from recyclone_worker.site import CONTRACTS

TABLE = gm.WORKER_RULES / "cambridge-ma-2022.bins.json"


def test_message_schema_enforces_three_words():
    with pytest.raises(ValueError):
        gm.make_message("landfill", "x")
    assert gm.make_message("recycle", "aluminum can, placed in recycling")["bin"] == "recycle"


def test_spoken_format():
    assert gm.spoken({"bin": "recycle", "explanation": "aluminum can, placed in recycling"}) == \
        "Recycle. aluminum can, placed in recycling"


def test_explanation_capped_at_8_words():
    m = gm.make_message("trash", "one two three four five six seven eight nine ten")
    assert len(m["explanation"].split()) == 8
    gm.validate_message(m)


def test_hazardous_special_says_none_and_where():
    pt = {"generic_type_id": "gen_mixed_battery", "name": "battery", "form": "battery", "material": "mixed",
          "condition": "clean", "hazardous": True, "suggested_destination": "special", "suggestion_confidence": 0.9}
    assert gm.from_suggestion(pt) == {
        "bin": "none", "explanation": "battery is dangerous to place in any of these bins. Place it in the Recycle Center instead"}
    chem = dict(pt, name="paint can", form="can")
    assert gm.from_suggestion(chem)["explanation"].endswith("Place it in a hazardous waste drop-off instead")


def test_none_only_for_hazardous_items():
    with pytest.raises(ValueError):
        gm.make_message("none", "napkin")  # never from a plain make_message
    mask = {"name": "disposable face mask", "form": "mask", "hazardous": False, "suggested_destination": "special",
            "suggestion_confidence": 0.96}
    assert gm.from_suggestion(mask)["bin"] == "trash"


def test_low_confidence_suggestion_defaults_to_trash():
    pt = {"name": "paper card", "form": "card", "hazardous": False, "suggested_destination": "recycling", "suggestion_confidence": 0.4}
    assert gm.from_suggestion(pt)["bin"] == "trash"
    assert gm.from_suggestion(dict(pt, suggestion_confidence=0.9)) == {"bin": "recycle", "explanation": "paper card, placed in recycling"}


def test_every_catalog_item_has_a_table_row_with_a_valid_bin():
    table = gm.load_bin_table(TABLE)
    catalog = {i["catalog_item_id"] for i in json.loads((CONTRACTS / "fixtures/demo-site.json").read_text())["catalog"]}
    assert catalog <= set(table)
    for cid in catalog:
        assert table[cid]["bin"] in ("compost", "trash", "recycle") and table[cid]["basis"]
        gm.validate_message(gm.from_catalog(cid, table))


def test_catalog_message_reads_like_the_team_example():
    table = gm.load_bin_table(TABLE)
    assert gm.from_catalog("item_generic_can", table) == {"bin": "recycle", "explanation": "aluminum can, placed in recycling"}


def test_default_trash():
    assert gm.default_trash(None) == {"bin": "trash", "explanation": "not sure what this is, placed in trash"}
    assert gm.default_trash("plastic glove")["explanation"] == "plastic glove, placed in trash"


# ---- review fixes (17 Oct): dangerous items are ALWAYS "none"
def _battery(**kw):
    pt = {"name": "battery", "form": "battery", "hazardous": True, "suggested_destination": "recycling", "suggestion_confidence": 0.8}
    pt.update(kw)
    return pt


def test_hazardous_is_none_whatever_jev_says():
    for dest, conf in (("recycling", 0.8), ("compost", 0.9), ("trash", 0.9), ("recycling", 0.2)):
        assert gm.from_suggestion(_battery(suggested_destination=dest, suggestion_confidence=conf))["bin"] == "none"


def test_dangerous_name_is_none_even_if_not_flagged_hazardous():
    m = gm.from_suggestion(_battery(name="lithium battery", hazardous=False, suggested_destination="trash", suggestion_confidence=0.9))
    assert m["bin"] == "none" and "Recycle Center" in m["explanation"]


def test_hazard_words_match_whole_words_only():
    assert gm.from_suggestion({"name": "aluminum foil", "form": "foil", "hazardous": False,
                               "suggested_destination": "recycling", "suggestion_confidence": 0.9})["bin"] == "recycle"
