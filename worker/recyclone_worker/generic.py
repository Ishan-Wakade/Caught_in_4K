"""New item types: when the catalog has no entry for a dropped item, describe it as a generic type (from the vision
LLM's answer, namer.py) and SUGGEST its bin under the site's local rules with Jev (TypeSafe's typed-decision model).

The result is `item.proposed_type` (contracts/README.md §1.1): a proposal the area manager approves before it
counts. The worker never decides correctness and applies no threshold: the suggestion is sent with Jev's
probability, and core decides what to do with it.

Jev sees only text: the type's name, material, form, condition and the local rules text, never images. Its key is
read from TYPESAFE_API_KEY or ~/.config/recyclone/jev.env (outside the repo) and passed only to the jev process.
Answers are cached per (type, condition, rules) in state/generic-types.json, so each new type costs one call.
"""

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

MATERIALS = ("plastic_film", "rigid_plastic", "paper", "cardboard", "metal", "glass", "organic", "textile", "foam", "mixed", "unknown")
CONDITIONS = ("clean", "food_residue", "liquid", "unknown")
KEY_FILE = Path.home() / ".config/recyclone/jev.env"
DESTINATIONS = {
    "recycling": "Curbside recycling cart",
    "compost": "Curbside compost (food scraps and the paper items the rules accept)",
    "trash": "Trash (not recyclable, not compostable, not a special item)",
    "special": "Not curbside: drop-off, Recycle Center, textile donation, or hazardous waste event",
}
QUESTION = "Under the local rules given in the state, where should this item be disposed of?"
STATE_VERSION = 2  # bump when what Jev is shown changes, so cached suggestions are asked again (v2: + description)


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")[:30] or "item"


def generic_type(answer: dict) -> dict | None:
    """The proposed generic type from the vision LLM's answers (namer: name() and, under "generic", describe()), or
    None if it gave no description. The id comes from material + form only, so the next mask, whatever its color,
    gets the same id. "description" (the free-text look) goes to Jev but not into the event."""
    g = answer.get("generic") or {}
    if g.get("identifiable") is False:  # the model could not see an object: never invent a name for it
        return None
    name, form = (g.get("name") or answer.get("what") or "").strip(), _slug(g.get("form") or "")
    if not name or form in ("item", "unknown") or name.lower() in ("unknown", "unknown object", "unknown item"):
        return None
    material = g.get("material") if g.get("material") in MATERIALS else "unknown"
    condition = g.get("condition") if g.get("condition") in CONDITIONS else "unknown"
    return {"generic_type_id": f"gen_{material}_{form}", "name": name[:80], "material": material, "form": form,
            "condition": condition, "hazardous": bool(g.get("hazardous")),
            "suggested_destination": None, "suggestion_confidence": None, "rule_source": None,
            "_description": (answer.get("what") or "")[:200]}


CONTRACT_FIELDS = ("generic_type_id", "name", "material", "form", "condition", "hazardous", "suggested_destination",
                   "suggestion_confidence", "rule_source")


def for_event(gt: dict) -> dict:
    """Only the contract's fields (drops the private description)."""
    return {k: gt.get(k) for k in CONTRACT_FIELDS}


def jev_key() -> str | None:
    if os.environ.get("TYPESAFE_API_KEY"):
        return os.environ["TYPESAFE_API_KEY"]
    if KEY_FILE.exists():
        for line in KEY_FILE.read_text().splitlines():
            if line.startswith("TYPESAFE_API_KEY="):
                return line.split("=", 1)[1].strip() or None
    return None


JEV_URL = "https://api.typesafe.ai/v1/systemone"  # the same API the web app's guide calls (apps/web/lib/guide/identify.ts)


def _http_post(url: str, headers: dict, body: bytes, timeout: float) -> dict:
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def run_jev_http(state: str, post=_http_post) -> dict:
    """The same question over Jev's HTTP API, for machines without the jev CLI (the cloud upload job); answer in the
    CLI's shape ({"answers": {"answer": {"choice", "confidence"}}}). Raises on a failed call."""
    body = {"model": "jev-latest", "state": state,
            "questions": {"answer": {"type": "choice", "instructions": QUESTION, "criteria": DESTINATIONS}}}
    r = post(JEV_URL, {"Authorization": f"Bearer {jev_key() or ''}", "Content-Type": "application/json"},
             json.dumps(body).encode(), 60)
    return {"answers": {"answer": r["answers"]["answer"]}}


def run_jev(state: str) -> dict:
    """One `jev choice` call; the parsed JSON answer. Raises RuntimeError on a failed call (never a fake answer).
    Without the jev CLI on PATH, the same question goes to Jev's HTTP API (run_jev_http)."""
    if shutil.which("jev") is None:
        return run_jev_http(state)
    env = dict(os.environ, TYPESAFE_API_KEY=jev_key() or "")
    cmd = ["jev", "choice", "--question", QUESTION, "--state", "-"] + [a for k, v in DESTINATIONS.items() for a in ("-o", f"{k}={v}")]
    r = subprocess.run(cmd, input=state, capture_output=True, text=True, env=env, timeout=60)
    if r.returncode != 0:
        raise RuntimeError(f"jev exit {r.returncode}")  # stderr is not echoed: it is the caller's to inspect
    return json.loads(r.stdout)


class BinAdvisor:
    """Suggests a bin for a generic type under one local-rules text, with Jev; cached per (type, condition, rules)."""

    def __init__(self, rules_file: Path, registry: Path, runner=run_jev):
        self.rules_file, self.registry, self.runner = Path(rules_file), Path(registry), runner
        self.rules = self.rules_file.read_text()
        self.rule_source = self.rules_file.stem
        self.rules_hash = hashlib.sha256(self.rules.encode()).hexdigest()[:12]
        self.known = json.loads(self.registry.read_text()) if self.registry.exists() else {}
        self.usage = {"calls": 0, "cached": 0, "errors": 0}

    @property
    def available(self) -> bool:
        return jev_key() is not None or self.runner is not run_jev

    def suggest(self, gt: dict) -> dict:
        """gt with suggested_destination / suggestion_confidence / rule_source filled (or left null on error)."""
        key = f"v{STATE_VERSION}|{gt['generic_type_id']}|{gt['condition']}|{gt['hazardous']}|{self.rules_hash}"  # one per type
        if key in self.known:
            self.usage["cached"] += 1
            return dict(gt, **self.known[key]["suggestion"])
        item = {k: gt[k] for k in ("name", "material", "form", "condition", "hazardous")}
        item["description"] = gt.get("_description") or gt["name"]
        state = json.dumps({"item": item, "local_rules": self.rules})
        try:
            ans = self.runner(state)["answers"]["answer"]
            dest, conf = ans["choice"], float(ans["confidence"])
            if dest not in DESTINATIONS:
                raise ValueError(dest)
        except Exception as e:  # noqa: BLE001 - no suggestion is better than a made-up one
            self.usage["errors"] += 1
            print(f"note: Jev bin suggestion failed ({type(e).__name__}); proposed type sent without a bin", file=sys.stderr)
            return dict(gt, rule_source=self.rule_source)
        self.usage["calls"] += 1
        suggestion = {"suggested_destination": dest, "suggestion_confidence": round(min(max(conf, 0.0), 1.0), 4),
                      "rule_source": self.rule_source}
        self.known[key] = {"type": {k: gt[k] for k in ("generic_type_id", "name", "material", "form")}, "suggestion": suggestion}
        self.registry.parent.mkdir(parents=True, exist_ok=True)
        self.registry.write_text(json.dumps(self.known, indent=1))
        return dict(gt, **suggestion)
