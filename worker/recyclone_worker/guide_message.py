"""What the bin's speaker says (voice guide, docs/superpowers/specs/2026-10-17-voice-guidance-roadmap-design.md).

Forced JSON: {"bin": "compost" | "trash" | "recycle" | "none", "explanation": "..."}, validated before speaking and
spoken as "<Bin>. <explanation>". "none" is only for dangerous items (batteries, electronics, chemicals: never in any
of the bins) and says where they go instead (team, 17 Oct). Catalog items take their bin from the standardized table
(rules/cambridge-ma-2022.bins.json); new items from the LLM + Jev suggestion; anything below 50% confidence is trash.
"""

import json
from functools import cache
from pathlib import Path

from jsonschema import Draft202012Validator

WORKER_RULES = Path(__file__).resolve().parents[1] / "rules"
DEFAULT_TRASH_BELOW = 0.5   # team: trash is the default only when very uncertain
MAX_WORDS = 8
BINS = ("compost", "trash", "recycle")
BIN_NOUN = {"compost": "compost", "trash": "trash", "recycle": "recycling"}
JEV_TO_BIN = {"compost": "compost", "trash": "trash", "recycling": "recycle"}
HAZARD_DROPOFF = [  # from the local rules text: where dangerous items go instead (Cambridge guide, "SPECIAL")
    (("battery", "batteries", "electronic", "phone", "charger", "cable", "bulb", "lamp"), "the Recycle Center"),
    (("paint", "chemical", "propane", "medication", "medicine", "pesticide", "oil", "solvent"), "a hazardous waste drop-off"),
]
MESSAGE_SCHEMA = {
    "type": "object",
    "properties": {"bin": {"enum": [*BINS, "none"]}, "explanation": {"type": "string", "minLength": 1, "maxLength": 200}},
    "required": ["bin", "explanation"],
    "additionalProperties": False,
}


@cache
def _validator() -> Draft202012Validator:
    return Draft202012Validator(MESSAGE_SCHEMA)


def validate_message(m: dict) -> None:
    errors = list(_validator().iter_errors(m))
    if errors:
        raise ValueError("; ".join(e.message for e in errors))
    if m["bin"] != "none" and len(m["explanation"].split()) > MAX_WORDS:
        raise ValueError(f"explanation longer than {MAX_WORDS} words")


def make_message(bin: str, what: str) -> dict:
    """A compost / trash / recycle message; the explanation is cut to 8 words. "none" only via from_suggestion."""
    if bin not in BINS:
        raise ValueError(f"bin must be one of {BINS}, got {bin!r}")
    m = {"bin": bin, "explanation": " ".join(what.split()[:MAX_WORDS])}
    validate_message(m)
    return m


def spoken(m: dict) -> str:
    validate_message(m)
    return f"{m['bin'].capitalize()}. {m['explanation']}"


def _placed(bin: str, what: str) -> dict:
    noun = BIN_NOUN[bin]
    words = what.split()[: MAX_WORDS - 3]  # ", placed in <noun>" takes 3 words
    return make_message(bin, f"{' '.join(words)}, placed in {noun}")


def load_bin_table(path: Path) -> dict[str, dict]:
    return json.loads(Path(path).read_text())["items"]


def from_catalog(item_id: str, table: dict[str, dict]) -> dict:
    row = table[item_id]
    return _placed(row["bin"], row["name"])


def default_trash(what: str | None) -> dict:
    return _placed("trash", what or "not sure what this is")


def _dropoff(name: str, form: str) -> str:
    text = f"{name} {form}".lower()
    for words, place in HAZARD_DROPOFF:
        if any(w in text for w in words):
            return place
    return "a hazardous waste drop-off"


def from_suggestion(pt: dict) -> dict:
    """Message for a new item type from its proposed_type (generic.for_event fields, Jev's suggestion)."""
    name = (pt.get("name") or "item").strip()
    dest, conf = pt.get("suggested_destination"), pt.get("suggestion_confidence")
    if pt.get("hazardous") and dest in ("special", "trash", None):  # dangerous: never into any of the bins
        m = {"bin": "none", "explanation": f"{name} is dangerous to place in any of these bins. Place it in "
                                           f"{_dropoff(name, pt.get('form') or '')} instead"}
        validate_message(m)
        return m
    if conf is None or conf < DEFAULT_TRASH_BELOW or dest not in JEV_TO_BIN:
        return default_trash(name)  # very uncertain, or a non-dangerous "special" item (e.g. a face mask)
    return _placed(JEV_TO_BIN[dest], name)
