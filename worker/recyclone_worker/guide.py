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
from .approach import COOLDOWN_S, Approach, BinArea, LEAD_S, distance_m

BANNER_S = 5.0  # how long the bottom bar shows the last announcement
SKELETON_GREEN = (60, 220, 60)  # BGR
BIN_COLOR = {"recycle": (255, 190, 80), "compost": (90, 230, 90), "trash": (220, 220, 220), "none": (60, 160, 255)}  # BGR
SAME_PERSON_S = 4.0   # a new track this soon after an announced person was last seen ...
SAME_PERSON_BODY = 0.5  # ... and this close (in body heights) is that person re-numbered by the tracker
ARRIVAL_GRACE_S = 0.6   # at the bins with no answer yet: wait this long for CLIP's votes before saying trash
LLM_WAIT_S = 4.0        # ... but an LLM answer already on its way is waited for this long after the trigger
SKELETON = [(5, 7), (7, 9), (6, 8), (8, 10), (5, 6), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16),
            (0, 5), (0, 6)]
FORGET_AFTER_S = COOLDOWN_S + 2.0  # people unseen this long are dropped (a store camera runs all day)


def _where(kp):
    """(x, y, body size in px) of a skeleton: centre and height of its visible keypoints, or None."""
    vis = kp[:, 2] > 0.3
    if vis.sum() < 3:
        return None
    xs, ys = kp[vis, 0], kp[vis, 1]
    return float(xs.mean()), float(ys.mean()), float(max(ys.max() - ys.min(), xs.max() - xs.min(), 1.0))


def list_cameras(max_index: int = 6, opener=None) -> list[tuple[int, int, int]]:
    """(index, width, height) of every camera that opens and gives a frame: the built-in webcam, an iPhone through
    Continuity Camera, a USB camera."""
    opener = opener or cv2.VideoCapture
    found = []
    for i in range(max_index):
        cap = opener(i)
        try:
            if cap.isOpened():
                ok, frame = cap.read()
                if ok and frame is not None:
                    found.append((i, int(frame.shape[1]), int(frame.shape[0])))
        finally:
            cap.release()
    return found


