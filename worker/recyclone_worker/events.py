"""Build, validate, and serialize DisposalEvents exactly as contracts/README.md §1 defines them."""

import hashlib
import json
from datetime import datetime, timedelta, timezone
from functools import cache

from jsonschema import Draft202012Validator

from .site import CONTRACTS


def make_event_id(camera_id: str, clip_id: str, track_id: int, bin_id: str) -> str:
    """Deterministic ID so reprocessing a clip never duplicates events.

    Trackers often return float IDs; str(17.0) hashes differently from the TypeScript side's 17,
    so anything but a real int is refused instead of silently coerced.
    """
    if isinstance(track_id, bool) or not isinstance(track_id, int):
        raise TypeError(f"track_id must be int, got {type(track_id).__name__}; convert with int() first")
    key = f"{camera_id}|{clip_id}|{track_id}|{bin_id}"
    return "evt_" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _iso_ms(t: datetime) -> str:
    return t.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_event(
    *,
    camera_id: str,
    clip_id: str,
    track_id: int,
    bin_id: str,
    started_at: datetime,
    offset_s: float,
    destination_confidence: float,
    item: dict,
    evidence: list[dict],
) -> dict:
    return {
        "event_id": make_event_id(camera_id, clip_id, track_id, bin_id),
        "source": {"camera_id": camera_id, "clip_id": clip_id, "track_id": track_id, "mode": "recorded"},
        "bin_id": bin_id,
        "occurred_at": _iso_ms(started_at + timedelta(seconds=offset_s)),
        "clip_offset_s": round(offset_s, 3),
        "destination_confidence": destination_confidence,
        "item": item,
        # No logo reading yet: the worker sends no business guess rather than inventing one (contract §6).
        "business": {"business_id": None, "confidence": None, "basis": []},
        "evidence": evidence,
    }


@cache
def _validator() -> Draft202012Validator:
    return Draft202012Validator(json.loads((CONTRACTS / "disposal-event.schema.json").read_text()))


def validate_event(event: dict) -> None:
    errors = sorted(_validator().iter_errors(event), key=lambda e: list(e.path))
    if errors:
        raise ValueError("; ".join(f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in errors))


def dumps_event(event: dict) -> str:
    """NaN/Infinity are not JSON; core would reject the whole request, so fail here instead."""
    return json.dumps(event, allow_nan=False)
