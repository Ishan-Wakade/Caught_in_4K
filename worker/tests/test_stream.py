import socket
import urllib.error
import urllib.request

import numpy as np
import pytest

from recyclone_worker.stream import StreamServer


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def server(tmp_path):
    (tmp_path / "clip").mkdir()
    (tmp_path / "clip" / "1_entry.jpg").write_bytes(b"\xff\xd8fake")
    srv = StreamServer(free_port(), tmp_path)
    srv.start()
    yield srv
    srv.stop()


def test_stream_serves_latest_frame(server):
    server.publish(np.zeros((48, 64, 3), np.uint8))
    with urllib.request.urlopen(f"http://127.0.0.1:{server.port}/stream.mjpg", timeout=3) as r:
        assert r.headers["Content-Type"].startswith("multipart/x-mixed-replace")
        chunk = r.read(200)
    assert b"--frame" in chunk and b"\xff\xd8" in chunk


def test_serves_evidence(server):
    with urllib.request.urlopen(f"http://127.0.0.1:{server.port}/evidence/clip/1_entry.jpg", timeout=3) as r:
        assert r.read().startswith(b"\xff\xd8")


@pytest.mark.parametrize("path", ["/evidence/../pyproject.toml", "/evidence/%2e%2e/pyproject.toml", "/evidence/clip/missing.jpg"])
def test_evidence_traversal_blocked(server, path):
    with pytest.raises(urllib.error.HTTPError) as e:
        urllib.request.urlopen(f"http://127.0.0.1:{server.port}{path}", timeout=3)
    assert e.value.code == 404
