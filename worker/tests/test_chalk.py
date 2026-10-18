"""Gateway wire protocols, isolated caches, safe traces, and explicit configuration failures."""

import json

import numpy as np
import pytest

from recyclone_worker import chalk, claude_namer, cli, generic, namer
from recyclone_worker.prepared_providers import ClaudeNamer, DeepSeekNamer, BinAdvisor

CROP = np.full((40, 40, 3), 200, np.uint8)


def gateway(post):
    return chalk.ChalkGateway("router-secret", "env-test", {"claude": "chalk/vision", "deepseek": "deep/vision",
                                                          "jev": "typed/jev"}, post=post)


@pytest.mark.parametrize("url,role,path", [
    (claude_namer.API_URL, "claude", "/v1/messages"),
    (namer.API_URL, "deepseek", "/chat/completions"),
    ("https://api.typesafe.ai/v1/systemone", "jev", "/alpha/decisions"),
])
def test_native_routing_does_not_forward_provider_credentials(url, role, path):
    calls = []

    def post(u, h, b, t):
        calls.append((u, h, json.loads(b)))
        return {"usage": {"input_tokens": 4, "other": "private"}}

    g = gateway(post)
    g.post(url, {"x-api-key": "provider-secret", "Authorization": "Bearer provider-secret"},
           json.dumps({"model": "upstream", "messages": ["item-crop-placeholder"]}).encode(), 30)
    u, h, b = calls[0]
    assert u == chalk.BASE_URL + path and b["model"] == g.models[role]
    assert b["messages"] == ["item-crop-placeholder"]
    assert h["Authorization"] == "Bearer router-secret" and h["X-Chalk-Env-Id"] == "env-test"
    assert "provider-secret" not in json.dumps(calls)
    assert (h.get("anthropic-version") == "2023-06-01") == (role == "claude")
    report = g.report()
    assert report["requests"] == report["successful_requests"] == 1
    assert report["calls"][0]["usage"] == {"input_tokens": 4}
    assert all(s not in json.dumps(report) for s in ["router-secret", "private", "item-crop-placeholder"])


def test_gateway_error_has_no_direct_fallback_or_sensitive_exception_text():
    calls = []

    def failed(*args):
        calls.append(args)
        raise OSError("router-secret; private response")

    g = gateway(failed)
    with pytest.raises(OSError):
        g.jev("private-description")
    report = g.report()
    assert len(calls) == report["requests"] == 1 and report["successful_requests"] == 0
    assert report["calls"][0]["error_type"] == "OSError"
    assert "private" not in json.dumps(report) and "router-secret" not in json.dumps(report)


def test_model_and_environment_partition_caches_without_key_material():
    a = gateway(None)
    b = chalk.ChalkGateway("another-key", a.environment, a.models)
    assert a.namespace == b.namespace
    assert a.namespace != chalk.ChalkGateway("router-secret", "other-env", a.models).namespace
    assert a.namespace != chalk.ChalkGateway("router-secret", a.environment, {"jev": "new-model"}).namespace


def test_claude_gateway_works_without_provider_key_and_caches_separately(tmp_path):
    from test_claude_namer import ANSWER, CATALOG

    calls = []

    def post(*args):
        calls.append(args)
        return {"content": [{"type": "text", "text": json.dumps(ANSWER)}]}

    g = gateway(post)
    n = ClaudeNamer(tmp_path, key="", catalog=CATALOG, gateway=g)
    assert n.available
    assert n.describe([CROP])["name"] == "plastic fork"
    n.name([CROP])
    again = ClaudeNamer(tmp_path, key="", catalog=CATALOG, gateway=g)
    assert again.describe([CROP])["name"] == "plastic fork"
    assert again.usage["cached"] == 1 and len(calls) == 1 and g.report()["requests"] == 1
    assert not list(tmp_path.glob("*.json"))  # cannot be mistaken for an old direct-provider answer


def test_deepseek_uses_gateway_without_direct_network_or_provider_key(tmp_path, monkeypatch):
    calls = []

    def post(*args):
        calls.append(args)
        return {"choices": [{"message": {"content": json.dumps({"catalog_item_id": None, "what": "fork",
                                                                  "confidence": 0.8})}}]}

    monkeypatch.setattr(namer.urllib.request, "urlopen", lambda *a, **k: pytest.fail("direct request"))
    n = DeepSeekNamer(tmp_path, use_key_file=False, gateway=gateway(post))
    assert n.available and n.name([CROP])["what"] == "fork"
    assert len(calls) == 1 and json.loads(calls[0][2])["model"] == "deep/vision"
    n.name([CROP])
    assert n.usage["cached"] == 1 and len(calls) == 1


def test_jev_gateway_keeps_typed_question_rules_and_local_cache(tmp_path):
    from test_generic import MASK

    rules = tmp_path / "rules.md"
    rules.write_text("Masks belong in trash.")
    calls = []

    def post(u, h, b, t):
        calls.append(json.loads(b))
        return {"answers": {"answer": {"choice": "trash", "confidence": 0.9}}}

    g = gateway(post)
    adv = BinAdvisor(rules, tmp_path / "types.json", gateway=g)
    assert adv.available and adv.suggest(generic.generic_type(MASK))["suggested_destination"] == "trash"
    assert calls[0]["questions"]["answer"]["criteria"] == generic.DESTINATIONS
    assert json.loads(calls[0]["state"])["local_rules"] == rules.read_text()
    adv.suggest(generic.generic_type(MASK))
    assert adv.usage["cached"] == 1 and len(calls) == 1


