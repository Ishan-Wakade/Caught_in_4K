"""The voice guide: when a person carrying waste comes close to the bins, the bin's speaker says which bin it goes in.

Per frame, causal (past frames only): skeletons with track ids (YOLO11n-pose + ByteTrack) -> what each person holds
(guide_identify.ItemWatcher, started early) -> are they close to the bin area (approach.Approach)? On the trigger:
speak the answer if ready; otherwise wait for it, and say "trash" if it is still missing when the person reaches the
bins (team: trash is the default when very uncertain). One announcement per person per visit; each is logged.
"""

import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

from . import guide_message as gm
from .approach import Approach, BinArea, LEAD_S, distance_m

BANNER_S = 3.0  # how long a spoken message stays on screen
SAME_PERSON_S = 4.0   # a new track this soon after an announced person was last seen ...
SAME_PERSON_BODY = 0.5  # ... and this close (in body heights) is that person re-numbered by the tracker


def _where(kp):
    """(x, y, body size in px) of a skeleton: centre and height of its visible keypoints, or None."""
    vis = kp[:, 2] > 0.3
    if vis.sum() < 3:
        return None
    xs, ys = kp[vis, 0], kp[vis, 1]
    return float(xs.mean()), float(ys.mean()), float(max(ys.max() - ys.min(), xs.max() - xs.min(), 1.0))


class YoloPoseTracker:
    """frame -> [(track_id, keypoints[17, 3])], people tracked across frames by ByteTrack."""

    def __init__(self, weights: Path, imgsz: int = 640):
        import torch
        from ultralytics import YOLO

        self.model, self.imgsz = YOLO(str(weights)), imgsz
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"

    def __call__(self, frame) -> list[tuple[int, np.ndarray]]:
        r = self.model.track(frame, persist=True, verbose=False, device=self.device, imgsz=self.imgsz, conf=0.3)[0]
        if r.boxes is None or r.boxes.id is None or r.keypoints is None:
            return []
        ids = r.boxes.id.int().cpu().tolist()
        kps = r.keypoints.data.cpu().numpy()
        return list(zip(ids, kps))


