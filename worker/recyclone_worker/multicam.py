"""Several cameras watching the same bins (a store or station with multiple surveillance cameras). Optional:
`recyclone-worker run-station`. The single-camera `run` is unchanged and does not use this module.

Every camera is analyzed on its own by the existing item tracker (items.analyze), unchanged. This module then:
1. tells per camera and moment whether the person FACES that camera or shows it their BACK (facing_series), from
   the skeleton: seen from the front, a person's left shoulder is on the RIGHT of the image; from behind it flips.
2. merges the cameras' drops: the same bin (same bin_id in every camera's config) within MERGE_S seconds is ONE
   physical drop, reported once, by the camera the person faced at that moment (fuse).
3. picks the ACTIVE camera over time (the one the person faces), switching only when another view is clearly
   better for SWITCH_HOLD_S, so the display does not flicker (active_timeline).
When the person turns their back to camera A, A usually misses the drop (the body hides it) and camera B, which
they face, sees it: the drop then comes from B. A drop only a back-view camera saw is still reported (it was seen).

Facing rule measured 17 Oct on 23 hand-labeled frames it was NOT tuned on: 22/23 right (the miss was mid-turn).
Cameras are put on one clock with `offset_s` per camera (station time = offset_s + frame / fps).
"""

import json
import sys
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING

import cv2
import numpy as np

if TYPE_CHECKING:
    from .items import Analysis

FACING_BACK = -0.2      # (left shoulder x - right shoulder x) / torso length below this: back to the camera
FACING_HALF_S = 0.25    # median over +-0.25 s, so one bad skeleton does not flip the label
MERGE_S = 1.5           # drops into the same bin within 1.5 s, seen by different cameras, are one drop
SWITCH_HOLD_S = 0.5     # the active camera changes only after another camera has been clearly better this long
VIEW_SCORE = {"front": 1.0, "unknown": 0.5, "back": 0.2, "none": 0.0}  # how well a camera sees the person's hands


def facing_ratio(kp) -> float | None:
    """Signed shoulder order over torso length; > 0 facing the camera, < 0 back to it. None without a torso."""
    if min(kp[5][2], kp[6][2], kp[11][2], kp[12][2]) < 0.3:
        return None
    sh = (kp[5][:2] + kp[6][:2]) / 2
    hp = (kp[11][:2] + kp[12][:2]) / 2
    return float((kp[5][0] - kp[6][0]) / max(1.0, float(np.hypot(*(hp - sh)))))


def facing_series(kps: np.ndarray, fps: float, half_s: float = FACING_HALF_S, back: float = FACING_BACK) -> list[str]:
    """Per frame: "front" | "back" | "unknown" (a person, but no torso to judge) | "none" (no person)."""
    ratios = [facing_ratio(k) for k in kps]
    person = [bool((k[:, 2] > 0.3).sum() >= 4) for k in kps]
    h = max(1, round(fps * half_s))
    out = []
    for i in range(len(kps)):
        vals = [r for r in ratios[max(0, i - h): i + h + 1] if r is not None]
        if vals:
            out.append("back" if float(np.median(vals)) < back else "front")
        else:
            out.append("unknown" if person[i] else "none")
    return out


@dataclass
class CameraRun:
    """One camera of a station: its analysis (items.Analysis) placed on the station clock."""

    camera_id: str
    analysis: "Analysis"
    offset_s: float = 0.0
    video: Path | None = None
    facing: list[str] = field(default_factory=list)

    def __post_init__(self):
        if not self.facing:
            self.facing = facing_series(self.analysis.data["kps"], self.fps)

    @property
    def fps(self) -> float:
        return float(self.analysis.data["fps"])

    @property
    def n(self) -> int:
        return len(self.analysis.data["kps"])

    def frame_at(self, t: float) -> int | None:
        """This camera's frame at station time t, or None when it was not recording."""
        f = round((t - self.offset_s) * self.fps)
        return f if 0 <= f < self.n else None

    def time_of(self, frame: int) -> float:
        return self.offset_s + frame / self.fps

    def view_at(self, t: float) -> str:
        f = self.frame_at(t)
        return "none" if f is None else self.facing[f]


