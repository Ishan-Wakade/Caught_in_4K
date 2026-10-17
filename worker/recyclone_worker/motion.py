"""Backup tracker: anything that MOVES near the bins, no object classes needed.

YOLO's COCO classes have no wrapper, chip bag or napkin, so YOLO can miss exactly the items a
waste demo is about. The camera is fixed, so background subtraction finds every moving blob.
Limits: an item still in a hand merges with the arm into one blob (too big, so it is ignored), and
it only looks in a band around the bin openings, where a released item is small and on its own.
"""

import cv2
import numpy as np

from .site import BinRegion
from .tracking import Track


class MotionTracker:
    def __init__(self, regions: list[BinRegion], margin: float = 1.0, min_area_frac: float = 0.0003,
                 max_area_frac: float = 0.06, max_jump_frac: float = 0.08, lost_after: int = 30,
                 max_side_frac: float = 0.35, merge_gap_frac: float = 0.05):
        self.regions, self.margin = regions, margin
        self.min_area_frac, self.max_area_frac = min_area_frac, max_area_frac
        self.max_jump_frac, self.lost_after = max_jump_frac, lost_after
        self.max_side_frac, self.merge_gap_frac = max_side_frac, merge_gap_frac
        self.subtractor = cv2.createBackgroundSubtractorMOG2(history=300, varThreshold=32, detectShadows=False)
        self.kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        # Transparent or plain items only differ from the background at their edges and print, so the
        # foreground comes in pieces. A wide dilation joins the pieces of one item into one blob.
        self.join = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (25, 25))
        self.tracks: dict[int, tuple[float, float, int]] = {}  # id -> (cx, cy, last frame seen)
        self.next_id, self.frame_idx, self.band = 1, -1, None

    def _band(self, w: int, h: int) -> tuple[int, int, int, int]:
        boxes = [r.to_pixels(w, h) for r in self.regions]
        x1 = min(x - self.margin * bw for x, y, bw, bh in boxes)
        y1 = min(y - self.margin * bh for x, y, bw, bh in boxes)
        x2 = max(x + bw + self.margin * bw for x, y, bw, bh in boxes)
        y2 = max(y + bh + self.margin * bh for x, y, bw, bh in boxes)
        return max(0, int(x1)), max(0, int(y1)), min(w, int(x2)), min(h, int(y2))

    def update(self, frame: np.ndarray) -> list[Track]:
        self.frame_idx += 1
        h, w = frame.shape[:2]
        if self.band is None:
            self.band = self._band(w, h)
        mask = self.subtractor.apply(frame)
        mask = cv2.morphologyEx(cv2.threshold(mask, 200, 255, cv2.THRESH_BINARY)[1], cv2.MORPH_OPEN, self.kernel)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, self.kernel)
        mask = cv2.dilate(mask, self.join)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        boxes = _merge_close([cv2.boundingRect(c) for c in contours], gap=self.merge_gap_frac * h)
        bx1, by1, bx2, by2 = self.band
        blobs = []
        for x, y, bw, bh in boxes:
            cx, cy = x + bw / 2, y + bh / 2
            item_sized = (self.min_area_frac * w * h <= bw * bh <= self.max_area_frac * w * h
                          and bw <= self.max_side_frac * w and bh <= self.max_side_frac * h)  # a body or arm is taller
            if item_sized and bx1 <= cx <= bx2 and by1 <= cy <= by2:
                blobs.append((cx, cy, (x, y, x + bw, y + bh)))
        return self._associate(blobs, max_jump=self.max_jump_frac * (w * w + h * h) ** 0.5)

    def _associate(self, blobs, max_jump: float) -> list[Track]:
        out, taken = [], set()
        for cx, cy, box in sorted(blobs, key=lambda b: -(b[2][2] - b[2][0]) * (b[2][3] - b[2][1])):
            best = min(
                ((((cx - tx) ** 2 + (cy - ty) ** 2) ** 0.5, tid) for tid, (tx, ty, _) in self.tracks.items() if tid not in taken),
                default=None,
            )
            if best and best[0] <= max_jump:
                tid = best[1]
            else:
                tid, self.next_id = self.next_id, self.next_id + 1
            taken.add(tid)
            self.tracks[tid] = (cx, cy, self.frame_idx)
            out.append(Track(tid, tuple(float(v) for v in box), "motion"))
        self.tracks = {t: v for t, v in self.tracks.items() if self.frame_idx - v[2] <= self.lost_after}
        return out


def _merge_close(boxes: list[tuple[int, int, int, int]], gap: float) -> list[tuple[int, int, int, int]]:
    """Merge (x, y, w, h) boxes that overlap or lie within `gap` px: pieces of one item."""
    boxes = [list(b) for b in boxes]
    merged = True
    while merged:
        merged = False
        for i in range(len(boxes)):
            for j in range(i + 1, len(boxes)):
                ax, ay, aw, ah = boxes[i]
                bx, by, bw, bh = boxes[j]
                if ax - gap <= bx + bw and bx - gap <= ax + aw and ay - gap <= by + bh and by - gap <= ay + ah:
                    x1, y1 = min(ax, bx), min(ay, by)
                    boxes[i] = [x1, y1, max(ax + aw, bx + bw) - x1, max(ay + ah, by + bh) - y1]
                    del boxes[j]
                    merged = True
                    break
            if merged:
                break
    return [tuple(b) for b in boxes]
