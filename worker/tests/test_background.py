import time
from collections import Counter

from recyclone_worker.client import BackgroundSink


class SlowSink:
    def __init__(self, delay=0.2):
        self.delay, self.events, self.stats = delay, [], Counter()

    def send(self, event):
        time.sleep(self.delay)
        self.events.append(event)
        self.stats["created"] += 1
        return "created"


def test_send_does_not_block_frames():
    inner = SlowSink()
    bg = BackgroundSink(inner, retry_every_s=60)
    t0 = time.monotonic()
    for i in range(3):
        assert bg.send({"event_id": i}) == "submitted"
    assert time.monotonic() - t0 < 0.1
    bg.close(timeout_s=5)
    assert [e["event_id"] for e in inner.events] == [0, 1, 2]
    assert bg.stats["created"] == 3


def test_retries_outbox_periodically(monkeypatch):
    import recyclone_worker.client as client
    calls = []
    monkeypatch.setattr(client, "flush_outbox", lambda sink: calls.append(1) or (0, 0))
    inner = SlowSink(delay=0)
    inner.outbox = None
    bg = BackgroundSink(inner, retry_every_s=0.05)
    time.sleep(0.3)
    bg.close(timeout_s=2)
    assert len(calls) >= 2