def fuse(cams: list[CameraRun], merge_s: float = MERGE_S) -> list[dict]:
    """One drop per physical drop across cameras: {"t", "bin", "camera_id", "drop", "seen_by", "view"}.

    Reporting camera: the best view at that moment (front > unknown > back), then the longest-held item. The others
    that saw the same drop are listed in "seen_by"."""
    all_drops = sorted(((c.time_of(d["frame"]), d["bin"], c, d) for c in cams for d in c.analysis.events), key=lambda x: x[0])
    groups: list[list] = []
    for item in all_drops:
        t, bid = item[0], item[1]
        g = next((g for g in groups if g[0][1] == bid and abs(g[0][0] - t) <= merge_s and all(x[2] is not item[2] for x in g)), None)
        if g is None:
            groups.append([item])
        else:
            g.append(item)
    out = []
    for g in groups:
        best = max(g, key=lambda x: (VIEW_SCORE[x[2].view_at(x[0])], x[3].get("held_frames", 0)))
        t, bid, cam, drop = best
        out.append({"t": round(t, 3), "bin": bid, "camera_id": cam.camera_id, "drop": drop, "view": cam.view_at(t),
                    "seen_by": sorted(x[2].camera_id for x in g)})
    return sorted(out, key=lambda d: d["t"])


def active_timeline(cams: list[CameraRun], step_s: float, hold_s: float = SWITCH_HOLD_S) -> list[tuple[float, str]]:
    """(station time, active camera_id) every step_s: the camera with the best view of the person, with hysteresis."""
    t_end = max(c.offset_s + c.n / c.fps for c in cams)
    t0 = min(c.offset_s for c in cams)
    active, challenger, since, out = None, None, 0.0, []
    t = t0
    while t < t_end:
        scores = {c.camera_id: VIEW_SCORE[c.view_at(t)] for c in cams}
        best = max(scores, key=lambda k: (scores[k], -[c.camera_id for c in cams].index(k)))
        if active is None or scores[active] == 0.0:
            active, challenger = best, None
        elif scores[best] > scores[active]:
            if challenger != best:
                challenger, since = best, t
            elif t - since >= hold_s:
                active, challenger = best, None
        else:
            challenger = None
        out.append((round(t, 3), active))
        t += step_s
    return out


def load_station(path: Path) -> dict:
    """{"station_id", "cameras": [{"camera_id", "video", "offset_s"?, "bins"? (item-tracker keyframes)}]}."""
    st = json.loads(Path(path).read_text())
    ids = [c["camera_id"] for c in st["cameras"]]
    if len(set(ids)) != len(ids) or len(ids) < 2:
        raise ValueError("a station needs at least 2 cameras with different camera_id")
    return st


VIEW_COLORS = {"front": (80, 220, 80), "back": (60, 60, 230), "unknown": (0, 200, 255), "none": (150, 150, 150)}


def station_grid(frames: dict[str, np.ndarray], height: int = 540) -> np.ndarray:
    """Camera views side by side (two rows from 4 cameras), each scaled to the same height."""
    tiles = [cv2.resize(f, (round(f.shape[1] * height / f.shape[0]), height)) for f in frames.values()]
    if len(tiles) <= 3:
        return np.hstack(tiles)
    half = (len(tiles) + 1) // 2
    rows = [np.hstack(tiles[:half]), np.hstack(tiles[half:])]
    w = max(r.shape[1] for r in rows)
    return np.vstack([cv2.copyMakeBorder(r, 0, 0, 0, w - r.shape[1], cv2.BORDER_CONSTANT) for r in rows])


