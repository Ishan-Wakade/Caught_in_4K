"""The bins in a clip, found automatically, and which bin a carried item actually went into (prerecorded demo).

detect_openings: one Claude Sonnet 5.5 call per clip (fixed camera) on the first frame: every bin opening, the label
printed next to it, which bin it is, and a box around it. Cached by frame hash. On 17 Oct it boxed RECYCLING / WASTE /
ORGANICS on the IMG_9117 station exactly (3.2 s, ~$0.006).
thrown_into: from pass 1's sightings of each person's item, the opening it was over at the end of the long carrying
stretch is where it went (the hand reaches into the hole, then the item is gone). Prerecorded only: whole track.
"""

import base64
import hashlib
import json
import sys
from pathlib import Path

import cv2

from .claude_namer import THINKING_OFF, _http_post, api_key

API_URL = "https://api.anthropic.com/v1/messages"
MODEL = "claude-sonnet-5-5"
LONG_SIDE = 1536
BIN_NAME = {"recycle": "Recycling", "trash": "Waste", "compost": "Organics"}
SCHEMA = {
    "type": "object", "additionalProperties": False, "required": ["openings"],
    "properties": {"openings": {"type": "array", "items": {
        "type": "object", "additionalProperties": False, "required": ["label_text", "bin", "x0", "y0", "x1", "y1"],
        "properties": {"label_text": {"type": "string"}, "bin": {"type": "string", "enum": ["recycle", "trash", "compost", "unknown"]},
                       "x0": {"type": "number"}, "y0": {"type": "number"}, "x1": {"type": "number"}, "y1": {"type": "number"}}}}},
}
PROMPT = ("This image is {w}x{h} pixels. Find every opening (hole) of the waste bins. For each: the label printed next to "
          "it (exact text; if there is only an icon, describe it, e.g. \"recycling icon\"), which bin it is "
          "(WASTE/LANDFILL/TRASH or a trash-can figure=trash, RECYCLING or the recycling arrows=recycle, ORGANICS/COMPOST or "
          "an apple/leaf=compost; unknown if neither a label nor an icon is readable), and a tight box around the opening in "
          "pixel coordinates x0,y0,x1,y1 of this image. Only openings that are really in the image.")