class YoloPoseTracker:
    """frame -> [(track_id, keypoints[17, 3])], people tracked across frames by ByteTrack."""

    def __init__(self, weights: Path, imgsz: int = 640):
        import torch
        from ultralytics import YOLO

        self.model, self.imgsz = YOLO(str(weights)), imgsz
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"

    def __call__(self, frame) -> list[tuple[int, np.ndarray]]:
        r = self.model.track(frame, persist=True, verbose=False, device=self.device, imgsz=self.imgsz, conf=0.3,
                             tracker="bytetrack.yaml")[0]  # fixed camera: no BoT-SORT camera-motion step
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
        self.first_seen: dict[int, float] = {}
        self.last_seen: dict[int, float] = {}
        self.warmed: set[int] = set()
        self.said: list[dict] = []
        self.people: list[tuple[int, np.ndarray]] = []
        self.fps = 0.0
        if self.log_path:
            self.log_path.parent.mkdir(parents=True, exist_ok=True)

    def step(self, idx: int, t: float, frame) -> list[dict]:
        """Announcements made at this frame."""
        self.people = self.pose(frame)
        made = []
        if hasattr(self.watcher, "set_heads"):  # every person's head is blanked in crops that leave the device
            from .guide_identify import head_box

            self.watcher.set_heads([head_box(kp) for _, kp in self.people])
        for tid, kp in self.people:
            self.first_seen.setdefault(tid, t)
            self.last_seen[tid] = t
            self.watcher.observe(tid, t, frame, kp)
            if tid not in self.warmed and hasattr(self.voice, "warm"):
                ans = self.watcher.answer(tid, t)
                if ans is not None:  # render the sentence now, before the person arrives
                    self.voice.warm(gm.spoken(ans[0]))
                    self.warmed.add(tid)
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
        for tid in [p for p in self.pending if p not in {i for i, _ in self.people}]:  # out of view: answer, or default
            ans = self.watcher.answer(tid, t)
            if ans is not None:
                made.append(self._speak(idx, t, tid, *ans))
            elif t - self.pending[tid] >= (LLM_WAIT_S if self._llm_on_its_way(tid) else LEAD_S):
                made.append(self._speak(idx, t, tid, gm.default_trash(None), "default"))
        self._forget_gone(t)
        return made

    def _forget_gone(self, t: float) -> None:
        for tid in [i for i, seen in self.last_seen.items() if t - seen > FORGET_AFTER_S and i not in self.pending]:
            self.approach.left(tid, t)
            for d in (self.approach.hist, self.approach.fired, self.approach.last_near):
                d.pop(tid, None)
            if hasattr(self.watcher, "forget"):
                self.watcher.forget(tid)
            for d in (self.last_seen, self.first_seen):
                d.pop(tid, None)
            self.warmed.discard(tid)
        for tid in [i for i, (seen, _) in self.announced_at.items() if t - seen > max(SAME_PERSON_S, FORGET_AFTER_S)]:
            self.announced_at.pop(tid, None)

    def _already_told(self, tid: int, t: float, kp) -> bool:
        """The tracker gave an announced person a new id (turned around, briefly hidden): do not repeat."""
        here = _where(kp)
        if here is None:
            return False
        visible = {i for i, _ in self.people}
        born = self.first_seen.get(tid, t)
        for other, (seen, there) in self.announced_at.items():
            # a re-numbered id appears AFTER the old one vanished; someone seen alongside it is another person
            if other != tid and other not in visible and there is not None and t - seen <= SAME_PERSON_S and born > seen:
                if np.hypot(here[0] - there[0], here[1] - there[1]) <= SAME_PERSON_BODY * max(here[2], there[2]):
                    self.announced_at[tid] = (t, here)
                    return True
        return False

    def _decide(self, tid: int, t: float, kp) -> tuple[dict, str] | None:
        ans = self.watcher.answer(tid, t)
        if ans is not None:
            return ans
        waited = t - self.pending[tid]
        if self._llm_on_its_way(tid) and waited < LLM_WAIT_S:
            return None
        arrived = distance_m(kp, self.area, self.homography) == 0.0 and waited >= ARRIVAL_GRACE_S
        if self.watcher.failed(tid) or arrived or waited >= LEAD_S:
            return gm.default_trash(None), "default"
        return None

    def _llm_on_its_way(self, tid: int) -> bool:
        pending = getattr(self.watcher, "pending", None)
        return bool(pending and pending(tid))

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

    def annotate(self, frame, t: float, cctv: str | None = None) -> np.ndarray:
        out = frame.copy()
        if cctv:  # a surveillance-camera look for the demo video: camera name and a running clock, top left
            import datetime

            big0 = max(out.shape[:2]) / 1920
            stamp = f"{cctv}  {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
            for color, width in (((0, 0, 0), 6), ((255, 255, 255), 2)):
                cv2.putText(out, stamp, (int(24 * big0) + 10, int(60 * big0) + 30), cv2.FONT_HERSHEY_SIMPLEX, 1.1 * big0 + 0.4,
                            color, width)
            cv2.circle(out, (out.shape[1] - int(60 * big0) - 30, int(110 * big0) + 30), int(12 * big0) + 6, (0, 0, 255), -1)
        big = max(out.shape[:2]) / 1920
        lw = max(2, int(4 * big))
        a = self.area
        cv2.rectangle(out, (int(a.x0), int(a.y0)), (int(a.x1), int(a.y1)), (0, 200, 0), lw)
        cv2.putText(out, "bins", (int(a.x0) + 8, int(a.y0) + int(40 * big)), cv2.FONT_HERSHEY_SIMPLEX, 1.1 * big + 0.3, (120, 255, 120), lw)
        for tid, kp in self.people:
            vis = kp[:, 2] > 0.3
            if not vis.any():
                continue
            bone, joint = max(2, lw // 2), max(3, lw)  # thin but visible (team, 17 Oct): same green, dark-rimmed joints
            for a_, b_ in SKELETON:  # YOLO's skeleton
                if vis[a_] and vis[b_]:
                    cv2.line(out, (int(kp[a_, 0]), int(kp[a_, 1])), (int(kp[b_, 0]), int(kp[b_, 1])), SKELETON_GREEN,
                             bone, cv2.LINE_AA)
            for j in np.flatnonzero(vis):
                cv2.circle(out, (int(kp[j, 0]), int(kp[j, 1])), joint + 1, (20, 90, 20), -1, cv2.LINE_AA)
                cv2.circle(out, (int(kp[j, 0]), int(kp[j, 1])), joint, SKELETON_GREEN, -1, cv2.LINE_AA)
            if not self.watcher.holding(tid, t):
                continue
            box = self._item_box(tid, t, kp, out.shape)
            if box is None:
                continue
            x0, y0, x1, y1 = (int(v) for v in box)
            cv2.rectangle(out, (x0, y0), (x1, y1), (0, 0, 0), lw * 2)  # the item, in black
            ans = self.watcher.answer(tid, t)
            if ans is not None:  # its name right on top of the box: black, with a thin light edge to stay readable
                item, _ = gm.item_and_bin(ans[0])
                org, scale = (x0, max(int(30 * big) + 10, y0 - int(12 * big) - 6)), 1.1 * big + 0.35
                cv2.putText(out, item, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), lw * 2 + 2, cv2.LINE_AA)
                cv2.putText(out, item, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), lw, cv2.LINE_AA)
        recent = [s for s in self.said if 0 <= t - s["t"] <= BANNER_S]
        if recent:  # bottom bar: black, two facts only, large readable text
            self._bottom_bar(out, recent[-1]["message"])
        cv2.putText(out, f"{self.fps:.0f} fps", (out.shape[1] - int(200 * big) - 40, int(50 * big) + 20), cv2.FONT_HERSHEY_SIMPLEX,
                    big + 0.3, (255, 255, 255), lw)
        return out

    @staticmethod
    def _bottom_bar(out, message: dict) -> None:
        """"Item: <item>" in white and "Bin: <bin>" in the bin's color on black, side by side when they fit at a
        readable size, otherwise on two lines (portrait phone video); never cut off at the edge."""
        item, bin_label = gm.item_and_bin(message)
        h, w = out.shape[:2]
        font, left, right = cv2.FONT_HERSHEY_SIMPLEX, f"Item: {item}", f"Bin: {bin_label}"
        margin, gap = int(w * 0.03) + 4, int(w * 0.05)
        line_h = max(44, int(min(h, w * 1.6) * 0.06))
        scale, thick = line_h / 44, max(2, line_h // 20)

        def width(text, sc):
            return cv2.getTextSize(text, font, sc, thick)[0][0]

        one_line = width(left, scale) + gap + width(right, scale) <= w - 2 * margin
        if not one_line:  # two lines; shrink only if a single line is still too long
            scale = min(scale, (w - 2 * margin) / max(width(left, 1.0), width(right, 1.0)))
        rows = 1 if one_line else 2
        bar_h = int(line_h * (1.5 if rows == 1 else 2.6))
        out[h - bar_h:] = 0
        color = BIN_COLOR.get(message.get("bin"), (255, 255, 255))
        if one_line:
            base = h - bar_h // 2 + line_h // 3
            cv2.putText(out, left, (margin, base), font, scale, (255, 255, 255), thick, cv2.LINE_AA)
            cv2.putText(out, right, (margin + width(left, scale) + gap, base), font, scale, color, thick, cv2.LINE_AA)
        else:
            top = h - bar_h
            cv2.putText(out, left, (margin, top + int(line_h * 1.1)), font, scale, (255, 255, 255), thick, cv2.LINE_AA)
            cv2.putText(out, right, (margin, top + int(line_h * 2.25)), font, scale, color, thick, cv2.LINE_AA)

    def _item_box(self, tid: int, t: float, kp, shape):
        """The hand box holding the item (from the watcher), else both hand boxes together."""
        box = self.watcher.item_box(tid, t) if hasattr(self.watcher, "item_box") else None
        if box is not None:
            return box
        from .items import hand_box

        boxes = [b for b in (hand_box(kp, s, shape[1], shape[0]) for s in ("L", "R")) if b is not None]
        if not boxes:
            return None
        return min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)

    def run(self, source, on_frame=None, cctv: str | None = None) -> list[dict]:
        busy, n = 0.0, 0
        for idx, t, frame in source:
            t0 = time.perf_counter()
            self.step(idx, t, frame)
            busy += time.perf_counter() - t0
            n += 1
            self.fps = n / busy if busy > 0 else 0.0
            if on_frame:
                on_frame(self.annotate(frame, t, cctv))
        return self.said