class StationPlayback:
    """Plays all cameras of a station on one clock: a combined annotated view (facing label per camera, a border on
    the active camera) and one event per fused drop, sent by the camera that reported it when the clock reaches it."""

    def __init__(self, cams: list[CameraRun], fused: list[dict], playbacks: dict, *, on_frame=None, realtime: bool = False):
        self.cams, self.fused, self.playbacks, self.on_frame, self.realtime = cams, fused, playbacks, on_frame, realtime

    def run(self) -> list[dict]:
        from .item_playback import annotate_items

        step = 1 / max(c.fps for c in self.cams)
        timeline = dict(active_timeline(self.cams, step))
        caps = {c.camera_id: cv2.VideoCapture(str(c.video)) for c in self.cams}
        pos = {c.camera_id: -1 for c in self.cams}
        last = {c.camera_id: None for c in self.cams}
        recent = {c.camera_id: deque(maxlen=90) for c in self.cams}
        pending, sent, wall0 = list(self.fused), [], time.monotonic()
        t0 = min(c.offset_s for c in self.cams)
        t_end = max(c.offset_s + c.n / c.fps for c in self.cams)
        for k in range(int(np.ceil((t_end - t0) / step))):
            t = round(t0 + k * step, 3)
            if self.realtime:
                time.sleep(max(0.0, (t - t0) - (time.monotonic() - wall0)))
            views = {}
            for c in self.cams:
                f = c.frame_at(t)
                if f is not None:
                    while pos[c.camera_id] < f:  # read forward only; a camera with fewer fps repeats its frame
                        ok, img = caps[c.camera_id].read()
                        pos[c.camera_id] += 1
                        if not ok:
                            break
                        last[c.camera_id] = img
                        recent[c.camera_id].append((pos[c.camera_id], img))
                img = last[c.camera_id]
                if img is None or f is None:
                    h, w = (1920, 1080) if img is None else img.shape[:2]
                    views[c.camera_id] = np.full((h, w, 3), 30, np.uint8)
                    continue
                out = annotate_items(img, f, c.analysis, sum(1 for e in sent if e["source"]["camera_id"] == c.camera_id))
                view = c.view_at(t)
                big = max(out.shape[:2]) / 1920
                label = {"front": "FACING CAMERA", "back": "BACK TO CAMERA", "unknown": "PERSON (no torso)", "none": "NO PERSON"}[view]
                cv2.putText(out, f"{c.camera_id}: {label}", (int(24 * big), out.shape[0] - int(110 * big)), cv2.FONT_HERSHEY_SIMPLEX,
                            1.6 * big, VIEW_COLORS[view], max(2, int(4 * big)))
                if timeline.get(t) == c.camera_id:
                    cv2.rectangle(out, (0, 0), (out.shape[1] - 1, out.shape[0] - 1), (0, 255, 255), max(8, int(24 * big)))
                    cv2.putText(out, "ACTIVE", (int(24 * big), int(130 * big)), cv2.FONT_HERSHEY_SIMPLEX, 2.2 * big, (0, 255, 255), max(3, int(6 * big)))
                views[c.camera_id] = out
            while pending and pending[0]["t"] <= t:
                d = pending.pop(0)
                pb = self.playbacks[d["camera_id"]]
                try:
                    pb._emit_one(d["drop"], recent[d["camera_id"]], sent)
                    print(f"drop {d['bin']} at {d['t']:.2f}s reported by {d['camera_id']} ({d['view']}); seen by {d['seen_by']}", file=sys.stderr)
                except Exception as e:  # noqa: BLE001 - one bad event must not end the run
                    print(f"ERROR emitting station drop at {d['t']}: {type(e).__name__}: {e}", file=sys.stderr)
            if self.on_frame:
                self.on_frame(station_grid(views))
        for c in caps.values():
            c.release()
        return sent


def station_started_at(cams: list[CameraRun], realtime: bool) -> datetime:
    """Station clock start: now for realtime; else back-dated by the station length (core rejects future times)."""
    from datetime import UTC

    length = max(c.offset_s + c.n / c.fps for c in cams) - min(c.offset_s for c in cams)
    return datetime.now(UTC) if realtime else datetime.now(UTC) - timedelta(seconds=length)
