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
    or an RTSP/HTTP URL of a store's IP camera. Yields (frame_idx, seconds since start, frame), wall-clock timed."""

    def __init__(self, source: int | str, open_timeout_s: float = 5.0):
        import time

        self.source = int(source) if isinstance(source, str) and source.isdigit() else source
        self._time = time.monotonic
        if isinstance(self.source, str) and "://" in self.source:
            self.cap = cv2.VideoCapture(self.source, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, int(open_timeout_s * 1000)])
        else:
            self.cap = cv2.VideoCapture(self.source)
        if not self.cap.isOpened():
            raise FileNotFoundError(f"cannot open camera {source}")
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30.0

    def __iter__(self):
        t0, idx = self._time(), -1
        try:
            while True:
                ok, frame = self.cap.read()
                if not ok:
                    return
                idx += 1
                yield idx, self._time() - t0, frame
        finally:
            self.cap.release()
