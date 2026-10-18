"""Claude namer: ONE Haiku call per item (catalog pick + generic description + a reason per destination), forced
into a fixed JSON shape through a tool, cached on disk; DeepSeek's name()/describe() interface kept."""

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from recyclone_worker import claude_namer as cn

CROP = np.full((40, 40, 3), 200, np.uint8)
CATALOG = [("item_generic_can", "aluminum can"), ("item_napkin", "paper napkin")]
ANSWER = {"catalog_item_id": None, "confidence": 0.8, "identifiable": True, "name": "plastic fork", "material": "rigid_plastic",
          "form": "fork", "condition": "clean", "hazardous": False,
          "reasons": {"recycling": "cutlery is not a container", "compost": "plastic does not break down",
                      "trash": "plastic cutlery is not accepted in recycling"}}


def fake_post(calls, answer=ANSWER, fail=False, gate=None):
    def post(url, headers, body, timeout):
        if gate is not None:
            gate.wait(2)
        calls.append((url, headers, json.loads(body)))
        if fail:
            raise OSError("down")
        return {"content": [{"type": "tool_use", "name": "report_item", "input": answer}],
                "usage": {"input_tokens": 1800, "output_tokens": 150, "cache_read_input_tokens": 0}}
    return post


def namer(tmp_path, calls, **kw):
    return cn.ClaudeNamer(tmp_path, key="sk-test", catalog=CATALOG, rules="RULES TEXT", post=fake_post(calls, **kw))


def test_one_call_serves_both_name_and_describe(tmp_path):
    calls = []
    n = namer(tmp_path, calls)
    assert n.name([CROP]) == {"catalog_item_id": None, "what": "plastic fork", "material": "rigid_plastic",
                              "brand_visible": None, "confidence": 0.8}
    d = n.describe([CROP])
    assert d["name"] == "plastic fork" and d["identifiable"] is True and d["reasons"]["trash"].startswith("plastic cutlery")
    assert len(calls) == 1


def test_parallel_name_and_describe_still_make_one_request(tmp_path):
    calls, gate = [], threading.Event()
    n = cn.ClaudeNamer(tmp_path, key="sk-test", catalog=CATALOG, rules="R", post=fake_post(calls, gate=gate))
    with ThreadPoolExecutor(2) as pool:
        a, b = pool.submit(n.name, [CROP]), pool.submit(n.describe, [CROP])
        gate.set()
        a.result(), b.result()
    assert len(calls) == 1


def test_request_is_haiku_with_a_forced_tool_cached_system_and_jpeg_images(tmp_path):
    calls = []
    namer(tmp_path, calls).name([CROP, CROP])
    url, headers, body = calls[0]
    assert url == "https://api.anthropic.com/v1/messages"
    assert headers["x-api-key"] == "sk-test" and headers["anthropic-version"] == "2023-06-01"
    assert body["model"] == "claude-haiku-5-5" and body["max_tokens"] <= 600
    assert body["tool_choice"] == {"type": "tool", "name": "report_item"}
    assert body["system"][-1]["cache_control"] == {"type": "ephemeral"}
    assert "RULES TEXT" in body["system"][-1]["text"] and "item_generic_can: aluminum can" in body["system"][-1]["text"]
    images = [c for c in body["messages"][0]["content"] if c["type"] == "image"]
    assert len(images) == 2 and images[0]["source"]["media_type"] == "image/jpeg"


def test_answers_are_cached_on_disk(tmp_path):
    calls = []
    namer(tmp_path, calls).name([CROP])
    again = namer(tmp_path, calls)
    assert again.describe([CROP])["name"] == "plastic fork" and len(calls) == 1 and again.usage["cached"] == 1


def test_an_id_outside_the_catalog_is_never_used(tmp_path):
    calls = []
    n = namer(tmp_path, calls, answer=dict(ANSWER, catalog_item_id="item_made_up"))
    assert n.name([CROP])["catalog_item_id"] is None


def test_errors_give_none_and_are_counted(tmp_path):
    calls = []
    n = namer(tmp_path, calls, fail=True)
    assert n.name([CROP]) is None and n.describe([CROP]) is None and n.usage["errors"] >= 1


def test_cost_estimate_uses_haiku_5_5_prices(tmp_path):
    calls = []
    n = namer(tmp_path, calls)
    n.name([CROP])
    assert abs(n.cost_usd() - (1800 * 0.10 + 150 * 0.50) / 1e6) < 1e-9


def test_key_from_the_config_file(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    f = tmp_path / "anthropic.env"
    f.write_text("ANTHROPIC_API_KEY=sk-ant-x\n")
    assert cn.api_key(f) == "sk-ant-x"
    monkeypatch.setenv("ANTHROPIC_API_KEY", "from-env")
    assert cn.api_key(f) == "from-env"


def test_no_temperature_is_sent_haiku_5_5_rejects_it(tmp_path):
    """17 Oct: HTTP 400 "`temperature` is deprecated for this model." on every call."""
    calls = []
    namer(tmp_path, calls).name([CROP])
    assert "temperature" not in calls[0][2]
