"""Is a person getting close to the bins? One box around all the bins (team, 17 Oct), a distance in meters, a speed.

Distance from the image: the person's feet (skeleton ankles) to the bin-area box. Pixels become meters with the
person's own height as a ruler (nose-to-ankle is ~0.87 of a ~1.7 m body), so no calibration is needed; with a floor
calibration (a 3x3 homography from image pixels to floor meters, e.g. from a 1 m tape square) the floor distance is
used instead. Announce once per visit: when the person is inside the area, within NEAR_M, or will arrive within
LEAD_S seconds at their current speed; again only after COOLDOWN_S away from the bins.
"""

from collections import deque
from dataclasses import dataclass

import numpy as np

BODY_M = 1.7          # assumed height of a person
NOSE_TO_ANKLE = 0.87  # share of body height between nose and ankles
TORSO_M = 0.5         # shoulder-to-hip length, when no ankles/nose for the ruler
NEAR_M = 1.5          # announce when this close (if not walking away)
LEAD_S = 2.5          # ... or when arriving within this many seconds
SPEED_WINDOW_S = 0.5  # speed from the last half second
MIN_HISTORY_S = 0.3   # outside the area, judge speed only after this much history
COOLDOWN_S = 8.0      # away from the bins this long before a new visit can be announced
KP_CONF = 0.3


@dataclass(frozen=True)
class BinArea:
    x0: float
    y0: float
    x1: float
    y1: float


def _pt(kp, j):
    return (float(kp[j][0]), float(kp[j][1])) if kp[j][2] >= KP_CONF else None


def _feet(kp):
    ankles = [p for p in (_pt(kp, 15), _pt(kp, 16)) if p]
    return (float(np.mean([p[0] for p in ankles])), float(np.mean([p[1] for p in ankles]))) if ankles else None


def person_meters_per_px(kp) -> float | None:
    feet, nose = _feet(kp), _pt(kp, 0)
    if feet and nose and feet[1] - nose[1] > 10:
        return BODY_M * NOSE_TO_ANKLE / (feet[1] - nose[1])
    sh = [p for p in (_pt(kp, 5), _pt(kp, 6)) if p]
    hp = [p for p in (_pt(kp, 11), _pt(kp, 12)) if p]
    if sh and hp:
        torso = abs(np.mean([p[1] for p in hp]) - np.mean([p[1] for p in sh]))
        return TORSO_M / torso if torso > 5 else None
    return None


def _box_gap(pt, x0, y0, x1, y1) -> float:
    dx = max(x0 - pt[0], 0.0, pt[0] - x1)
    dy = max(y0 - pt[1], 0.0, pt[1] - y1)
    return float(np.hypot(dx, dy))


def distance_m(kp, area: BinArea, homography=None) -> float | None:
    """Meters from the person's feet to the bin area (0 inside it). Without visible ankles: 0 if a hand is inside the
    area, else None."""
    feet = _feet(kp)
    if feet is None:  # feet out of the picture (close-up): a hand inside the bin area means the person is there
        wrists = [p for p in (_pt(kp, 9), _pt(kp, 10)) if p]
        return 0.0 if any(_box_gap(w, area.x0, area.y0, area.x1, area.y1) == 0.0 for w in wrists) else None
    if homography is not None:
        h = np.asarray(homography, np.float64)

        def floor(p):
            v = h @ np.array([p[0], p[1], 1.0])
            return v[:2] / v[2]
        f = floor(feet)
        corners = np.array([floor(c) for c in ((area.x0, area.y0), (area.x1, area.y0), (area.x1, area.y1), (area.x0, area.y1))])
        return _box_gap(f, corners[:, 0].min(), corners[:, 1].min(), corners[:, 0].max(), corners[:, 1].max())
    scale = person_meters_per_px(kp)
    if scale is None:
        return None
    return _box_gap(feet, area.x0, area.y0, area.x1, area.y1) * scale


class Approach:
    def __init__(self, area: BinArea, homography=None):
        self.area, self.homography = area, homography
        self.hist: dict[int, deque] = {}
        self.fired: dict[int, bool] = {}
        self.last_near: dict[int, float] = {}

    def update(self, track_id: int, t: float, kp) -> bool:
        """True exactly once per visit, when this person should hear the announcement."""
        d = distance_m(kp, self.area, self.homography)
        if d is None:
            return False
        h = self.hist.setdefault(track_id, deque())
        h.append((t, d))
        while h and t - h[0][0] > SPEED_WINDOW_S:
            h.popleft()
        if d <= NEAR_M:
            self.last_near[track_id] = t
        if self.fired.get(track_id):
            if d > NEAR_M and t - self.last_near.get(track_id, t) >= COOLDOWN_S:
                self.fired[track_id] = False  # a new visit may be announced
            return False
        if d == 0.0:
            return self._fire(track_id)
        span = t - h[0][0]
        if span < MIN_HISTORY_S:
            return False
        speed = (h[0][1] - d) / span  # m/s toward the area (negative: walking away)
        if speed < -0.1:
            return False
        if d <= NEAR_M or (speed > 0.2 and d / speed <= LEAD_S):
            return self._fire(track_id)
        return False

    def _fire(self, track_id: int) -> bool:
        self.fired[track_id] = True
        return True

    def left(self, track_id: int, t: float) -> None:
        """The track is gone (person out of view): forget it once its cooldown has passed."""
        if t - self.last_near.get(track_id, -1e9) >= COOLDOWN_S:
            for d in (self.hist, self.fired, self.last_near):
                d.pop(track_id, None)
