import json
from datetime import UTC, datetime

from fakes import BLUE, GREEN, RED, FakeEmbedder, solid

from recyclone_worker.categories import GENERIC_PROMPTS, ITEM_PROMPTS, PRODUCT_PROMPTS, CategoryClassifier
from recyclone_worker.events import build_event, validate_event
from recyclone_worker.identify import Gallery, identify

emb = FakeEmbedder()
PROMPTS = {"item_red_thing": ["a red thing"], "item_green_thing": ["a green thing", "something green"],
           "item_blue_thing": ["a blue thing"]}


def classifier():
    return CategoryClassifier(emb, PROMPTS)


def test_classifier_picks_matching_category():
    cid, prob, prompt = classifier().classify([solid(GREEN)])
    assert cid == "item_green_thing" and prompt in PROMPTS["item_green_thing"]
    assert 0 < prob <= 1 and type(prob) is float


def test_probabilities_sum_to_one():
    probs = classifier().probabilities([solid(RED)])
    assert abs(sum(probs.values()) - 1) < 1e-5 and max(probs, key=probs.get) == "item_red_thing"


def test_identify_falls_back_to_category_without_gallery():
    item = identify([solid(BLUE)], emb, Gallery(), categories=classifier(), reference_threshold=0.8)
    assert item["catalog_item_id"] == "item_blue_thing"
    assert item["label"] == "a blue thing"
    assert item["candidates"][0]["catalog_item_id"] == "item_blue_thing"


def test_identify_keeps_strong_reference_match():
    g = Gallery()
    g.add("item_registered", emb.embed(solid(RED)))
    item = identify([solid(RED)], emb, g, categories=classifier(), reference_threshold=0.8)
    assert item["catalog_item_id"] == "item_registered" and item["label"] is None


def test_identify_falls_back_when_reference_is_weak():
    g = Gallery()
    g.add("item_registered", emb.embed(solid(RED)))
    item = identify([solid(BLUE)], emb, g, categories=classifier(), reference_threshold=0.99)
    assert item["catalog_item_id"] == "item_blue_thing"
    assert "item_registered" in [c["catalog_item_id"] for c in item["candidates"]]  # kept as evidence


def test_without_categories_behaviour_is_unchanged():
    assert identify([solid(BLUE)], emb, Gallery())["catalog_item_id"] is None


def test_category_item_is_contract_valid():
    item = identify([solid(BLUE)], emb, Gallery(), categories=classifier(), reference_threshold=0.8)
    validate_event(build_event(camera_id="cam_patio_1", clip_id="c", track_id=1, bin_id="bin_patio_trash",
                               started_at=datetime(2026, 10, 17, tzinfo=UTC), offset_s=1.0,
                               destination_confidence=0.9, item=item, evidence=[]))


def test_every_generic_category_is_in_the_catalog(contracts_dir):
    catalog = {i["catalog_item_id"]: i for i in json.loads((contracts_dir / "fixtures/demo-site.json").read_text())["catalog"]}
    for cid, prompts in GENERIC_PROMPTS.items():
        assert cid in catalog, cid
        assert catalog[cid]["business_id"] is None, f"{cid}: generic categories belong to no business"
        assert prompts and all(isinstance(p, str) and p for p in prompts)


def test_products_are_described_without_registration(contracts_dir):
    """Branded catalog items get text descriptions, so they can be recognized with no photos registered."""
    catalog = {i["catalog_item_id"]: i for i in json.loads((contracts_dir / "fixtures/demo-site.json").read_text())["catalog"]}
    for cid in PRODUCT_PROMPTS:
        assert cid in catalog, cid
    assert "item_shakeshack_cup" in PRODUCT_PROMPTS and catalog["item_shakeshack_cup"]["business_id"] == "biz_shakeshack"
    assert set(ITEM_PROMPTS) == set(PRODUCT_PROMPTS) | set(GENERIC_PROMPTS)


def test_category_runner_ups_are_kept_as_candidates():
    """A generic top match with a branded runner-up must keep the runner-up, so business evidence survives."""
    prompts = {"item_generic_cup": ["a red cup"], "item_branded_cup": ["a red cup with a logo", "red"], "item_blue": ["a blue thing"]}
    item = identify([solid(RED)], emb, Gallery(), categories=CategoryClassifier(emb, prompts), reference_threshold=0.8)
    ids = [c["catalog_item_id"] for c in item["candidates"]]
    assert len(ids) == 3 and ids[0] == item["catalog_item_id"]
    scores = [c["score"] for c in item["candidates"]]
    assert scores == sorted(scores, reverse=True)
