"""Item tracks per frame. People are dropped here, before anything else sees them."""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np


# COCO classes that are people, worn/carried by people, or part of the scene. Tracking them would
# make bins, chairs, or a passer-by's backpack "disappear into" a bin region. A denylist rather than
# an allowlist, because wrappers and bags have no COCO class and show up under odd names.
NOT_ITEMS = frozenset({
    "person", "hand", "backpack", "handbag", "tie", "suitcase", "umbrella",
    "chair", "couch", "bench", "bed", "dining table", "toilet", "potted plant", "tv", "laptop",
    "refrigerator", "oven", "sink", "microwave", "car", "bicycle", "motorcycle", "dog", "cat",
})


def is_item_class(name: str) -> bool:
    return name not in NOT_ITEMS


@dataclass(frozen=True)
class Track:
    track_id: int
    box: tuple[float, float, float, float]  # x1, y1, x2, y2 in pixels
    cls_name: str


class Tracker(Protocol):
    def update(self, frame: np.ndarray) -> list[Track]: ...


class YoloTracker:
    """YOLO detections linked across frames by ByteTrack (ultralytics `track(persist=True)`).

    ByteTrack keeps a lost track's ID for LOST_TRACK_FRAMES (bytetrack.yaml track_buffer); the
    pipeline must wait at least that long before deciding a track is gone.
    """

    LOST_TRACK_FRAMES = 30

    def __init__(self, weights: Path, imgsz: int = 960, device: str | None = None):
        import torch
        from ultralytics import YOLO

        self.model, self.imgsz = YOLO(str(Path(weights).expanduser())), imgsz
        self.device = device or ("mps" if torch.backends.mps.is_available() else "cpu")

    def update(self, frame: np.ndarray) -> list[Track]:
        result = self.model.track(frame, persist=True, imgsz=self.imgsz, device=self.device, verbose=False)[0]
        if result.boxes.id is None:
            return []
        out = []
        for box, tid, cls in zip(result.boxes.xyxy.tolist(), result.boxes.id.int().tolist(), result.boxes.cls.int().tolist()):
            name = self.model.names[cls]
            if is_item_class(name):
                out.append(Track(int(tid), tuple(box), name))
        return out


def _world_prompts() -> list[str]:
    from .categories import GENERIC_PROMPTS

    item_prompts = [p for prompts in GENERIC_PROMPTS.values() for p in prompts]
    # People and hands are prompted too, so the detector labels them (and they get dropped) instead of
    # calling a hand "a crumpled wrapper".
    return item_prompts + ["a box", "a bag", "a cup", "person", "hand"]


WORLD_PROMPTS = _world_prompts()


class WorldTracker(YoloTracker):
    """YOLO-World: open-vocabulary detection from text prompts, so wrappers, bags and boxes have a
    class (COCO YOLO calls them "book" or misses them). Labels are only used to drop people/hands;
    identification still comes from the reference gallery and the category classifier."""

    def __init__(self, weights: Path, prompts: list[str] = WORLD_PROMPTS, imgsz: int = 960, device: str | None = None,
                 conf: float = 0.05):
        super().__init__(weights, imgsz=imgsz, device=device)
        self.model.set_classes(prompts)
        self.conf = conf

    def update(self, frame: np.ndarray) -> list[Track]:
        result = self.model.track(frame, persist=True, imgsz=self.imgsz, device=self.device, conf=self.conf, verbose=False)[0]
        if result.boxes.id is None:
            return []
        return [Track(int(t), tuple(b), self.model.names[c])
                for b, t, c in zip(result.boxes.xyxy.tolist(), result.boxes.id.int().tolist(), result.boxes.cls.int().tolist())
                if is_item_class(self.model.names[c])]
