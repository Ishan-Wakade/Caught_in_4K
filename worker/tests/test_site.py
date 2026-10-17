import pytest

from recyclone_worker.site import BinRegion, load_site


def test_loads_demo_camera_regions(contracts_dir):
    site = load_site("cam_patio_1", contracts_dir / "fixtures/demo-site.json")
    assert {r.bin_id for r in site.regions} == {"bin_patio_trash", "bin_patio_recycling", "bin_patio_compost"}
    assert site.camera_id == "cam_patio_1"
    assert "item_beanco_cup" in site.catalog_ids


def test_to_pixels_scales():
    assert BinRegion("b", 0.1, 0.62, 0.22, 0.16).to_pixels(1280, 720) == (128, 446, 282, 115)


def test_unknown_camera_raises(contracts_dir):
    with pytest.raises(ValueError, match="cam_nowhere"):
        load_site("cam_nowhere", contracts_dir / "fixtures/demo-site.json")


def test_catalog_from_api_with_fallback(monkeypatch, contracts_dir, capsys):
    import recyclone_worker.site as site_mod
    from recyclone_worker.site import load_catalog_ids
    monkeypatch.setattr(site_mod, "_get_json", lambda url, timeout: [{"catalog_item_id": "item_x"}])
    assert load_catalog_ids("http://api") == {"item_x"}

    def down(url, timeout):
        raise OSError("down")
    monkeypatch.setattr(site_mod, "_get_json", down)
    ids = load_catalog_ids("http://api", contracts_dir / "fixtures/demo-site.json")
    assert "item_beanco_cup" in ids and "fixture" in capsys.readouterr().err


def test_catalog_businesses(contracts_dir, capsys):
    from recyclone_worker.site import load_catalog
    cat = load_catalog(None, contracts_dir / "fixtures/demo-site.json")
    assert cat["item_beanco_cup"] == "biz_beanco" and cat["item_generic_can"] is None


def test_profile_thresholds(contracts_dir):
    from recyclone_worker.site import load_profile
    demo = load_profile("demo", contracts_dir / "fixtures/demo-site.json")
    assert 0 < demo["item_confidence_threshold"] <= 1