def detect_openings(frame, cache_dir: Path, key: str | None = None, post=None, model: str = MODEL) -> list[dict]:
    """[{"bin": "recycle"|"trash"|"compost"|"unknown", "label": "...", "box": (x0, y0, x1, y1) in frame pixels}]."""
    key = api_key() if key is None else key
    h, w = frame.shape[:2]
    s = LONG_SIDE / max(h, w)
    small = cv2.resize(frame, (round(w * s), round(h * s)), interpolation=cv2.INTER_AREA) if s < 1 else frame
    s = small.shape[1] / w
    ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 88])
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cached = cache_dir / f"bins-{hashlib.sha256(model.encode() + PROMPT.encode() + buf.tobytes()).hexdigest()[:24]}.json"
    if cached.exists():
        return [dict(o, box=tuple(o["box"])) for o in json.loads(cached.read_text())]
    if not key:
        return []
    body = {"model": model, "max_tokens": 800, "output_config": {"format": {"type": "json_schema", "schema": SCHEMA}},
            "messages": [{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(buf.tobytes()).decode()}},
                {"type": "text", "text": PROMPT.format(w=small.shape[1], h=small.shape[0])}]}]}
    if model in THINKING_OFF:
        body["thinking"] = THINKING_OFF[model]
    try:
        r = (post or _http_post)(API_URL, {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
                                 json.dumps(body).encode(), 90)
        raw = json.loads(next(b for b in r["content"] if b.get("type") == "text")["text"])["openings"]
    except Exception as e:  # noqa: BLE001 - no bins found: the caller falls back to drawing the area by hand
        print(f"note: bin detection failed ({type(e).__name__})", file=sys.stderr)
        return []
    ops = [{"bin": o["bin"], "label": o["label_text"].strip(),
            "box": tuple(round(v / s) for v in (o["x0"], o["y0"], o["x1"], o["y1"]))} for o in raw if o["x1"] > o["x0"] and o["y1"] > o["y0"]]
    cached.write_text(json.dumps(ops))
    return ops


def fill_from_reference(here: list[dict], reference: list[dict]) -> list[dict]:
    """Openings whose type could not be read take it from the reference (the first frame, labels readable), matched in
    order along the unit (left to right, or far to near when stacked). Same count only: otherwise unchanged."""
    if len(here) != len(reference) or all(o["bin"] != "unknown" and o["label"] for o in here):
        return here

    def ordered(ops):
        xs = [(o["box"][0] + o["box"][2]) / 2 for o in ops]
        ys = [(o["box"][1] + o["box"][3]) / 2 for o in ops]
        axis = 0 if max(xs) - min(xs) >= max(ys) - min(ys) else 1
        return sorted(ops, key=lambda o: (o["box"][axis] + o["box"][axis + 2]) / 2)

    return [dict(h, bin=h["bin"] if h["bin"] != "unknown" else r["bin"], label=h["label"] or r["label"])
            for h, r in zip(ordered(here), ordered(reference))]


def area_from_openings(openings: list[dict], w: int, h: int) -> tuple[int, int, int, int]:
    """The guide's bin area: the openings plus the bin body and the floor right in front of it (where feet stand)."""
    x0 = min(o["box"][0] for o in openings)
    y0 = min(o["box"][1] for o in openings)
    x1 = max(o["box"][2] for o in openings)
    y1 = max(o["box"][3] for o in openings)
    bw, bh = x1 - x0, y1 - y0
    return max(0, int(x0 - 0.6 * bw)), max(0, int(y0 - 0.3 * bh)), min(w, int(x1 + 0.6 * bw)), min(h, int(y1 + 1.5 * bh))


def _drop_point(box) -> tuple[float, float]:
    """Where the item hangs: the bottom middle of the item box. A camera above the bins sees a raised hand higher in the
    image than the opening it is over (IMG_9117: hand centre over RECYCLING, cup into WASTE below it)."""
    return (box[0] + box[2]) / 2, box[3]


def _over(box, opening_box) -> bool:
    """The item's drop point is over the opening (grown by half its size: the hand is above the hole, not in it)."""
    cx, cy = _drop_point(box)
    ox0, oy0, ox1, oy1 = opening_box
    gx, gy = 0.5 * (ox1 - ox0), 0.5 * (oy1 - oy0)
    return ox0 - gx <= cx <= ox1 + gx and oy0 - gy <= cy <= oy1 + gy


AT_BINS_M = 0.75     # the person's feet within this distance of the bins (when the distance is known)
SEGMENT_GAP_S = 0.5  # sightings further apart than this belong to different stretches
END_WINDOW_S = 1.0   # the opening is looked for in the last second of the carrying stretch


def _carry(trace: list[tuple]) -> list[tuple]:
    """The longest stretch of sightings (carrying the item); [] if the item was never seen."""
    seen = [(t, box, dist) for t, box, dist in trace if box is not None]
    if not seen:
        return []
    stretches, cur = [], [seen[0]]
    for prev, nxt in zip(seen, seen[1:]):
        if nxt[0] - prev[0] > SEGMENT_GAP_S:
            stretches.append(cur)
            cur = []
        cur.append(nxt)
    stretches.append(cur)
    return max(stretches, key=lambda s: (s[-1][0] - s[0][0], len(s)))


def carry_end(trace: list[tuple]) -> float | None:
    """When the item left the hand: the end of the longest stretch of sightings."""
    carry = _carry(trace)
    return carry[-1][0] if carry else None


def same_openings(a: list[dict], b: list[dict], width: int, tol: float = 0.12) -> bool:
    """The same openings in about the same places (within tol x the frame width): the camera did not move. An arm over
    the bins shifts the boxes a little (IMG_9118-9120); a pan moves them hundreds of pixels (IMG_9121)."""
    if not a or len(a) != len(b):
        return False
    centre = lambda o: ((o["box"][0] + o["box"][2]) / 2, (o["box"][1] + o["box"][3]) / 2)  # noqa: E731
    return all(min(abs(centre(x)[0] - centre(y)[0]) + abs(centre(x)[1] - centre(y)[1]) for y in b) <= tol * width for x in a)


def thrown_into(trace: list[tuple], openings: list[dict], at_bins_m: float = AT_BINS_M) -> dict | None:
    """trace: (t, item box if CLIP saw the item in that frame else None, feet distance to the bins in m or None).
    Carrying an item is one long stretch of sightings; it ends when the item leaves the hand. The opening the item was
    over in the last second of the LONGEST stretch is where it went. Later short stretches are false sightings (IMG_9117:
    walking away, the bin in the hand crop looked like an item over RECYCLING; the cup had gone into WASTE)."""
    carry = _carry(trace)
    if not carry:
        return None
    end = carry[-1][0]
    for t, box, dist in reversed(carry):
        if end - t > END_WINDOW_S:
            break
        if dist is not None and dist > at_bins_m:
            continue
        near = [o for o in openings if _over(box, o["box"])]
        if near:
            cx, cy = _drop_point(box)
            o = min(near, key=lambda o: abs((o["box"][0] + o["box"][2]) / 2 - cx) + abs((o["box"][1] + o["box"][3]) / 2 - cy))
            return {"t": t, "bin": o["bin"], "label": o["label"]}
    return None


def outcome_text(recommended: dict, thrown: dict) -> tuple[str, str, bool] | None:
    """("Thrown in: Organics", "CORRECT" | "WRONG BIN", correct) for the bottom bar; None if the opening's type is unknown."""
    if thrown.get("bin") not in BIN_NAME:
        return None
    name = BIN_NAME[thrown["bin"]]
    correct = thrown["bin"] == recommended.get("bin")
    return f"Thrown in: {name}", "CORRECT" if correct else "WRONG BIN", correct
