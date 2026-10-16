"""Test doubles: no model downloads, fully deterministic."""

import numpy as np


class FakeEmbedder:
    """Embeds an image as its normalized mean BGR color: same-colored crops match."""

    def embed(self, image: np.ndarray) -> np.ndarray:
        v = image.reshape(-1, 3).mean(axis=0).astype(np.float32) + 1e-3
        return v / np.linalg.norm(v)


def solid(bgr: tuple[int, int, int], size: int = 32) -> np.ndarray:
    return np.full((size, size, 3), bgr, np.uint8)


RED, BLUE, GREEN = (0, 0, 255), (255, 0, 0), (0, 255, 0)


class ScriptedTracker:
    """Returns preset tracks per frame index: script[frame_idx] -> list[Track]."""

    def __init__(self, script: dict):
        self.script, self.i = script, -1

    def update(self, frame):
        self.i += 1
        return list(self.script.get(self.i, []))


def frames(n: int, size=(720, 1280), color=(0, 0, 255)):
    """A source of n solid frames: yields (frame_idx, offset_s, frame) at 10 fps."""
    import numpy as np
    for i in range(n):
        yield i, i / 10, np.full((*size, 3), color, np.uint8)
