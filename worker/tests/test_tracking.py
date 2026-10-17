import pytest

from recyclone_worker.tracking import is_item_class


@pytest.mark.parametrize("name", ["person", "backpack", "handbag", "tie", "suitcase", "toilet", "chair", "bench", "dining table"])
def test_people_wearables_and_furniture_are_not_items(name):
    assert not is_item_class(name)


@pytest.mark.parametrize("name", ["bottle", "cup", "banana", "book", "cell phone", "sandwich"])
def test_disposable_things_are_items(name):
    assert is_item_class(name)


def test_hands_are_not_items():
    assert not is_item_class("hand")


def test_world_prompts_cover_generic_categories_and_people():
    from recyclone_worker.categories import GENERIC_PROMPTS
    from recyclone_worker.tracking import WORLD_PROMPTS
    for prompts in GENERIC_PROMPTS.values():
        assert any(p in WORLD_PROMPTS for p in prompts)
    assert "person" in WORLD_PROMPTS and "hand" in WORLD_PROMPTS  # detected so they can be dropped