def test_config_reads_external_file_with_environment_override(tmp_path, monkeypatch):
    p = tmp_path / "chalk.env"
    p.write_text("CHALK_ROUTER_API_KEY=secret\nCHALK_ENVIRONMENT_ID=env\nCHALK_CLAUDE_MODEL=old\nCHALK_JEV_MODEL=typed/jev\n")
    monkeypatch.setenv("CHALK_CLAUDE_MODEL", "chalk/new")
    g = chalk.ChalkGateway.from_env("claude", p)
    assert g.models == {"claude": "chalk/new", "jev": "typed/jev"}


@pytest.mark.parametrize("args", [[], ["--prepared", "--area", "auto"], ["--prepared", "--namer", "clip"],
                                 ["--prepared", "--item", "item_napkin"]])
def test_invalid_chalk_mode_fails_before_video_or_model_initialization(args, capsys):
    assert cli.main(["guide", "--source", "does-not-exist.mov", "--area", "1,1,10,10", "--chalk", *args]) == 2
    assert "--chalk" in capsys.readouterr().err


def test_missing_config_fails_before_loading_video(tmp_path, monkeypatch, capsys):
    for k in list(chalk.os.environ):
        if k.startswith("CHALK_"):
            monkeypatch.delenv(k)
    monkeypatch.setattr(chalk.ChalkGateway, "from_env", classmethod(
        lambda cls, namer: (_ for _ in ()).throw(ValueError("Chalk needs credentials"))))
    assert cli.main(["guide", "--source", "missing.mov", "--area", "1,1,10,10", "--prepared", "--chalk"]) == 2
    assert "Chalk needs credentials" in capsys.readouterr().err


def test_live_camera_never_imports_prerecorded_or_chalk_adapters(tmp_path, monkeypatch):
    import builtins
    from recyclone_worker import sources

    class Camera:
        fps = 10

        def __init__(self, source):
            assert source == "0"

        def __iter__(self):
            yield 0, 0.0, np.zeros((48, 64, 3), np.uint8)

    original_import = builtins.__import__

    def guarded_import(name, *args, **kwargs):
        assert name.rsplit(".", 1)[-1] not in {"chalk", "prepared_guide", "prepared_providers", "prepared_render"}
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(sources, "LiveCameraSource", Camera)
    monkeypatch.setattr(builtins, "__import__", guarded_import)
    monkeypatch.setenv("CHALK_ROUTER_API_KEY", "must-not-be-used-by-live")
    assert cli.main(["guide", "--source", "0", "--area", "1,1,30,30", "--voice", "silent", "--no-stream",
                     "--log", str(tmp_path / "live.jsonl")],
                    make_guide_parts=lambda args, area: (lambda frame: [], object())) == 0


def test_prepared_video_report_distinguishes_real_gateway_calls_from_replays(tmp_path, monkeypatch):
    """Synthetic perception and provider responses; actual video render and report, no network."""
    import cv2
    from concurrent.futures import ThreadPoolExecutor
    from recyclone_worker import demo_watcher, guide_message as gm
    from test_claude_namer import ANSWER, CATALOG
    from test_prepared import FakeScorer, embed

    video = tmp_path / "input.mp4"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 10, (640, 480))
    for _ in range(20):
        writer.write(np.zeros((480, 640, 3), np.uint8))
    writer.release()
    # Black synthetic frames have no faces. Privacy behavior is tested independently in test_demo_watcher.py.
    monkeypatch.setattr(demo_watcher, "_redact", lambda crop, *args: crop)

    def post(url, headers, body, timeout):
        if url.endswith("/v1/messages"):
            return {"content": [{"type": "text", "text": json.dumps(ANSWER)}]}
        assert url.endswith("/alpha/decisions")
        return {"answers": {"answer": {"choice": "trash", "confidence": 0.9}}}

    g = gateway(post)
    monkeypatch.setattr(chalk.ChalkGateway, "from_env", classmethod(lambda cls, selected: g))

    def parts(args, area):
        def pose(frame):
            kp = np.zeros((17, 3), np.float32)
            kp[7], kp[9] = (300, 200, 0.9), (300, 300, 0.9)
            kp[15], kp[16] = (300, 460, 0.9), (340, 460, 0.9)
            return [(1, kp)]

        table = gm.load_bin_table(gm.WORKER_RULES / "cambridge-ma-2022.bins.json")
        identity = ClaudeNamer(tmp_path / "vision", catalog=CATALOG, gateway=g)
        advisor = BinAdvisor(gm.WORKER_RULES / "cambridge-ma-2022.md", tmp_path / "types.json", gateway=g)
        return pose, demo_watcher.DemoItemWatcher(embed, FakeScorer({"item_generic_can": 0.4, "item_napkin": 0.35}),
                                                table, identity, advisor, executor=ThreadPoolExecutor(1))

    args = ["guide", "--source", str(video), "--area", "200,350,640,480", "--prepared", "--chalk",
            "--voice", "silent", "--no-stream", "--log", str(tmp_path / "announcements.jsonl")]
    for iteration, wanted_calls in enumerate([2, 0]):
        g = gateway(post)
        output = tmp_path / f"render-{iteration}.mp4"
        assert cli.main([*args, "--render", str(output)], make_guide_parts=parts) == 0
        report = json.loads(output.with_suffix(".json").read_text())
        assert output.stat().st_size > 0 and report["prepared"] is True
        assert report["chalk"]["requests"] == report["chalk"]["successful_requests"] == wanted_calls
        assert report["items"][0]["message"]["item"] == "plastic fork"
        assert report["items"][0]["message"]["bin"] == "trash"
