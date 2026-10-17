"""Name a dropped item with a vision LLM (DeepSeek, OpenAI-compatible chat API) from a few crops of it.

Runs once per drop, after the item tracker has decided the drop (`run --tracker items` analyzes the clip first),
so its ~2 s latency never touches playback. Only crops of the item are sent, never whole frames (people are in
them). Answers are cached by image hash so replays are identical and free. Without a key, or on any error, the
caller keeps the CLIP answer.

The model picks a catalog id or says none fits; the bin rule still comes from the catalog (core's local rules),
never from the model. Its "confidence" is the model's own estimate, not a calibrated probability.
"""

import base64
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

import cv2
import numpy as np

from .site import CONTRACTS

API_URL = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"  # vision on the main Flash model (api-docs.deepseek.com/guides/vision, 17 Oct 2026)
KEY_FILE = Path.home() / ".config/recyclone/deepseek.env"  # outside the repo; DEEPSEEK_API_KEY=...
THINKING = False  # DeepSeek "thinking" (hidden reasoning, on by default): off = faster, cheaper, no cut-off answers
MAX_SIDE = 512  # crops are small anyway; DeepSeek caps an image at 1024 tokens
PROMPT = """These {n} images are crops of ONE object a person is carrying to a waste bin (the same object seen at different moments; a hand may be in the crop).
Choose a catalog item only if the object clearly IS that item; if it is something else, or you cannot tell, answer null and describe it in "what". Do not name a brand unless its logo or text is clearly visible.
Catalog (id: description):
{catalog}
Answer JSON only: {{"catalog_item_id": id or null, "what": "short description of the object", "material": "main material", "brand_visible": "brand or null", "confidence": 0.0-1.0}}"""

# Asked separately (not appended to PROMPT): on 17 Oct, adding these lines to the catalog prompt dropped catalog
# naming on the dev drops from 9/10 to 6/10, because the model then answered "none fits" more often.
GENERIC_PROMPT = """These {n} images are crops of ONE object a person is carrying to a waste bin (a hand may be in the crop).
Solid black rectangles are faces blanked out for privacy: they are not objects and not part of any object.
If you cannot clearly see an object being carried (blurry, too small, only a hand or clothing), set identifiable to false.
Describe the object generically, for deciding which waste bin it belongs in:
- identifiable: true only if you can clearly see what the object is
- name: short generic name including its use ("paper takeout box", "paper coffee cup", "plastic water bottle")
- material: one of plastic_film, rigid_plastic, paper, cardboard, metal, glass, organic, textile, foam, mixed, unknown
- form: one word for its shape or use ("cup", "bag", "mask", "wrapper", "box", "napkin", "bottle", "glove", "battery")
- condition: one of clean, food_residue, liquid, unknown (only what you can see)
- hazardous: true only for batteries, electronics, chemicals, needles, or items labeled hazardous
Answer JSON only: {{"identifiable": true, "name": "...", "material": "...", "form": "...", "condition": "...", "hazardous": false}}"""


def api_key() -> str | None:
    key = os.environ.get("DEEPSEEK_API_KEY")
    if key:
        return key
    if KEY_FILE.exists():
        for line in KEY_FILE.read_text().splitlines():
            if line.startswith("DEEPSEEK_API_KEY="):
                return line.split("=", 1)[1].strip() or None
    return None


def load_catalog(fixture: Path = CONTRACTS / "fixtures/demo-site.json") -> list[tuple[str, str]]:
    return [(i["catalog_item_id"], i.get("name") or i.get("label") or i["catalog_item_id"]) for i in json.loads(fixture.read_text())["catalog"]]


def _jpeg(crop: np.ndarray) -> bytes:
    h, w = crop.shape[:2]
    s = MAX_SIDE / max(h, w)
    if s < 1:
        crop = cv2.resize(crop, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 88])
    return buf.tobytes()


