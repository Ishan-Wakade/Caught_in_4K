"""Identify a carried item with Claude (Haiku 5.5, vision) from a few face-redacted crops: ONE call per item returns
the catalog pick, the generic description and a short reason for each possible destination, forced into a fixed JSON
shape (output_config json_schema). Same interface as namer.DeepSeekNamer (name() / describe()); both read the same answer.

Cost (platform.claude.com/docs/en/about-claude/pricing, 17 Oct 2026): Haiku 5.5 $0.10 / MTok in, $0.50 / MTok out;
one item is ~2k tokens in (three crops of <= 512 px + the fixed catalog and rules) and ~200 out: about $0.0003.
Answers are cached on disk by image hash, so re-rendering a clip is free. Only item crops are sent, never frames.
"""

import base64
import hashlib
import json
import os
import sys
import threading
import urllib.request
from pathlib import Path

from .namer import _jpeg, load_catalog

API_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-haiku-5-5"
PRICES = {  # USD per million tokens (input, output, cache read); platform.claude.com pricing, 17 Oct 2026
    "claude-haiku-5-5": (0.10, 0.50, 0.01),
    "claude-sonnet-5-5": (2.0, 10.0, 0.10),
}
KEY_FILE = Path.home() / ".config/recyclone/anthropic.env"  # outside the repo; ANTHROPIC_API_KEY=...
MAX_TOKENS = 500
THINKING_OFF = {"claude-haiku-5-5": {"type": "disabled"}, "claude-sonnet-5-5": {"type": "between_tools"}}  # each model's own
BRANDS = ("beanco", "tacostop", "greenbowl", "shakeshack", "goldfish", "biscoff")
DESTINATIONS = ("recycling", "compost", "trash")

SYSTEM = """You identify ONE object a person is carrying to a set of waste bins, from a few small crops of it (the same object at different moments; a hand may be in the crop).
Solid black rectangles are faces blanked out for privacy: they are not objects and not part of any object.
Set identifiable to false ONLY if no object is visible at all (just a hand, a sleeve or clothing). If you can see an object but are unsure of its exact type, keep identifiable true and give your best generic name ("printed paper", "plastic bag") with a lower confidence.
Pick a catalog item only if the object clearly IS that item; otherwise catalog_item_id is null. Never name a brand unless its logo or text is clearly visible.
name: short generic name of the object, at most 4 words ("paper coffee cup", "plastic water bottle"). If you are not sure of the exact kind, use a more general name ("food item", "paper item", "plastic wrapper") instead of guessing a specific one; never invent an object that is not clearly in the crops.
reasons: for EACH destination, one short clause (at most 12 words, lowercase, no period) that finishes the sentence "<name> should be placed in <destination> because <reason>" as an argument FOR that destination under the local rules below. For trash, give why it is not accepted in recycling or compost (e.g. "plastic bags are not accepted in recycling carts"). Never argue against the destination in its own reason.

Catalog (id: description):
{catalog}

Local rules (Cambridge, MA):
{rules}"""

SCHEMA = {  # output_config json_schema: no min/max constraints; every object closed (structured-outputs docs, 17 Oct)
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "catalog_item_id": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "confidence": {"type": "number", "description": "0 to 1"},
        "identifiable": {"type": "boolean"},
        "name": {"type": "string"},
        "material": {"type": "string", "enum": ["plastic_film", "rigid_plastic", "paper", "cardboard", "metal", "glass",
                                                 "organic", "textile", "foam", "mixed", "unknown"]},
        "form": {"type": "string"},
        "condition": {"type": "string", "enum": ["clean", "food_residue", "liquid", "unknown"]},
        "hazardous": {"type": "boolean"},
        "reasons": {"type": "object", "additionalProperties": False, "properties": {d: {"type": "string"} for d in DESTINATIONS},
                    "required": list(DESTINATIONS)},
    },
    "required": ["catalog_item_id", "confidence", "identifiable", "name", "material", "form", "condition", "hazardous",
                 "reasons"],
}


