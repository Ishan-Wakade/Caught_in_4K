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
