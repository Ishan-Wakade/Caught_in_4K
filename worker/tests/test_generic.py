"""New item types: generic type from the vision LLM's answer, bin suggestion from Jev (faked: no network, no key)."""

import json

from recyclone_worker import generic, namer
from recyclone_worker.events import validate_event

MASK = {"catalog_item_id": None, "what": "light blue disposable face mask", "material": "fabric", "confidence": 0.3,
        "generic": {"name": "disposable face mask", "material": "textile", "form": "Mask", "condition": "clean", "hazardous": False}}


def fake_jev(choice="trash", conf=0.81, calls=None):
    def run(state):
        if calls is not None:
            calls.append(json.loads(state))
        return {"answers": {"answer": {"type": "choice", "choice": choice, "confidence": conf}}}
    return run


def rules(tmp_path):
    p = tmp_path / "town-rules.md"
    p.write_text("RECYCLE: cans. COMPOST: napkins. TRASH: everything else.")
    return p


def test_generic_type_id_depends_on_material_and_form_only():
    a = generic.generic_type(MASK)
    b = generic.generic_type(dict(MASK, generic=dict(MASK["generic"], name="white face mask", condition="unknown")))
    assert a["generic_type_id"] == b["generic_type_id"] == "gen_textile_mask"
    odd = generic.generic_type(dict(MASK, generic=dict(MASK["generic"], material="cloth", condition="dirty")))
    assert odd["material"] == "unknown" and odd["condition"] == "unknown"  # never a value outside the contract
    assert generic.generic_type({"what": "something", "generic": {"name": "thing"}}) is None  # no form: no type


def test_jev_suggestion_is_raw_and_cached_per_type(tmp_path):
    calls = []
    adv = generic.BinAdvisor(rules(tmp_path), tmp_path / "types.json", runner=fake_jev("trash", 0.81, calls))
    s = adv.suggest(generic.generic_type(MASK))
    assert (s["suggested_destination"], s["suggestion_confidence"], s["rule_source"]) == ("trash", 0.81, "town-rules")
    assert calls[0]["item"]["material"] == "textile" and "TRASH" in calls[0]["local_rules"]  # text only, no image
    assert calls[0]["item"]["description"] == "light blue disposable face mask"  # the full look, not only the name
    again = generic.BinAdvisor(rules(tmp_path), tmp_path / "types.json", runner=fake_jev("compost", 0.99, calls))
    assert again.suggest(generic.generic_type(MASK))["suggested_destination"] == "trash" and len(calls) == 1  # one call per type


def test_low_confidence_is_still_sent_raw_and_a_failed_call_sends_no_bin(tmp_path):
    adv = generic.BinAdvisor(rules(tmp_path), tmp_path / "t.json", runner=fake_jev("special", 0.4))
    assert adv.suggest(generic.generic_type(MASK))["suggestion_confidence"] == 0.4  # core decides, not the worker

    def broken(state):
        raise RuntimeError("jev exit 4")
    bad = generic.BinAdvisor(rules(tmp_path), tmp_path / "u.json", runner=broken).suggest(generic.generic_type(MASK))
    assert bad["suggested_destination"] is None and bad["suggestion_confidence"] is None and bad["rule_source"] == "town-rules"


def test_new_type_reaches_the_event_and_validates(tmp_path):
    from test_items_run import fake_analysis, play

    pt = generic.for_event(generic.BinAdvisor(rules(tmp_path), tmp_path / "t.json", runner=fake_jev()).suggest(generic.generic_type(MASK)))
    a = fake_analysis()
    a.events[0]["llm"] = dict(MASK, catalog_item_id=None, proposed_type=pt)
    sent, _ = play(a, tmp_path)
    item = sent[0]["item"]
    assert item["catalog_item_id"] is None and item["proposed_type"]["generic_type_id"] == "gen_textile_mask"
    validate_event(sent[0])


def test_catalog_items_never_carry_a_proposal():
    item = namer.item_from_answer(dict(MASK, catalog_item_id="item_napkin", confidence=0.7,
                                       proposed_type={"generic_type_id": "gen_paper_napkin"}), {"candidates": []})
    assert "proposed_type" not in item
