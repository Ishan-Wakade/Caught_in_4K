"""Provider adapters imported only by the prerecorded workflow. Live providers stay unchanged."""
import base64
import hashlib
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

from .claude_namer import ClaudeNamer as DirectClaudeNamer
from .generic import BinAdvisor as DirectBinAdvisor
from .namer import DeepSeekNamer as DirectDeepSeekNamer, API_URL, MODEL, THINKING, _jpeg


class ClaudeNamer(DirectClaudeNamer):
    def __init__(self, cache_dir, *, gateway=None, **kwargs):
        if gateway:
            cache_dir = Path(cache_dir) / ("chalk-" + gateway.namespace)
            # The base adapter needs a truthy credential. Gateway.post replaces all upstream auth headers.
            kwargs.update(key=gateway.key, post=gateway.post)
        super().__init__(cache_dir, **kwargs)


class DeepSeekNamer(DirectDeepSeekNamer):
    def __init__(self, cache_dir, *, gateway=None, **kwargs):
        self.gateway = gateway
        if gateway:
            cache_dir = Path(cache_dir) / ("chalk-" + gateway.namespace)
            kwargs.update(key=None, use_key_file=False)
        super().__init__(cache_dir, **kwargs)

    @property
    def available(self):
        return bool(self.gateway) or super().available

    def _ask(self, crops: list[np.ndarray], template: str, raw: bool = False) -> dict | None:
        if self.gateway is None:
            return super()._ask(crops, template, raw=raw)
        if not crops:
            return None
        images = [_jpeg(c) for c in crops]
        prompt = template.format(n=len(images), catalog="\n".join(f"{cid}: {name}" for cid, name in self.catalog))
        key = hashlib.sha256(json.dumps([MODEL, prompt] + ([] if THINKING else ["no-think"])).encode() + b"".join(images)).hexdigest()[:24]
        cached = self.cache_dir / f"{key}.json"
        if cached.exists():
            self.usage["cached"] += 1
            a = json.loads(cached.read_text())
            return (a if isinstance(a, dict) else None) if raw else self._clean(a)
        if not self.available:
            return None
        content = [{"type": "text", "text": prompt}] + [
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(b).decode()}} for b in images]
        answer = None
        for attempt, max_tokens in enumerate((800, 1600)):  # a cut-off answer (hidden reasoning used the room) gets one retry
            body = {"model": MODEL, "temperature": 0, "max_tokens": max_tokens, "response_format": {"type": "json_object"},
                    "messages": [{"role": "user", "content": content}]}
            if not THINKING:  # api-docs.deepseek.com/guides/thinking_mode
                body["thinking"] = {"type": "disabled"}
            try:
                r = self.gateway.post(API_URL, {}, json.dumps(body).encode(), self.timeout)
                self.usage["calls"] += 1
                u = r.get("usage", {})
                self.usage["prompt_tokens"] += u.get("prompt_tokens", 0)
                self.usage["completion_tokens"] += u.get("completion_tokens", 0)
                answer = json.loads(r["choices"][0]["message"]["content"])
                break
            except (urllib.error.URLError, TimeoutError, KeyError, ValueError) as e:  # never stops the run: CLIP stays
                if attempt == 1:
                    self.usage["errors"] += 1
                    print(f"note: DeepSeek naming failed ({type(e).__name__}); keeping the CLIP item", file=sys.stderr)
                    return None
        cached.write_text(json.dumps(answer))
        return (answer if isinstance(answer, dict) else None) if raw else self._clean(answer)


class BinAdvisor(DirectBinAdvisor):
    def __init__(self, rules_file, registry, *, gateway=None, **kwargs):
        if gateway:
            registry = Path(registry)
            registry = registry.parent / ("chalk-" + gateway.namespace) / registry.name
            kwargs["runner"] = gateway.jev
        super().__init__(rules_file, registry, **kwargs)
