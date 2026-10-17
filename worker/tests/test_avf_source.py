"""iPhone via Continuity Camera: macOS sees it, OpenCV does not list it; ffmpeg's avfoundation input does."""

import numpy as np

from recyclone_worker import sources

LISTING = """[AVFoundation indev @ 0x1] AVFoundation video devices:
[AVFoundation indev @ 0x1] [0] MacBook Air Camera
[AVFoundation indev @ 0x1] [1] MacBook Air Desk View Camera
[AVFoundation indev @ 0x1] [2] Eymen’s iPhone Desk View Camera
[AVFoundation indev @ 0x1] [3] Eymen’s iPhone Camera
[AVFoundation indev @ 0x1] AVFoundation audio devices:
[AVFoundation indev @ 0x1] [0] MacBook Air Microphone
"""


def test_lists_only_video_devices():
    assert sources.parse_avf_devices(LISTING) == [
        (0, "MacBook Air Camera"), (1, "MacBook Air Desk View Camera"),
        (2, "Eymen’s iPhone Desk View Camera"), (3, "Eymen’s iPhone Camera")]


def test_avf_iphone_picks_the_iphone_camera_not_desk_view():
    devs = sources.parse_avf_devices(LISTING)
    assert sources.pick_avf_device("iphone", devs) == 3
    assert sources.pick_avf_device("3", devs) == 3
    assert sources.pick_avf_device("macbook", devs) == 0
    assert sources.pick_avf_device("android", devs) is None


class FakePipe:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def read(self, n):
        out = self.data[self.pos:self.pos + n]
        self.pos += n
        return out


class FakeProc:
    def __init__(self, data):
        self.stdout, self.killed = FakePipe(data), False

    def poll(self):
        return None

    def terminate(self):
        self.killed = True

    def wait(self, timeout=None):
        return 0


def test_ffmpeg_capture_reads_whole_bgr_frames_and_stops_on_a_short_read():
    w, h = 4, 2
    frame = np.arange(w * h * 3, dtype=np.uint8)
    proc = FakeProc(frame.tobytes() * 2 + b"\x00" * 5)
    cap = sources.FfmpegCapture(3, w, h, 30, popen=lambda cmd, **kw: proc)
    assert cap.isOpened()
    ok, f = cap.read()
    assert ok and f.shape == (h, w, 3) and (f.reshape(-1) == frame).all()
    assert cap.read()[0] is True
    assert cap.read() == (False, None)
    cap.release()
    assert proc.killed


def test_closing_a_live_source_does_not_reopen_the_camera():
    """The bin-box picker took one frame and left its camera reader running (and reconnecting) for the whole session."""
    opened = []

    class Cap:
        def __init__(self):
            self.open = True

        def isOpened(self):
            return self.open

        def read(self):
            return (True, np.zeros((2, 2, 3), np.uint8)) if self.open else (False, None)

        def get(self, prop):
            return 30.0

        def release(self):
            self.open = False

    def opener():
        opened.append(Cap())
        return opened[-1]

    src = sources.LiveCameraSource(0, opener=opener, retry_s=0.01)
    next(iter(src))
    src.close()
    import time
    time.sleep(0.2)
    assert len(opened) == 1 and not opened[0].open
