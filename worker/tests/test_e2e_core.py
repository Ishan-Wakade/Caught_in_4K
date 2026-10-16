"""End-to-end rehearsal: the worker's real HTTP client against I's real core (tools/rehearsal).

Skipped when pnpm/node are not installed. Demo profile, in-memory, mock messenger.
"""

import json
import os
import shutil
import socket
import subprocess
import time
import urllib.request
from pathlib import Path

import pytest

from recyclone_worker import cli

REPO = Path(__file__).resolve().parents[2]
pytestmark = pytest.mark.skipif(shutil.which("pnpm") is None or not (REPO / "packages/core").exists(),
                                reason="needs pnpm and packages/core")


@pytest.fixture
def core_url():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = dict(os.environ, REHEARSAL_PORT=str(port), WORKER_INGEST_TOKEN="e2e-token")
    proc = subprocess.Popen(["pnpm", "--silent", "--filter", "@recyclone/rehearsal", "start"], cwd=REPO, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            urllib.request.urlopen(url + "/api/bins", timeout=1)
            break
        except Exception:
            if proc.poll() is not None:
                pytest.fail("rehearsal server exited: " + proc.stdout.read())
            time.sleep(0.2)
    yield url
    proc.terminate()
    proc.wait(10)


def get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read())


def test_synthetic_events_drive_alerts_in_real_core(core_url, monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("API_BASE_URL", core_url)
    monkeypatch.setenv("WORKER_INGEST_TOKEN", "e2e-token")
    monkeypatch.setattr(cli, "OUTBOX", tmp_path / "outbox.jsonl")
    synthetic = REPO / "contracts/fixtures/synthetic-events.jsonl"

    assert cli.main(["replay-labeled", "--file", str(synthetic), "--no-wait"]) == 0
    assert "created 11" in capsys.readouterr().err

    types = [f["type"] for f in get(core_url + "/api/feed")["items"]]
    assert types.count("disposal") == 11
    assert "alert_opened" in types and "message_sent" in types   # cup score fell below the demo threshold
    assert "review_queued" in types                              # unbranded cup with a weak logo guess
    trash = next(b for b in get(core_url + "/api/bins") if b["bin_id"] == "bin_patio_trash")
    assert trash["estimated_fullness"] >= 0.8                   # the clamshell filled it

    assert cli.main(["replay-labeled", "--file", str(synthetic), "--no-wait"]) == 0
    err = capsys.readouterr().err
    assert "duplicate 11" in err and "demo/reset" in err         # rehearsal without reset is caught
