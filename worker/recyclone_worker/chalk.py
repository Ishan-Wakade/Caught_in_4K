"""Opt-in Chalk Model Gateway for the prerecorded guide. No provider keys or payloads in traces."""

import hashlib
import json
import os
import threading
import time
import urllib.request
from pathlib import Path

BASE_URL = "https://api.chalk.ai/v1/router"
KEY_FILE = Path.home() / ".config/recyclone/chalk.env"


def http_post(url, headers, body, timeout):
    with urllib.request.urlopen(urllib.request.Request(url, data=body, headers=headers, method="POST"), timeout=timeout) as r:
        return json.loads(r.read())


class ChalkGateway:
    def __init__(self, key, environment, models, base_url=BASE_URL, post=None):
        if not key or not environment:
            raise ValueError("Chalk needs CHALK_ROUTER_API_KEY and CHALK_ENVIRONMENT_ID (see docs/chalk.md)")
        if base_url != BASE_URL:  # no accidental forwarding of the gateway credential to an arbitrary host
            raise ValueError(f"Chalk gateway URL must be {BASE_URL}")
        self.key, self.environment, self.models = key, environment, dict(models)
        self.base_url, self._post = base_url, post or http_post
        self.calls = []
        self._lock = threading.Lock()
        self.namespace = hashlib.sha256(json.dumps([base_url, environment, self.models], sort_keys=True).encode()).hexdigest()[:16]

    @classmethod
    def from_env(cls, namer, key_file=KEY_FILE):
        values = {}
        if Path(key_file).exists():
            for line in Path(key_file).read_text().splitlines():
                if line.strip() and not line.lstrip().startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    values[k.strip()] = v.strip().strip("\"'")
        values.update(os.environ)
        models = {role: values.get(f"CHALK_{role.upper()}_MODEL", "").strip() for role in (namer, "jev")}
        missing = [f"CHALK_{role.upper()}_MODEL" for role, model in models.items() if not model]
        if missing:
            raise ValueError("Chalk needs configured model IDs: " + ", ".join(missing) + " (see docs/chalk.md)")
        return cls(values.get("CHALK_ROUTER_API_KEY"), values.get("CHALK_ENVIRONMENT_ID"), models)

    def post(self, url, headers, body, timeout):
        # Native protocol shapes are preserved; only transport, auth and model ID change.
        role, path = {
            "https://api.anthropic.com/v1/messages": ("claude", "/v1/messages"),
            "https://api.deepseek.com/chat/completions": ("deepseek", "/chat/completions"),
            # The Decisions endpoint accepts the same typed state/questions shape. Verified against the
            # managed gateway; /v1/systemone currently returns a provider configuration error there.
            "https://api.typesafe.ai/v1/systemone": ("jev", "/alpha/decisions"),
        }[url]
        model = self.models[role]
        payload = dict(json.loads(body), model=model)
        outgoing = {"Authorization": f"Bearer {self.key}", "X-Chalk-Env-Id": self.environment,
                    "Content-Type": "application/json"}
        if role == "claude":
            outgoing["anthropic-version"] = "2023-06-01"
        started = time.monotonic()
        event = {"role": role, "model": model, "endpoint": path, "status": "error"}
        try:
            response = self._post(self.base_url + path, outgoing, json.dumps(payload).encode(), timeout)
            event["status"] = "ok"
            usage = response.get("usage") or {}
            event["usage"] = {k: v for k, v in usage.items() if k.endswith("tokens") and isinstance(v, (int, float))}
            if isinstance(response.get("model"), str):
                event["served_model"] = response["model"]
            return response
        except Exception as exc:
            event["error_type"] = type(exc).__name__  # never exception text: it can contain response data
            raise
        finally:
            event["latency_ms"] = round((time.monotonic() - started) * 1000, 1)
            with self._lock:
                self.calls.append(event)

    def jev(self, state):
        from .generic import DESTINATIONS, QUESTION

        body = {"state": state, "questions": {"answer": {"type": "choice", "instructions": QUESTION,
                                                                        "criteria": DESTINATIONS}}}
        return self.post("https://api.typesafe.ai/v1/systemone", {}, json.dumps(body).encode(), 60)

    def report(self):
        with self._lock:
            calls = [dict(c) for c in self.calls]
        return {"enabled": True, "environment": self.environment, "models": self.models,
                "requests": len(calls), "successful_requests": sum(c["status"] == "ok" for c in calls),
                "calls": calls}
