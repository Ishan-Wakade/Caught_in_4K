"""The spoken message: JSON-forced, first word compost / trash / recycle (or None for dangerous items)."""

import json

import pytest

from recyclone_worker import guide_message as gm
from recyclone_worker.site import CONTRACTS

TABLE = gm.WORKER_RULES / "cambridge-ma-2022.bins.json"


CAN = {"bin": "recycle", "item": "aluminum can", "place": "recycling", "reason": "metal cans are recyclable in Cambridge"}


def test_message_schema_is_bin_item_place_reason():
    with pytest.raises(ValueError):
        gm.make_message("landfill", "x", "y")
    assert gm.make_message("recycle", "aluminum can", "metal cans are recyclable in Cambridge") == CAN
    with pytest.raises(ValueError):
        gm.validate_message({"bin": "recycle", "explanation": "aluminum can, placed in recycling"})  # the old shape


def test_spoken_format():
    assert gm.spoken(CAN) == "Recycling. Aluminum can should be placed in recycling because metal cans are recyclable in Cambridge."
    napkin = gm.make_message("compost", "paper napkin", "napkins and paper towels are compostable")
    assert gm.spoken(napkin) == "Compost. Paper napkin should be placed in compost because napkins and paper towels are compostable."


def test_item_and_reason_are_kept_short():
    m = gm.make_message("trash", "one two three four five six seven eight", " ".join(["word"] * 30))
    assert len(m["item"].split()) <= gm.MAX_ITEM_WORDS and len(m["reason"].split()) <= gm.MAX_REASON_WORDS
    gm.validate_message(m)


def test_catalog_items_have_a_rule_based_reason():
    table = gm.load_bin_table(TABLE)
    m = gm.from_catalog("item_generic_can", table)
    assert m["bin"] == "recycle" and m["item"] == "aluminum can" and m["reason"]
    for cid in table:
        assert table[cid].get("reason"), cid


def test_default_trash_says_we_are_not_sure():
    assert gm.spoken(gm.default_trash(None)) == \
        "Trash. This item should be placed in trash because we are not sure what it is."


def test_hazardous_special_says_none_and_where():
    pt = {"generic_type_id": "gen_mixed_battery", "name": "battery", "form": "battery", "material": "mixed",
          "condition": "clean", "hazardous": True, "suggested_destination": "special", "suggestion_confidence": 0.9}
    m = gm.from_suggestion(pt)
    assert m == {"bin": "none", "item": "battery", "place": "the Recycle Center",
                 "reason": "it is dangerous in any of these bins"}
    assert gm.spoken(m) == "None. Battery should be placed in the Recycle Center because it is dangerous in any of these bins."
    chem = dict(pt, name="paint can", form="can")
    assert gm.from_suggestion(chem)["place"] == "a hazardous waste drop-off"


def test_none_only_for_hazardous_items():
    with pytest.raises(ValueError):
        gm.make_message("none", "napkin", "x")  # never from a plain make_message
    mask = {"name": "disposable face mask", "form": "mask", "hazardous": False, "suggested_destination": "special",
            "suggestion_confidence": 0.96}
    assert gm.from_suggestion(mask)["bin"] == "trash"


def test_suggestion_uses_the_reason_for_the_chosen_bin():
    pt = {"name": "paper card", "form": "card", "hazardous": False, "suggested_destination": "recycling", "suggestion_confidence": 0.9}
    reasons = {"recycling": "clean paper is recyclable", "trash": "it is coated"}
    assert gm.from_suggestion(pt, reasons) == {"bin": "recycle", "item": "paper card", "place": "recycling",
                                               "reason": "clean paper is recyclable"}
    low = gm.from_suggestion(dict(pt, suggestion_confidence=0.4), reasons)
    assert low["bin"] == "trash" and low["reason"] == "we are not sure where it belongs"


def test_item_and_bin_for_the_screen():
    assert gm.item_and_bin(CAN) == ("aluminum can", "Recycle")
    assert gm.item_and_bin({"bin": "none", "item": "AA battery", "place": "the Recycle Center",
                            "reason": "it is dangerous in any of these bins"}) == ("AA battery", "No bin: Recycle Center")


def test_every_catalog_item_has_a_table_row_with_a_valid_bin():
    table = gm.load_bin_table(TABLE)
    catalog = {i["catalog_item_id"] for i in json.loads((CONTRACTS / "fixtures/demo-site.json").read_text())["catalog"]}
    assert catalog <= set(table)
    for cid in catalog:
        assert table[cid]["bin"] in ("compost", "trash", "recycle") and table[cid]["basis"]
        gm.validate_message(gm.from_catalog(cid, table))


def test_catalog_message_reads_like_the_team_example():
    table = gm.load_bin_table(TABLE)
    assert gm.from_catalog("item_generic_can", table) == CAN


def test_default_trash():
    assert gm.default_trash(None) == {"bin": "trash", "item": "this item", "place": "trash", "reason": "we are not sure what it is"}
    assert gm.spoken(gm.default_trash("plastic glove")) == \
        "Trash. Plastic glove should be placed in trash because we are not sure where it belongs."


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
    assert m["bin"] == "none" and m["place"] == "the Recycle Center"


def test_hazard_words_match_whole_words_only():
    assert gm.from_suggestion({"name": "aluminum foil", "form": "foil", "hazardous": False,
                               "suggested_destination": "recycling", "suggestion_confidence": 0.9})["bin"] == "recycle"


def test_a_special_but_safe_item_uses_the_llms_trash_reason_not_we_are_not_sure():
    """Jev: plastic bag -> "special" (store drop-off); not dangerous, so the bin is trash, with the real reason."""
    bag = {"name": "plastic shopping bag", "form": "bag", "hazardous": False, "suggested_destination": "special",
           "suggestion_confidence": 0.9}
    m = gm.from_suggestion(bag, {"recycling": "bags jam the sorting machines", "trash": "plastic bags cannot go in recycling carts"})
    assert m == {"bin": "trash", "item": "plastic shopping bag", "place": "trash", "reason": "plastic bags cannot go in recycling carts"}
