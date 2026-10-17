"""Frames in, one DisposalEvent per item that entered a bin out (worker/AGENTS.md pipeline)."""

import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from . import entry
from .client import EventSink
from .events import build_event, validate_event
from .identify import Embedder, Gallery, business_from_candidates, identify
from .site import Site
from .tracking import Tracker

KEEP_CROPS = 3
# Must exceed the tracker's lost-track buffer (ByteTrack: 30 frames). Finalizing earlier judges a
# half path: a cup hidden by a hand over the bin would "enter" it and then be carried away.
GONE_AFTER_FRAMES = 35


@dataclass
class _TrackState:
    history: list[tuple[float, float]] = field(default_factory=list)
    last_seen: int = 0
    last_offset: float = 0.0
    crops: list[tuple[float, int, np.ndarray]] = field(default_factory=list)  # (area, frame_idx, crop), largest first
    last_crop: tuple[int, np.ndarray] | None = None  # evidence: the moment it entered, not when held up close


def clamp_crop(frame: np.ndarray, box) -> np.ndarray | None:
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = max(0, int(box[0])), max(0, int(box[1])), min(w, int(box[2])), min(h, int(box[3]))
    return frame[y1:y2, x1:x2].copy() if x2 > x1 and y2 > y1 else None


class Pipeline:
    def __init__(self, site: Site, tracker: Tracker, embedder: Embedder, gallery: Gallery, sink: EventSink, *,
                 clip_id: str, started_at: datetime, evidence_dir: Path, gone_after_frames: int = GONE_AFTER_FRAMES, on_frame=None,
                 catalog_business: dict[str, str | None] | None = None, categories=None,
                 reference_threshold: float | None = None):
        self.site, self.tracker, self.embedder, self.gallery, self.sink = site, tracker, embedder, gallery, sink
        self.clip_id, self.started_at, self.evidence_dir = clip_id, started_at, Path(evidence_dir)
        self.gone_after_frames, self.on_frame = gone_after_frames, on_frame
        self.catalog_business = catalog_business or {}
        self.categories, self.reference_threshold = categories, reference_threshold

    def run(self, source) -> list[dict]:
        states: dict[int, _TrackState] = {}
        sent: list[dict] = []
        frame_size = None
        for idx, offset, frame in source:
            frame_size = (frame.shape[1], frame.shape[0])
            tracks = self.tracker.update(frame)
            for t in tracks:
                s = states.setdefault(t.track_id, _TrackState())
                x1, y1, x2, y2 = t.box
                s.history.append(((x1 + x2) / 2, (y1 + y2) / 2))
                s.last_seen, s.last_offset = idx, offset
                crop = clamp_crop(frame, t.box)
                if crop is not None:
                    s.last_crop = (idx, crop)
                    s.crops.append((crop.shape[0] * crop.shape[1], idx, crop))  # visible (clamped) area
                    s.crops = sorted(s.crops, key=lambda c: c[0], reverse=True)[:KEEP_CROPS]
            if self.on_frame:
                self.on_frame(frame, tracks, self.site.regions)
            for tid in [tid for tid, s in states.items() if idx - s.last_seen >= self.gone_after_frames]:
                self._finalize(tid, states.pop(tid), frame_size, sent)
        for tid, s in list(states.items()):  # tracks still open when the clip ends
            self._finalize(tid, s, frame_size, sent)
        return sent

    def _finalize(self, track_id: int, s: _TrackState, frame_size, sent: list[dict]) -> None:
        """One bad event (a bug, a full disk, a network library surprise) must not end the live run."""
        try:
            self._finalize_one(track_id, s, frame_size, sent)
        except Exception as e:  # noqa: BLE001 - deliberately broad, reported below
            print(f"ERROR finalizing track {track_id}: {type(e).__name__}: {e}", file=sys.stderr)

    def _finalize_one(self, track_id: int, s: _TrackState, frame_size, sent: list[dict]) -> None:
        decision = entry.entered_bin(s.history, self.site.regions, frame_size)
        if decision is None:
            return
        bin_id, confidence = decision
        evidence = []
        if s.last_crop is not None:
            frame_idx, last = s.last_crop
            rel = f"{self.clip_id}/{track_id}_entry.jpg"
            (self.evidence_dir / self.clip_id).mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(self.evidence_dir / rel), last)
            evidence = [{"kind": "crop", "uri": f"evidence/{rel}", "frame": frame_idx}]
        item = identify([c for _, _, c in s.crops], self.embedder, self.gallery,
                        categories=self.categories, reference_threshold=self.reference_threshold)
        event = build_event(
            camera_id=self.site.camera_id, clip_id=self.clip_id, track_id=track_id, bin_id=bin_id,
            started_at=self.started_at, offset_s=s.last_offset, destination_confidence=round(confidence, 4),
            item=item, evidence=evidence,
        )
        event["business"] = business_from_candidates(item, self.catalog_business)
        validate_event(event)
        sent.append(event)
        self.sink.send(event)
