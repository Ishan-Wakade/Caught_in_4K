"""Presentation and audio export for prerecorded clips; live Guide and Voice are unchanged."""
from pathlib import Path
import subprocess
import cv2
import numpy as np

from . import guide_message as gm
from .guide import Guide, SKELETON_GREEN, SKELETON, BANNER_S

OPENING_COLOR = {"recycle": (255, 155, 30), "trash": (20, 145, 255), "compost": (225, 75, 190)}
BIN_COLOR = {**OPENING_COLOR, "none": (60, 160, 255)}
AREA_COLOR = (255, 190, 40)


class PreparedGuide(Guide):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.prepared = True
        self.bin_layout = None

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
        openings = self.bin_layout.at(t, out.shape[1], out.shape[0]) if self.bin_layout else self.openings
        if openings:  # tight opening outlines; keep the floor/approach region out of the presentation
            from .bin_layout import LABELS

            for o in openings:
                x0, y0, x1, y1 = (int(v) for v in o["box"])
                color = OPENING_COLOR.get(o["bin"], (255, 255, 255))
                cv2.rectangle(out, (x0, y0), (x1, y1), color, max(2, lw // 2), cv2.LINE_AA)
                label = LABELS.get(o["bin"], o["label"])
                thickness = max(1, lw // 2)
                unit = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 1, thickness)[0][0]
                scale = min(0.65 * big + 0.2, max(0.25, (x1 - x0 - 8) / max(1, unit)))
                (tw, th), baseline = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, scale, thickness)
                tx, ty = max(4, min(out.shape[1] - tw - 4, (x0 + x1 - tw) // 2)), max(th + 8, y0 - 9)
                cv2.rectangle(out, (tx - 4, ty - th - 4), (tx + tw + 4, ty + baseline + 2), (20, 20, 20), -1)
                cv2.putText(out, label, (tx, ty), cv2.FONT_HERSHEY_SIMPLEX, scale, color, thickness, cv2.LINE_AA)
        elif self.draw_area and self.bin_layout is None:
            cv2.rectangle(out, (int(a.x0), int(a.y0)), (int(a.x1), int(a.y1)), AREA_COLOR, lw)
            cv2.putText(out, "bins", (int(a.x0) + 8, int(a.y0) + int(40 * big)), cv2.FONT_HERSHEY_SIMPLEX, 1.1 * big + 0.3,
                        AREA_COLOR, lw)
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
        done = [(o["t"], o) for o in self.outcomes.values() if 0 <= t - o["t"] <= BANNER_S]
        recent = [s for s in self.said if 0 <= t - s["t"] <= BANNER_S]
        if done:  # the item went in: what it was, where it should go, and whether it went there
            self._bottom_bar(out, max(done, key=lambda d: d[0])[1]["message"], max(done, key=lambda d: d[0])[1])
        elif recent:  # bottom bar: black, two facts only, large readable text
            self._bottom_bar(out, recent[-1]["message"])
        speed = "PREPARED" if self.prepared else f"{self.fps:.0f} fps"
        cv2.putText(out, speed, (out.shape[1] - int(250 * big) - 40, int(50 * big) + 20), cv2.FONT_HERSHEY_SIMPLEX,
                    big + 0.3, (255, 255, 255), lw)
        return out

    @classmethod
    def _bar_rows(cls, message: dict, outcome: dict | None, width: int) -> list[list[tuple[str, tuple]]]:
        """The bar's lines: [("Item: ...", white), ("Bin: ...", bin color)] and, once the item went in,
        [("Thrown in: ...", white), ("CORRECT" | "WRONG BIN", green | red)]; each pair on one line when it fits."""
        item, bin_label = gm.item_and_bin(message)
        pairs = [[(f"Item: {item}", (255, 255, 255)), (f"Bin: {bin_label}", BIN_COLOR.get(message.get("bin"), (255, 255, 255)))]]
        from .bins import outcome_text

        verdict_parts = outcome_text(message, outcome) if outcome else None
        if verdict_parts:
            where, verdict, ok = verdict_parts
            pairs.append([(where, (255, 255, 255)), (verdict, (90, 230, 90) if ok else (60, 60, 255))])
        scale, thick, _, margin = cls._bar_layout(width)
        gap = int(width * 0.05)
        rows = []
        for pair in pairs:
            widths = [cv2.getTextSize(t, cls.FONT, scale, thick)[0][0] for t, _ in pair]
            rows += [pair] if sum(widths) + gap <= width - 2 * margin else [[p] for p in pair]
        return rows


def mix_audio(video_in: Path, video_out: Path, spoken: list[tuple[float, str, Path | None]]) -> None:
    """Put each spoken clip into the video's audio at its time (one ffmpeg call); no speech: copy the video."""
    clips = [(t, f) for t, _, f in spoken if f is not None and Path(f).exists()]
    if not clips:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(video_in), "-c", "copy", str(video_out)], check=True)
        return
    import cv2

    cap = cv2.VideoCapture(str(video_in))
    frames, fps = cap.get(cv2.CAP_PROP_FRAME_COUNT), cap.get(cv2.CAP_PROP_FPS)
    cap.release()
    if frames <= 0 or fps <= 0:
        raise ValueError("cannot determine rendered video's duration")
    duration = frames / fps
    cmd = ["ffmpeg", "-loglevel", "error", "-y", "-i", str(video_in)]
    for _, f in clips:
        cmd += ["-i", str(f)]
    parts = [f"[{k + 1}:a]adelay={round(t * 1000)}|{round(t * 1000)}[a{k}]" for k, (t, _) in enumerate(clips)]
    # Bound padded audio explicitly: some ffmpeg versions never stop apad with -shortest + copied video.
    mix = "".join(f"[a{k}]" for k in range(len(clips))) + f"amix=inputs={len(clips)}:normalize=0,apad[aout]"
    cmd += ["-filter_complex", ";".join(parts + [mix]), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac",
            "-t", str(duration), str(video_out)]
    subprocess.run(cmd, check=True)