class DeepSeekNamer:
    def __init__(self, cache_dir: Path, key: str | None = None, catalog: list[tuple[str, str]] | None = None, timeout: float = 30.0,
                 use_key_file: bool = True):
        """key: explicit key; otherwise DEEPSEEK_API_KEY / the key file, unless use_key_file=False (tests)."""
        self.key = key or (api_key() if use_key_file else None)
        self.cache_dir, self.timeout = Path(cache_dir), timeout
        self.catalog = catalog or load_catalog()
        self.ids = {cid for cid, _ in self.catalog}
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.usage = {"calls": 0, "cached": 0, "prompt_tokens": 0, "completion_tokens": 0, "errors": 0}

    @property
    def available(self) -> bool:
        return bool(self.key)

    def name(self, crops: list[np.ndarray]) -> dict | None:
        """{"catalog_item_id", "what", "material", "brand_visible", "confidence"} or None (no key, error, bad answer)."""
        return self._ask(crops, PROMPT)

    def _ask(self, crops: list[np.ndarray], template: str, raw: bool = False) -> dict | None:
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
        if not self.key:
            return None
        content = [{"type": "text", "text": prompt}] + [
            {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(b).decode()}} for b in images]
        answer = None
        for attempt, max_tokens in enumerate((800, 1600)):  # a cut-off answer (hidden reasoning used the room) gets one retry
            body = {"model": MODEL, "temperature": 0, "max_tokens": max_tokens, "response_format": {"type": "json_object"},
                    "messages": [{"role": "user", "content": content}]}
            if not THINKING:  # api-docs.deepseek.com/guides/thinking_mode
                body["thinking"] = {"type": "disabled"}
            req = urllib.request.Request(API_URL, data=json.dumps(body).encode(),
                                         headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"})
            try:
                r = json.loads(urllib.request.urlopen(req, timeout=self.timeout).read())
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

    def describe(self, crops: list[np.ndarray]) -> dict | None:
        """The generic description (GENERIC_PROMPT) of the same crops, or None. Its own call and cache entry."""
        return self._ask(crops, GENERIC_PROMPT, raw=True)

    def _clean(self, a: dict) -> dict | None:
        if not isinstance(a, dict):
            return None
        cid = a.get("catalog_item_id")
        if cid not in self.ids:  # null, or an id the catalog does not have: unknown, never a guess
            cid = None
        try:
            conf = min(max(float(a.get("confidence")), 0.0), 1.0)
        except (TypeError, ValueError):
            conf = None
        return {"catalog_item_id": cid, "what": a.get("what"), "material": a.get("material"),
                "brand_visible": a.get("brand_visible"), "confidence": conf}


def item_from_answer(answer: dict, clip_item: dict) -> dict:
    """The contract `item` from the LLM answer; CLIP's candidates stay as evidence behind it."""
    cid, conf = answer["catalog_item_id"], answer["confidence"]
    lead = [{"catalog_item_id": cid, "score": round(conf if conf is not None else 0.0, 4)}] if cid else []
    rest = [c for c in clip_item.get("candidates", []) if c["catalog_item_id"] != cid]
    item = {"catalog_item_id": cid, "label": answer.get("what"), "confidence": round(conf, 4) if (cid and conf is not None) else None,
            "candidates": lead + rest}
    if cid is None and answer.get("proposed_type"):  # not in the catalog: a generic type proposal (contract §1.1)
        item["proposed_type"] = answer["proposed_type"]
    return item


def pick_views(tracks: list[dict], per_frame: list, data: dict, bins: dict, item_id: int, until: int, k: int = 3,
               min_gap_s: float = 0.5) -> list[tuple[int, list]]:
    """Up to k (frame, box) views of the item while a hand held it, outside every bin, before the drop: the largest
    views, at least min_gap_s apart, so the crops show the object at different moments and angles."""
    from .items import in_box, center, item_boxes

    boxes = item_boxes(tracks, per_frame, data["_identity"], data.get("_brought"))
    held = {f for f in range(min(until, len(per_frame))) for _, tid, _ in data["_links"][f] if data["_identity"].get(tid) == item_id}
    views = []
    for f in sorted(held):
        if item_id in boxes[f]:
            b = boxes[f][item_id][1]
            if not any(bx[f] is not None and in_box(center(b), bx[f]) for bx in bins.values()):
                views.append((f, b))
    if not views:
        return []
    area = lambda b: (b[2] - b[0]) * (b[3] - b[1])  # noqa: E731
    gap = max(1, round(float(data["fps"]) * min_gap_s))
    picked = []  # largest views first, each at least min_gap_s from the ones already picked: different angles
    for f, b in sorted(views, key=lambda v: -area(v[1])):
        if all(abs(f - g) >= gap for g, _ in picked):
            picked.append((f, b))
        if len(picked) == k:
            break
    return sorted(picked)


def read_crops(video: Path, views: list[tuple[int, list]], pad: float = 0.5) -> list[np.ndarray]:
    """Item crops with half a box of context on each side: a tight crop of a white bag is just a fist and white paper."""
    cap = cv2.VideoCapture(str(video))
    out = []
    for f, b in views:
        cap.set(cv2.CAP_PROP_POS_FRAMES, f)
        ok, img = cap.read()
        if not ok:
            continue
        h, w = img.shape[:2]
        dx, dy = (b[2] - b[0]) * pad, (b[3] - b[1]) * pad
        x0, y0, x1, y1 = int(max(0, b[0] - dx)), int(max(0, b[1] - dy)), int(min(w, b[2] + dx)), int(min(h, b[3] + dy))
        if x1 > x0 and y1 > y0:
            out.append(img[y0:y1, x0:x1].copy())
    cap.release()
    return out
