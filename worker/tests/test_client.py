import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from recyclone_worker.client import HttpSink, flush_outbox

EVENT = {"event_id": "evt_0000000000000001", "x": 1}


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server():
    """A stub /api/events. `status` controls the reply; `seen` records requests."""
    state = {"status": 200, "seen": []}

    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            state["seen"].append((self.path, self.headers.get("Authorization"), json.loads(body)))
            self.send_response(state["status"])
            self.end_headers()
            reply = {"event_id": "x", "status": "created"} if state["status"] < 300 else {"error": "nope"}
            self.wfile.write(json.dumps(reply).encode())

        def log_message(self, *a):
            pass

    httpd = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    state["url"] = f"http://127.0.0.1:{httpd.server_port}"
    yield state
    httpd.shutdown()


def test_posts_with_bearer(server, tmp_path):
    sink = HttpSink(server["url"], "t0k", tmp_path / "outbox.jsonl")
    assert sink.send(EVENT) == "created"
    assert server["seen"] == [("/api/events", "Bearer t0k", EVENT)]


def test_api_down_queues(tmp_path):
    out = tmp_path / "outbox.jsonl"
    sink = HttpSink(f"http://127.0.0.1:{free_port()}", "t", out, timeout_s=0.5)
    assert sink.send(EVENT) == "queued"
    assert [json.loads(l) for l in out.read_text().splitlines()] == [EVENT]


def test_5xx_queues(server, tmp_path):
    sink = HttpSink(server["url"], "t", tmp_path / "outbox.jsonl")
    server["status"] = 503
    assert sink.send(EVENT) == "queued"


def test_4xx_is_recorded_not_crashing(server, tmp_path, capsys):
    """A rejected event is a contract bug: keep it with the reason, warn loudly, keep the demo running."""
    sink = HttpSink(server["url"], "t", tmp_path / "outbox.jsonl")
    server["status"] = 422
    assert sink.send(EVENT) == "rejected"
    rows = [json.loads(l) for l in (tmp_path / "rejected.jsonl").read_text().splitlines()]
    assert rows[0]["event"] == EVENT and "422" in rows[0]["error"]
    assert "REJECTED" in capsys.readouterr().err
    assert not (tmp_path / "outbox.jsonl").exists()


def test_flush_resends_and_clears(server, tmp_path):
    out = tmp_path / "outbox.jsonl"
    down = HttpSink(f"http://127.0.0.1:{free_port()}", "t", out, timeout_s=0.5)
    down.send(EVENT)
    down.send(dict(EVENT, event_id="evt_0000000000000002"))
    up = HttpSink(server["url"], "t", out)
    assert flush_outbox(up) == (2, 0)
    assert out.read_text() == ""


# --- added after review ----------------------------------------------------------------------

def test_garbled_200_is_queued_not_crashing(tmp_path):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers["Content-Length"]))
            self.send_response(200); self.end_headers(); self.wfile.write(b"<html>tunnel page</html>")
        def log_message(self, *a): pass
    httpd = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        sink = HttpSink(f"http://127.0.0.1:{httpd.server_port}", "t", tmp_path / "outbox.jsonl")
        assert sink.send(EVENT) == "queued"
    finally:
        httpd.shutdown()


@pytest.mark.parametrize("code", [401, 404, 429])
def test_config_4xx_is_queued_and_warned(server, tmp_path, capsys, code):
    """Wrong token / wrong URL / rate limit are not the event's fault: keep it for flush, warn loudly."""
    sink = HttpSink(server["url"], "t", tmp_path / "outbox.jsonl")
    server["status"] = code
    assert sink.send(EVENT) == "queued"
    assert str(code) in capsys.readouterr().err
    assert not (tmp_path / "rejected.jsonl").exists()


def test_stats_count_statuses(server, tmp_path):
    sink = HttpSink(server["url"], "t", tmp_path / "outbox.jsonl")
    sink.send(EVENT)
    server["status"] = 422
    sink.send(EVENT)
    assert sink.stats["created"] == 1 and sink.stats["rejected"] == 1
