import json
from pathlib import Path

import pytest

CONTRACTS = Path(__file__).resolve().parents[2] / "contracts"


@pytest.fixture
def contracts_dir() -> Path:
    return CONTRACTS


@pytest.fixture
def unknown_item() -> dict:
    return {"catalog_item_id": None, "label": None, "confidence": None, "candidates": []}


def load_json(path: Path):
    return json.loads(path.read_text())
