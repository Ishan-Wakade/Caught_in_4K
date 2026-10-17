"""Play an analyzed clip (items.analyze) as if live: the annotated stream at clip speed, each drop's event sent
when the video reaches the drop.

The item tracker runs at ~2 fps, far below a 30 fps camera, so the clip is analyzed first (cached) and then
played back (Eymen, 17 Oct). The drops still come from the model, not from hand labels; only the timing of
the analysis differs from a live camera. See worker/AGENTS.md "Item tracker in `run`".
"""

import sys
from collections import deque
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from .events import build_event, validate_event
from .identify import business_from_candidates
from .items import Analysis, destination_confidence, item_box_at, item_from_votes
from .pipeline import clamp_crop, pad_box

KEEP_FRAMES = 90  # recent frames kept for evidence crops (the item's last sighting can precede the drop by ~1 s)
ROLE_COLORS = {"carried": (0, 165, 255), "re-found": (0, 165, 255), "already in bin": (170, 170, 170)}


def annotate_items(frame: np.ndarray, idx: int, analysis: Analysis, sent: int) -> np.ndarray:
    """Bin boxes, the items people brought (orange) and existing bin contents (grey). No skeleton: items, not people."""
    out = frame.copy()
    h = out.shape[0]
    for bid, boxes in analysis.bins.items():
        if idx < len(boxes) and boxes[idx] is not None:
            x0, y0, x1, y1 = map(int, boxes[idx])
            cv2.rectangle(out, (x0, y0), (x1, y1), (0, 200, 0), 3)
            cv2.putText(out, bid.replace("bin_", ""), (x0 + 6, y0 + 28), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (120, 255, 120), 2)
    by_id = {t["id"]: t for t in analysis.tracks}
    for tid, b, _ in (analysis.per_frame[idx] if idx < len(analysis.per_frame) else []):
        role = analysis.roles.get(tid)
        if role not in ROLE_COLORS:
            continue
        x0, y0, x1, y1 = map(int, b)
        cv2.rectangle(out, (x0, y0), (x1, y1), ROLE_COLORS[role], 3 if role != "already in bin" else 1)
        if role != "already in bin":
            cat = by_id[analysis.identity[tid]]["category"] or "unknown item"
            cv2.putText(out, cat.replace("item_generic_", "").replace("item_", ""), (x0, max(24, y0 - 8)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, ROLE_COLORS[role], 2)
    fps = float(analysis.data["fps"])
    for e in analysis.events:
        if e["frame"] <= idx < e["frame"] + int(1.5 * fps):
            cv2.putText(out, f"DROP -> {e['bin'].replace('bin_', '')}", (24, h - 40), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (80, 255, 80), 3)
    cv2.putText(out, f"drops {sent}", (24, 48), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 3)
    return out


class ItemPlayback:
    def __init__(self, analysis: Analysis, sink, *, camera_id: str, clip_id: str, started_at: datetime, evidence_dir: Path,
                 catalog_business: dict[str, str | None] | None = None, on_frame=None):
        self.analysis, self.sink = analysis, sink
        self.camera_id, self.clip_id, self.started_at = camera_id, clip_id, started_at
        self.evidence_dir, self.catalog_business, self.on_frame = Path(evidence_dir), catalog_business or {}, on_frame

    def run(self, source) -> list[dict]:
        pending = list(self.analysis.events)
        recent: deque = deque(maxlen=KEEP_FRAMES)
        sent: list[dict] = []
        for idx, _offset, frame in source:
            recent.append((idx, frame))
            while pending and pending[0]["frame"] <= idx:
                self._emit(pending.pop(0), recent, sent)
            if self.on_frame:
                self.on_frame(annotate_items(frame, idx, self.analysis, len(sent)))
        for drop in pending:  # the source ended early (shorter than the analyzed clip): still report the drops
            self._emit(drop, recent, sent)
        return sent

    def _emit(self, drop: dict, recent, sent: list[dict]) -> None:
        """One bad event must not end the run (same rule as Pipeline._finalize)."""
        try:
            self._emit_one(drop, recent, sent)
        except Exception as e:  # noqa: BLE001 - deliberately broad, reported below
            print(f"ERROR emitting drop at frame {drop.get('frame')}: {type(e).__name__}: {e}", file=sys.stderr)

    def _emit_one(self, drop: dict, recent, sent: list[dict]) -> None:
        a = self.analysis
        root = next(t for t in a.tracks if t["id"] == drop["item_id"])
        item = item_from_votes(root)
        evidence = []
        seen = item_box_at(a, drop)
        frames = dict(recent)
        if seen is not None and seen[0] in frames:
            f, box = seen
            img = frames[f]
            crop = clamp_crop(img, pad_box(box, (img.shape[1], img.shape[0])))
            if crop is not None:
                rel = f"{self.clip_id}/{drop['item_id']}_entry.jpg"
                (self.evidence_dir / self.clip_id).mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(self.evidence_dir / rel), crop)
                evidence = [{"kind": "crop", "uri": f"evidence/{rel}", "frame": int(f)}]
        event = build_event(
            camera_id=self.camera_id, clip_id=self.clip_id, track_id=int(drop["item_id"]), bin_id=drop["bin"],
            started_at=self.started_at, offset_s=drop["frame"] / float(a.data["fps"]),
            destination_confidence=destination_confidence(a, drop), item=item, evidence=evidence,
        )
        event["business"] = business_from_candidates(item, self.catalog_business)
        validate_event(event)
        sent.append(event)
        self.sink.send(event)
