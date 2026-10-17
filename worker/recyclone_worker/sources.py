"""Frame sources. RecordedClipSource now; a LiveCameraSource would yield the same tuples."""

from pathlib import Path

import cv2


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
        self.live = isinstance(self.source, int) or (isinstance(self.source, str) and "://" in self.source)
        self.max_reconnects = (5 if self.live else 0) if max_reconnects is None else max_reconnects
        self.retry_s = retry_s
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
            if tries >= self.max_reconnects:
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
