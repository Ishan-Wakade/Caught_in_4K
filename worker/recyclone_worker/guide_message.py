"""What the bin's speaker says (voice guide, docs/superpowers/specs/2026-10-17-voice-guidance-roadmap-design.md).

Forced JSON (team, 17 Oct evening): {"bin": "compost" | "trash" | "recycle" | "none", "item": "...", "place": "...",
"reason": "..."}, validated before speaking and spoken as "<Bin word>. <Item> should be placed in <place> because
<reason>." ("Recycling. Aluminum can should be placed in recycling because metal cans are recyclable in Cambridge.").
"none" is only for dangerous items (batteries, electronics, chemicals: never in any of the bins); its place says where
they go instead. Catalog items take bin and reason from the standardized table (rules/cambridge-ma-2022.bins.json);
new items from the LLM (item + a reason per destination) and Jev's choice; anything below 50% confidence is trash.
"""

import json
import re
from functools import cache
from pathlib import Path

from jsonschema import Draft202012Validator

WORKER_RULES = Path(__file__).resolve().parents[1] / "rules"
DEFAULT_TRASH_BELOW = 0.5   # team: trash is the default only when very uncertain
MAX_ITEM_WORDS = 6
MAX_REASON_WORDS = 14
BINS = ("compost", "trash", "recycle")
BIN_NOUN = {"compost": "compost", "trash": "trash", "recycle": "recycling"}
BIN_WORD = {"compost": "Compost", "trash": "Trash", "recycle": "Recycling", "none": "None"}  # the first spoken word
JEV_TO_BIN = {"compost": "compost", "trash": "trash", "recycling": "recycle"}
BIN_TO_JEV = {v: k for k, v in JEV_TO_BIN.items()}
HAZARD_DROPOFF = [  # from the local rules text: where dangerous items go instead (Cambridge guide, "SPECIAL")
    (("battery", "batteries", "electronic", "electronics", "phone", "charger", "cable", "bulb", "lamp", "vape"), "the Recycle Center"),
    (("paint", "chemical", "chemicals", "propane", "medication", "medicine", "pesticide", "oil", "solvent", "aerosol"),
     "a hazardous waste drop-off"),
]
_HAZARD_RE = [(re.compile(r"\b(" + "|".join(words) + r")\b"), place) for words, place in HAZARD_DROPOFF]
_TEXT = {"type": "string", "minLength": 1, "maxLength": 120}
MESSAGE_SCHEMA = {
    "type": "object",
    "properties": {"bin": {"enum": [*BINS, "none"]}, "item": _TEXT, "place": _TEXT, "reason": _TEXT},
    "required": ["bin", "item", "place", "reason"],
    "additionalProperties": False,
}
NOT_SURE = "we are not sure what it is"
NOT_SURE_WHERE = "we are not sure where it belongs"
DANGEROUS = "it is dangerous in any of these bins"


@cache
def _validator() -> Draft202012Validator:
    return Draft202012Validator(MESSAGE_SCHEMA)


def validate_message(m: dict) -> None:
    errors = list(_validator().iter_errors(m))
    if errors:
        raise ValueError("; ".join(e.message for e in errors))
    if len(m["item"].split()) > MAX_ITEM_WORDS or len(m["reason"].split()) > MAX_REASON_WORDS:
        raise ValueError("item or reason too long")
    if m["bin"] != "none" and m["place"] != BIN_NOUN[m["bin"]]:
        raise ValueError("place must be the bin's noun")


def _clean(text: str, max_words: int) -> str:
    return " ".join(text.strip().rstrip(".").split()[:max_words])


def make_message(bin: str, item: str, reason: str) -> dict:
    """A compost / trash / recycle message (item and reason cut short). "none" only via from_suggestion."""
    if bin not in BINS:
        raise ValueError(f"bin must be one of {BINS}, got {bin!r}")
    reason = _clean(reason, MAX_REASON_WORDS)
    reason = reason[0].lower() + reason[1:] if reason[:1].isupper() and not reason[:2].isupper() else reason
    m = {"bin": bin, "item": _clean(item, MAX_ITEM_WORDS) or "this item", "place": BIN_NOUN[bin], "reason": reason or NOT_SURE}
    validate_message(m)
    return m


def spoken(m: dict) -> str:
    validate_message(m)
    item = m["item"][0].upper() + m["item"][1:]
    return f"{BIN_WORD[m['bin']]}. {item} should be placed in {m['place']} because {m['reason']}."


def load_bin_table(path: Path) -> dict[str, dict]:
    return json.loads(Path(path).read_text())["items"]


def from_catalog(item_id: str, table: dict[str, dict]) -> dict:
    row = table[item_id]
    return make_message(row["bin"], row["name"], row.get("reason") or NOT_SURE_WHERE)


def default_trash(what: str | None) -> dict:
    """Very uncertain: trash. With a name, "we are not sure where it belongs"; without one, "...what it is"."""
    return make_message("trash", what or "this item", NOT_SURE_WHERE if what else NOT_SURE)


def _hazard_place(name: str, form: str) -> str | None:
    """Where a dangerous item goes, if its name or form names one (whole words: "foil" is not "oil")."""
    text = f"{name} {form}".lower()
    for rx, place in _HAZARD_RE:
        if rx.search(text):
            return place
    return None


def from_suggestion(pt: dict, reasons: dict | None = None) -> dict:
    """Message for a new item type from its proposed_type (generic.for_event fields, Jev's suggestion); `reasons` is
    the LLM's short reason per destination ("recycling", "compost", "trash"), so the reason matches Jev's choice."""
    name = (pt.get("name") or "").strip() or "this item"
    dest, conf = pt.get("suggested_destination"), pt.get("suggestion_confidence")
    place = _hazard_place(name, pt.get("form") or "")
    if pt.get("hazardous") or place:  # dangerous: never into any of these bins, whatever was suggested
        m = {"bin": "none", "item": _clean(name, MAX_ITEM_WORDS), "place": place or "a hazardous waste drop-off",
             "reason": DANGEROUS}
        validate_message(m)
        return m
    if conf is None or conf < DEFAULT_TRASH_BELOW or (dest not in JEV_TO_BIN and dest != "special"):
        return default_trash(name)  # very uncertain
    if dest == "special":  # not curbside but not dangerous (a face mask, a plastic bag): trash, with the trash reason
        return make_message("trash", name, (reasons or {}).get("trash") or NOT_SURE_WHERE)
    return make_message(JEV_TO_BIN[dest], name, (reasons or {}).get(dest) or NOT_SURE_WHERE)


BIN_LABEL = {"recycle": "Recycle", "compost": "Compost", "trash": "Trash"}


def item_and_bin(message: dict) -> tuple[str, str]:
    """For the screen: ("aluminum can", "Recycle"); a dangerous item gives ("AA battery", "No bin: Recycle Center")."""
    if message.get("bin") == "none":
        place = message.get("place", "special drop-off")
        return message.get("item", ""), f"No bin: {place[4:] if place.lower().startswith('the ') else place}"
    return message.get("item", ""), BIN_LABEL.get(message.get("bin"), "Trash")
