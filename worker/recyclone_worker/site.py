"""Which bins this camera watches, from the shared demo-site fixture (contracts §0)."""

import json
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"


@dataclass(frozen=True)
class BinRegion:
    """A bin opening in the camera frame, normalized to 0..1 so it fits any video resolution."""

    bin_id: str
    x: float
    y: float
    w: float
    h: float

    def to_pixels(self, width: int, height: int) -> tuple[int, int, int, int]:
        return round(self.x * width), round(self.y * height), round(self.w * width), round(self.h * height)


@dataclass(frozen=True)
class Site:
    camera_id: str
    regions: list[BinRegion]
    catalog_ids: set[str]


def load_site(camera_id: str, fixture_path: Path = CONTRACTS / "fixtures/demo-site.json") -> Site:
    data = json.loads(Path(fixture_path).read_text())
    camera = next((c for c in data["cameras"] if c["camera_id"] == camera_id), None)
    if camera is None:
        raise ValueError(f"camera {camera_id} is not in {fixture_path}")
    regions = [BinRegion(r["bin_id"], r["x"], r["y"], r["w"], r["h"]) for r in camera["bin_regions"]]
    return Site(camera_id, regions, {i["catalog_item_id"] for i in data["catalog"]})


def _get_json(url: str, timeout: float):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return json.loads(resp.read())


def load_catalog(api_base: str | None, fixture_path: Path = CONTRACTS / "fixtures/demo-site.json") -> dict[str, str | None]:
    """catalog_item_id -> business_id, from core's GET /api/catalog (source of truth, contract §6), else the fixture."""
    if api_base:
        try:
            items = _get_json(api_base.rstrip("/") + "/api/catalog", 3.0)
            return {i["catalog_item_id"]: i.get("business_id") for i in items}
        except Exception as e:  # noqa: BLE001
            print(f"note: GET /api/catalog failed ({type(e).__name__}); using the fixture catalog", file=sys.stderr)
    else:
        print("note: no API_BASE_URL; using the fixture catalog", file=sys.stderr)
    return {i["catalog_item_id"]: i["business_id"] for i in json.loads(Path(fixture_path).read_text())["catalog"]}


def load_catalog_ids(api_base: str | None, fixture_path: Path = CONTRACTS / "fixtures/demo-site.json") -> set[str]:
    return set(load_catalog(api_base, fixture_path))


def load_profile(profile: str, fixture_path: Path = CONTRACTS / "fixtures/demo-site.json") -> dict:
    """The config profile ("normal" | "demo") core also loads, for thresholds the worker needs."""
    return json.loads(Path(fixture_path).read_text())["config_profiles"][profile]
