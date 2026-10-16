"""Cross-language contract check: the Python worker must agree with the TypeScript side.

Validates fixtures/synthetic-events.jsonl against disposal-event.schema.json and recomputes
every event ID in fixtures/event-id-vectors.json. Run: pnpm --filter @recyclone/contracts check:python
"""
import hashlib
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent.parent


def make_event_id(camera_id: str, clip_id: str, track_id: int, bin_id: str) -> str:
    """Reference implementation for the worker. Trackers often return float IDs (17.0);
    str(17.0) hashes differently from TypeScript's 17, so floats are refused, not coerced."""
    if isinstance(track_id, bool) or not isinstance(track_id, int):
        raise TypeError(f"track_id must be int, got {type(track_id).__name__}; convert with int() first")
    key = f"{camera_id}|{clip_id}|{track_id}|{bin_id}"
    return "evt_" + hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def main() -> int:
    problems: list[str] = []
    schema = json.loads((ROOT / "disposal-event.schema.json").read_text())
    validator = Draft202012Validator(schema)

    lines = (ROOT / "fixtures/synthetic-events.jsonl").read_text().splitlines()
    for n, line in enumerate((l for l in lines if l.strip()), start=1):
        for error in validator.iter_errors(json.loads(line)):
            problems.append(f"synthetic-events.jsonl line {n}: {error.message}")

    for case in json.loads((ROOT / "fixtures/parity-cases.json").read_text()):
        if validator.is_valid(case["event"]) != case["valid"]:
            problems.append(f"parity case '{case['name']}': JSON Schema says valid={not case['valid']}, expected {case['valid']}")

    try:
        make_event_id("cam", "clip", 17.0, "bin")  # type: ignore[arg-type]
        problems.append("make_event_id accepted a float track_id")
    except TypeError:
        pass

    for row in json.loads((ROOT / "fixtures/event-id-vectors.json").read_text()):
        got = make_event_id(row["camera_id"], row["clip_id"], row["track_id"], row["bin_id"])
        if got != row["event_id"]:
            problems.append(f"event id mismatch for {row}: python computed {got}")

    for p in problems:
        print(p, file=sys.stderr)
    print("ok" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
