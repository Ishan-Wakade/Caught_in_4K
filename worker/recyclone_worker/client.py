"""Deliver events to core's POST /api/events without ever silently losing one.

- Unreachable, timeout, 5xx, a garbled reply, or a 4xx that is about configuration rather than the
  event (401 wrong token, 404 wrong URL, 408, 429): the event goes to the outbox and is retried.
  Retrying is safe because event IDs are deterministic and core keeps the first copy of an ID.
- 400 / 413 / 422 mean the event itself is wrong (a contract bug): retrying cannot help, so it is
  written to rejected.jsonl with core's reason and reported on stderr.
- Nothing here raises into the pipeline: a crash would end the live demo.
"""

import json
import queue
import sys
import threading
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Protocol

from .events import dumps_event

EVENT_IS_WRONG = {400, 413, 422}


class EventSink(Protocol):
    stats: Counter

    def send(self, event: dict) -> str:
        """Returns "created", "duplicate", "queued", "rejected", or "submitted" (background)."""
        ...


class MemorySink:
    def __init__(self) -> None:
        self.events: list[dict] = []
        self.stats: Counter = Counter()

    def send(self, event: dict) -> str:
        self.events.append(event)
        self.stats["created"] += 1
        return "created"


class HttpSink:
    def __init__(self, api_base: str, token: str, outbox: Path, timeout_s: float = 3.0):
        self.url = api_base.rstrip("/") + "/api/events"
        self.token, self.outbox, self.timeout_s = token, Path(outbox), timeout_s
        self.rejected = self.outbox.with_name("rejected.jsonl")
        self.stats: Counter = Counter()
        self._lock = threading.Lock()

    def _post(self, event: dict) -> str:
        req = urllib.request.Request(
            self.url,
            data=dumps_event(event).encode(),
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self.token}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            status = json.loads(resp.read()).get("status")
        if status not in ("created", "duplicate"):
            raise ValueError(f"unexpected reply status {status!r}")
        return status

    def try_send(self, event: dict) -> str | None:
        """The API's status, "rejected" if the event itself is wrong, or None to retry later."""
        try:
            return self._post(event)
        except urllib.error.HTTPError as e:
            error = f"HTTP {e.code} {e.read().decode(errors='replace')[:500]}"
            if e.code in EVENT_IS_WRONG:
                self._append(self.rejected, json.dumps({"event": event, "error": error}, allow_nan=False))
                print(f"REJECTED by core: {event.get('event_id')}: {error}", file=sys.stderr)
                return "rejected"
            if e.code < 500:
                print(f"WARNING: core answered {error}; check API_BASE_URL / WORKER_INGEST_TOKEN. Queued for flush.", file=sys.stderr)
            return None
        except Exception as e:  # noqa: BLE001 - unreachable, timeout, TLS, truncated or non-JSON reply
            print(f"WARNING: could not deliver {event.get('event_id')} ({type(e).__name__}); queued for retry", file=sys.stderr)
            return None

    def send(self, event: dict) -> str:
        status = self.try_send(event)
        if status is None:
            self._append(self.outbox, dumps_event(event))
            status = "queued"
        self.stats[status] += 1
        return status

    def _append(self, path: Path, line: str) -> None:
        with self._lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a") as f:
                f.write(line + "\n")


def flush_outbox(sink: HttpSink) -> tuple[int, int]:
    """Resend queued events. Returns (sent, still_queued); the outbox keeps only the failures.

    Do not run the `flush` command while a `run` is posting: a running worker retries by itself.
    """
    if sink.outbox is None or not sink.outbox.exists():
        return 0, 0
    with sink._lock:
        lines = [l for l in sink.outbox.read_text().splitlines() if l.strip()]
        sink.outbox.write_text("")
    failed = []
    for line in lines:
        status = sink.try_send(json.loads(line))
        if status is None:
            failed.append(line)
        else:
            sink.stats[status] += 1
            sink.stats["queued"] -= 1
    for line in failed:
        sink._append(sink.outbox, line)
    return len(lines) - len(failed), len(failed)


class BackgroundSink:
    """Sends from a background thread so a slow API never freezes the video, and retries the
    outbox every `retry_every_s` so events queued during an outage reach the stage by themselves."""

    def __init__(self, inner, retry_every_s: float = 5.0):
        self.inner, self.retry_every_s = inner, retry_every_s
        self._queue: queue.Queue = queue.Queue()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    @property
    def stats(self) -> Counter:
        return self.inner.stats

    def send(self, event: dict) -> str:
        self._queue.put(event)
        return "submitted"

    def _loop(self) -> None:
        while not (self._stop.is_set() and self._queue.empty()):
            try:
                event = self._queue.get(timeout=self.retry_every_s)
            except queue.Empty:
                self._retry()
                continue
            try:
                self.inner.send(event)
            except Exception as e:  # noqa: BLE001 - never let the sender thread die
                print(f"ERROR sending {event.get('event_id')}: {e}", file=sys.stderr)

    def _retry(self) -> None:
        if hasattr(self.inner, "outbox"):  # only HttpSink-like sinks have something to retry
            flush_outbox(self.inner)

    def close(self, timeout_s: float = 30.0) -> None:
        """Deliver what is queued, then one last outbox retry."""
        self._stop.set()
        self._thread.join(timeout_s)
        if self._thread.is_alive():
            print(f"WARNING: {self._queue.qsize()} event(s) still unsent at shutdown", file=sys.stderr)
        else:
            self._retry()