class Guide:
    def __init__(self, pose_tracker, watcher, approach: Approach, voice, log_path: Path | None = None,
                 area: BinArea | None = None, homography=None):
        self.pose, self.watcher, self.approach, self.voice = pose_tracker, watcher, approach, voice
        self.log_path, self.area, self.homography = (Path(log_path) if log_path else None), area or approach.area, homography
        self.pending: dict[int, float] = {}       # track_id -> time the trigger fired, answer not ready yet
        self.announced_at: dict[int, tuple] = {}  # track_id -> (last seen, (x, y, body px)) of announced people
        self.said: list[dict] = []
        self.people: list[tuple[int, np.ndarray]] = []
        self.fps = 0.0
        if self.log_path:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def step(self, idx: int, t: float, frame) -> list[dict]:
        """Announcements made at this frame."""
        self.people = self.pose(frame)
        made = []
        for tid, kp in self.people:
            self.watcher.observe(tid, t, frame, kp)
        for tid, kp in self.people:
            if tid in self.announced_at:
                self.announced_at[tid] = (t, _where(kp))
        for tid, kp in self.people:
            if tid not in self.pending and self.watcher.holding(tid, t) and self.approach.update(tid, t, kp):
                if not self._already_told(tid, t, kp):
                    self.pending[tid] = t
            if tid in self.pending:
                a = self._decide(tid, t, kp)
                if a is not None:
                    made.append(self._speak(idx, t, tid, *a))
        for tid in [p for p in self.pending if p not in {i for i, _ in self.people}]:  # out of view: wait, then default
            if t - self.pending[tid] >= LEAD_S:
                made.append(self._speak(idx, t, tid, gm.default_trash(None), "default"))
        return made

    def _already_told(self, tid: int, t: float, kp) -> bool:
        """The tracker gave an announced person a new id (turned around, briefly hidden): do not repeat."""
        here = _where(kp)
        if here is None:
            return False
        visible = {i for i, _ in self.people}
        for other, (seen, there) in self.announced_at.items():  # only people no longer visible: a re-numbered id
            if other != tid and other not in visible and there is not None and t - seen <= SAME_PERSON_S:
                if np.hypot(here[0] - there[0], here[1] - there[1]) <= SAME_PERSON_BODY * max(here[2], there[2]):
                    self.announced_at[tid] = (t, here)
                    return True
        return False

    def _decide(self, tid: int, t: float, kp) -> tuple[dict, str] | None:
        ans = self.watcher.answer(tid, t)
        if ans is not None:
            return ans
        arrived = distance_m(kp, self.area, self.homography) == 0.0
        if self.watcher.failed(tid) or arrived or t - self.pending[tid] >= LEAD_S:
            return gm.default_trash(None), "default"
        return None

    def _speak(self, idx: int, t: float, tid: int, message: dict, source: str) -> dict:
        fired = self.pending.pop(tid, t)
        kp = next((k for i, k in self.people if i == tid), None)
        self.announced_at[tid] = (t, _where(kp) if kp is not None else None)
        text = gm.spoken(message)
        self.voice.speak(text, t)
        a = {"t": round(t, 3), "frame": idx, "track_id": int(tid), "message": message, "spoken": text, "source": source,
             "waited_s": round(t - fired, 3)}
        self.said.append(a)
        if self.log_path:
            with self.log_path.open("a") as f:
                f.write(json.dumps(a) + "\n")
        print(f"[{t:6.2f}s] person {tid}: {text} ({source}, waited {a['waited_s']}s)", file=sys.stderr)
        return a

    def annotate(self, frame, t: float) -> np.ndarray:
        out = frame.copy()
        big = max(out.shape[:2]) / 1920
        lw = max(2, int(4 * big))
        a = self.area
        cv2.rectangle(out, (int(a.x0), int(a.y0)), (int(a.x1), int(a.y1)), (0, 200, 0), lw)
        cv2.putText(out, "bins", (int(a.x0) + 8, int(a.y0) + int(40 * big)), cv2.FONT_HERSHEY_SIMPLEX, 1.1 * big + 0.3, (120, 255, 120), lw)
        for tid, kp in self.people:
            d = distance_m(kp, self.area, self.homography)
            vis = kp[:, 2] > 0.3
            if not vis.any():
                continue
            x, y = int(kp[vis, 0].min()), int(kp[vis, 1].min())
            hold = self.watcher.holding(tid, t)
            label = f"#{tid} {'holding' if hold else '-'} {'' if d is None else f'{d:.1f} m'}"
            cv2.putText(out, label, (x, max(30, y - 12)), cv2.FONT_HERSHEY_SIMPLEX, big + 0.3, (0, 165, 255) if hold else (200, 200, 200), lw)
        recent = [s for s in self.said if 0 <= t - s["t"] <= BANNER_S]
        for k, s in enumerate(recent[-2:]):
            y = out.shape[0] - int((60 + 70 * k) * big) - 20
            cv2.putText(out, s["spoken"], (int(24 * big) + 10, y), cv2.FONT_HERSHEY_SIMPLEX, 1.3 * big + 0.3, (0, 0, 0), lw * 3)
            cv2.putText(out, s["spoken"], (int(24 * big) + 10, y), cv2.FONT_HERSHEY_SIMPLEX, 1.3 * big + 0.3, (80, 255, 80), lw)
        cv2.putText(out, f"{self.fps:.0f} fps", (out.shape[1] - int(200 * big) - 40, int(50 * big) + 20), cv2.FONT_HERSHEY_SIMPLEX,
                    big + 0.3, (255, 255, 255), lw)
        return out

    def run(self, source, on_frame=None) -> list[dict]:
        busy, n = 0.0, 0
        for idx, t, frame in source:
            t0 = time.perf_counter()
            self.step(idx, t, frame)
            busy += time.perf_counter() - t0
            n += 1
            self.fps = n / busy if busy > 0 else 0.0
            if on_frame:
                on_frame(self.annotate(frame, t))
        return self.said