def generic_catalog(catalog: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """The catalog without brand products (same bins as their generic kinds): a model cannot pick a brand it cannot see."""
    return [(cid, name) for cid, name in catalog if not any(b in cid for b in BRANDS)]


def api_key(key_file: Path = KEY_FILE) -> str | None:
    key = os.environ.get("ANTHROPIC_API_KEY")
    if key:
        return key
    try:
        for line in Path(key_file).read_text().splitlines():
            if line.startswith("ANTHROPIC_API_KEY="):
                return line.split("=", 1)[1].strip() or None
    except OSError:
        pass
    return None


def _http_post(url: str, headers: dict, body: bytes, timeout: float) -> dict:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


class ClaudeNamer:
    def __init__(self, cache_dir: Path, key: str | None = None, catalog: list[tuple[str, str]] | None = None,
                 rules: str | None = None, rules_path: Path | None = None, timeout: float = 30.0, post=None,
                 model: str = MODEL):
        self.key = key if key is not None else api_key()
        self.model = model
        self.cache_dir, self.timeout, self.post = Path(cache_dir), timeout, post or _http_post
        self.catalog = catalog or load_catalog()
        self.ids = {cid for cid, _ in self.catalog}
        self.rules = rules if rules is not None else (Path(rules_path).read_text() if rules_path else "")
        self.system = SYSTEM.format(catalog="\n".join(f"{cid}: {name}" for cid, name in self.catalog), rules=self.rules)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.usage = {"calls": 0, "cached": 0, "input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "errors": 0}
        self._lock = threading.Lock()
        self._inflight: dict[str, threading.Event] = {}
        self._answers: dict[str, dict | None] = {}

    @property
    def available(self) -> bool:
        return bool(self.key)

    def cost_usd(self) -> float:
        u, (p_in, p_out, p_cache) = self.usage, PRICES.get(self.model, PRICES["claude-sonnet-5-5"])
        return (u["input_tokens"] * p_in + u["output_tokens"] * p_out + u["cache_read_tokens"] * p_cache) / 1e6

    def name(self, crops) -> dict | None:
        """DeepSeekNamer.name's shape: {"catalog_item_id", "what", "material", "brand_visible", "confidence"}."""
        a = self._answer(crops)
        if a is None:
            return None
        cid = a.get("catalog_item_id") if a.get("catalog_item_id") in self.ids else None
        try:
            conf = min(max(float(a.get("confidence")), 0.0), 1.0)
        except (TypeError, ValueError):
            conf = None
        return {"catalog_item_id": cid, "what": a.get("name"), "material": a.get("material"), "brand_visible": None,
                "confidence": conf}

    def describe(self, crops) -> dict | None:
        """The generic description plus "reasons" per destination (for generic.generic_type and the spoken reason)."""
        a = self._answer(crops)
        if a is None:
            return None
        keys = ("identifiable", "name", "material", "form", "condition", "hazardous", "reasons")
        return {k: a.get(k) for k in keys}

    def _answer(self, crops) -> dict | None:
        """One request per set of crops, shared by name() and describe() even when they ask at the same moment."""
        if not crops:
            return None
        images = [_jpeg(c) for c in crops]
        key = hashlib.sha256(json.dumps([self.model, self.system, SCHEMA]).encode() + b"".join(images)).hexdigest()[:24]
        cached = self.cache_dir / f"claude-{key}.json"
        with self._lock:
            if key in self._answers:
                return self._answers[key]
            if cached.exists():
                self.usage["cached"] += 1
                self._answers[key] = json.loads(cached.read_text())
                return self._answers[key]
            event = self._inflight.get(key)
            owner = event is None
            if owner:
                event = self._inflight[key] = threading.Event()
        if not owner:
            event.wait(self.timeout + 5)
            return self._answers.get(key)
        answer = self._request(images)
        with self._lock:
            self._answers[key] = answer
            self._inflight.pop(key, None)
        event.set()
        if answer is not None:
            cached.write_text(json.dumps(answer))
        return answer

    def _request(self, images: list[bytes]) -> dict | None:
        if not self.key:
            return None
        content = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                "data": base64.b64encode(b).decode()}} for b in images]
        content.append({"type": "text", "text": f"{len(images)} crop(s) of the carried object."})
        body = {"model": self.model, "max_tokens": MAX_TOKENS,  # no temperature: Haiku 5.5 rejects it (HTTP 400)
                "system": [{"type": "text", "text": self.system, "cache_control": {"type": "ephemeral"}}],
                "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}},  # Sonnet 5.5: no forced tool
                "messages": [{"role": "user", "content": content}]}
        if self.model in THINKING_OFF:  # Haiku 5.5 otherwise spent its whole token budget thinking (no answer)
            body["thinking"] = THINKING_OFF[self.model]
        headers = {"x-api-key": self.key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
        try:
            r = self.post(API_URL, headers, json.dumps(body).encode(), self.timeout)
            u = r.get("usage", {})
            self.usage["calls"] += 1
            self.usage["input_tokens"] += u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0)
            self.usage["output_tokens"] += u.get("output_tokens", 0)
            self.usage["cache_read_tokens"] += u.get("cache_read_input_tokens", 0)
            text = next(b for b in r["content"] if b.get("type") == "text")["text"]
            answer = json.loads(text)
            return answer if isinstance(answer, dict) else None
        except Exception as e:  # noqa: BLE001 - never stops the run: the guide falls back to trash
            self.usage["errors"] += 1
            print(f"note: Claude identification failed ({type(e).__name__})", file=sys.stderr)
            return None
