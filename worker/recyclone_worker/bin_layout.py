"""Local, manually labeled bin-opening keyframes for prerecorded presentation overlays.

These annotations never decide approach timing or establish which bin an item entered.
"""

import bisect
import json
import math
from pathlib import Path

LABELS = {"recycle": "RECYCLING", "trash": "TRASH", "compost": "COMPOST"}


class BinLayout:
    def __init__(self, path):
        self.path = Path(path)
        data = json.loads(self.path.read_text())
        self.size = data["source_size"]
        if len(self.size) != 2 or any(not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0 for v in self.size):
            raise ValueError("bin layout needs positive source_size [width, height]")
        self.keyframes = data["keyframes"]
        self.times = [k["t"] for k in self.keyframes]
        if not self.times or any(not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0 for t in self.times):
            raise ValueError("bin layout needs finite nonnegative keyframe times")
        if any(a >= b for a, b in zip(self.times, self.times[1:])):
            raise ValueError("bin layout keyframe times must strictly increase")
        for frame in self.keyframes:
            if set(frame["boxes"]) != set(LABELS):
                raise ValueError("each bin layout keyframe needs recycle, trash and compost boxes")
            for box in frame["boxes"].values():
                if (len(box) != 4 or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in box)
                        or box[0] >= box[2] or box[1] >= box[3]):
                    raise ValueError("bin layout boxes must be finite x0,y0,x1,y1 rectangles")

    def at(self, t, width, height):
        """Interpolate local annotations, scale to this frame, clip or hide offscreen openings."""
        i = max(0, bisect.bisect_right(self.times, t) - 1)
        j = min(i + 1, len(self.times) - 1)
        weight = min(1.0, max(0.0, (t - self.times[i]) / (self.times[j] - self.times[i]))) if i != j else 0.0
        result = []
        for kind, label in LABELS.items():
            a, b = self.keyframes[i]["boxes"][kind], self.keyframes[j]["boxes"][kind]
            box = [round(((1 - weight) * x + weight * y) * scale) for x, y, scale in
                   zip(a, b, [width / self.size[0], height / self.size[1]] * 2)]
            x0, y0, x1, y1 = max(0, box[0]), max(0, box[1]), min(width - 1, box[2]), min(height - 1, box[3])
            if x1 - x0 >= 8 and y1 - y0 >= 4:
                result.append({"bin": kind, "label": label, "box": (x0, y0, x1, y1)})
        return result

    def report(self):
        return {"source": "manual_keyframes", "path": str(self.path), "source_size": self.size,
                "keyframes": self.keyframes, "purpose": "visual_overlay_only"}
