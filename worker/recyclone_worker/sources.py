"""Frame sources. RecordedClipSource now; a LiveCameraSource would yield the same tuples."""

import re
import subprocess
from pathlib import Path

import cv2
import numpy as np

_AVF_LINE = re.compile(r"\[(\d+)\] (.+)$")


def parse_avf_devices(listing: str) -> list[tuple[int, str]]:
    """Video devices from `ffmpeg -f avfoundation -list_devices true -i ""` (stderr)."""
    out, video = [], False
    for line in listing.splitlines():
        if "AVFoundation video devices" in line:
            video = True
        elif "AVFoundation audio devices" in line:
            video = False
        elif video and (m := _AVF_LINE.search(line)):
            out.append((int(m.group(1)), m.group(2).strip()))
    return out


def avf_devices() -> list[tuple[int, str]]:
    r = subprocess.run(["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
                       capture_output=True, text=True, timeout=20)
    return parse_avf_devices(r.stderr)


def pick_avf_device(want: str, devices: list[tuple[int, str]]) -> int | None:
    """"avf:3" -> device 3; "avf:iphone" -> the first device whose name has "iphone" and is not a Desk View camera."""
    if want.isdigit():
        return int(want) if any(i == int(want) for i, _ in devices) else None
    for i, name in devices:
        if want.lower() in name.lower() and "desk view" not in name.lower():
            return i
    return None


class FfmpegCapture:
    """The cv2.VideoCapture calls LiveCameraSource uses (isOpened/read/get/release), reading BGR frames from ffmpeg's
    avfoundation input. Needed for an iPhone through Continuity Camera: macOS lists it to apps that ask for it, and
    OpenCV does not ask, but ffmpeg does."""

    def __init__(self, device: int, width: int = 1280, height: int = 720, fps: int = 30, popen=subprocess.Popen):
        self.w, self.h, self.fps = width, height, fps
        cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-framerate", str(fps),
               "-video_size", f"{width}x{height}", "-i", f"{device}:none", "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
        try:
            self.proc = popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        except OSError:
            self.proc = None

    def isOpened(self) -> bool:  # noqa: N802 - cv2.VideoCapture's name
        return self.proc is not None and self.proc.poll() is None

    def read(self):
        if self.proc is None:
            return False, None
        n, buf = self.w * self.h * 3, b""
        while len(buf) < n:
            part = self.proc.stdout.read(n - len(buf))
            if not part:
                return False, None
            buf += part
        return True, np.frombuffer(buf, np.uint8).reshape(self.h, self.w, 3).copy()

    def get(self, prop):
        return float(self.fps) if prop == cv2.CAP_PROP_FPS else 0.0

    def release(self) -> None:
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except Exception:  # noqa: BLE001
                pass


class RecordedClipSource:
    def __init__(self, path: Path):
        self.path = Path(path)
        cap = cv2.VideoCapture(str(self.path))
        if not cap.isOpened():
            raise FileNotFoundError(f"cannot open video {self.path}")
        self.fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        self.frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        cap.release()

    @property
    def duration_s(self) -> float:
        if self.frame_count <= 0:  # some containers (webm, some phone exports) do not report it
            self.frame_count = sum(1 for _ in self)
        return self.frame_count / self.fps

    def __iter__(self):
        """Yields (frame_idx, offset_s, frame)."""
        cap = cv2.VideoCapture(str(self.path))
        idx = -1
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    return
                idx += 1
                yield idx, idx / self.fps, frame
        finally:
            cap.release()


class LiveCameraSource:
    """A live camera: a device index (built-in webcam 0; an iPhone via Continuity Camera shows up as another index),
    or an RTSP/HTTP URL of a store's IP camera. Yields (frame_idx, seconds since start, frame), wall-clock timed.

    Live sources are read on a background thread that keeps only the LATEST frame (a slow consumer never builds a
    backlog) and reconnects after a dropped read. A file (tests) is read in order and not reconnected."""

    def __init__(self, source: int | str, open_timeout_s: float = 5.0, opener=None, max_reconnects: int | None = None,
                 retry_s: float = 1.0):
        import time

        self.source = int(source) if isinstance(source, str) and source.isdigit() else source
        self._time = time.monotonic
        self.live = isinstance(self.source, int) or (isinstance(self.source, str) and ("://" in self.source or self.source.startswith("avf:")))
        self.max_reconnects = (5 if self.live else 0) if max_reconnects is None else max_reconnects
        self.retry_s = retry_s
        if opener is None and isinstance(self.source, str) and self.source.startswith("avf:"):
            dev = pick_avf_device(self.source[4:], avf_devices())
            if dev is None:
                raise FileNotFoundError(f"no camera matching {self.source} (see `recyclone-worker cameras`)")
            self.live = True
            opener = lambda: FfmpegCapture(dev)  # noqa: E731
        if opener is None:
            if isinstance(self.source, str) and "://" in self.source:
                opener = lambda: cv2.VideoCapture(self.source, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, int(open_timeout_s * 1000)])  # noqa: E731
            else:
                opener = lambda: cv2.VideoCapture(self.source)  # noqa: E731
        self.opener = opener
        self.cap = opener()
        if not self.cap.isOpened():
            raise FileNotFoundError(f"cannot open camera {source}")
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30.0

    def close(self) -> None:
        """Stop reading for good: the camera is released and not reopened."""
        self.closed = True
        self.cap.release()

    def _read_with_reconnect(self):
        """Yields frames until the source is gone for good, reconnecting up to max_reconnects times in a row."""
        import time

        tries = 0
        while True:
            ok, frame = self.cap.read()
            if ok:
                tries = 0
                yield frame
                continue
            self.cap.release()
            if tries >= self.max_reconnects or getattr(self, "closed", False):
                return
            tries += 1
            time.sleep(self.retry_s)
            self.cap = self.opener()

    def __iter__(self):
        import threading

        t0, idx = self._time(), -1
        if not self.live:
            try:
                for frame in self._read_with_reconnect():
                    idx += 1
                    yield idx, self._time() - t0, frame
            finally:
                self.cap.release()
            return
        state = {"frame": None, "n": 0, "done": False}
        cond = threading.Condition()

        def grab():
            try:
                for frame in self._read_with_reconnect():
                    with cond:
                        state["frame"], state["n"] = frame, state["n"] + 1
                        cond.notify()
            finally:
                with cond:
                    state["done"] = True
                    cond.notify()

        threading.Thread(target=grab, daemon=True).start()
        seen = 0
        while True:
            with cond:
                while state["n"] == seen and not state["done"]:
                    cond.wait(timeout=1.0)
                if state["n"] == seen:
                    return
                frame, seen = state["frame"], state["n"]
            idx += 1
            yield idx, self._time() - t0, frame
