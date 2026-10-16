import pytest

from recyclone_worker.tracking import is_item_class


@pytest.mark.parametrize("name", ["person", "backpack", "handbag", "tie", "suitcase", "toilet", "chair", "bench", "dining table"])
def test_people_wearables_and_furniture_are_not_items(name):
    assert not is_item_class(name)


@pytest.mark.parametrize("name", ["bottle", "cup", "banana", "book", "cell phone", "sandwich"])
def test_disposable_things_are_items(name):
    assert is_item_class(name)
