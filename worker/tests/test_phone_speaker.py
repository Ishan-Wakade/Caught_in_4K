"""Phone speaker: the guide's sentences reach a second phone over the LAN; token-gated; only said audio is served."""

import json
import shutil
import socket
import threading
import urllib.error
import urllib.request

import pytest

from recyclone_worker import voice
from recyclone_worker.phone_speaker import PhoneSpeaker, lan_urls

KEY = "0123456789abcdef"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def speaker():
    sp = PhoneSpeaker(free_port(), token="tok", convert=lambda src, dst: shutil.copy(src, dst) or True, host="127.0.0.1")
    sp.start()
    yield sp
    sp.stop()


def url(sp, rest=""):
    return f"http://127.0.0.1:{sp.port}/s/{sp.token}/{rest}"


def read_events(sp, n, headers=None, after=None):
    """Open the event stream, run `after()` once connected, return the first n sentences."""
    got = []
    with urllib.request.urlopen(urllib.request.Request(url(sp, "events"), headers=headers or {}), timeout=5) as r:
        assert r.headers["Content-Type"] == "text/event-stream"
        assert r.readline() == b"retry: 1000\n"
        if after:
            threading.Timer(0.1, after).start()
        while len(got) < n:
            line = r.readline()
            if line.startswith(b"data: "):
                got.append(json.loads(line[6:]))
    return got


def test_page_needs_the_token(speaker):
    with urllib.request.urlopen(url(speaker), timeout=3) as r:
        assert b"Tap to turn on the speaker" in r.read()
    for bad in ["/", "/s/wrong/", "/s/tok"]:
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(f"http://127.0.0.1:{speaker.port}{bad}", timeout=3)
        assert e.value.code == 404


def test_a_sentence_reaches_the_phone_with_its_audio(speaker, tmp_path):
    aiff = tmp_path / f"{KEY}.aiff"
    aiff.write_bytes(b"aiff")
    got = read_events(speaker, 1, after=lambda: speaker.announce("Recycle. aluminum can, placed in recycling", aiff))
    assert got[0]["text"] == "Recycle. aluminum can, placed in recycling" and got[0]["audio"] == KEY
    with urllib.request.urlopen(url(speaker, f"a/{KEY}.m4a"), timeout=3) as r:
        assert r.headers["Content-Type"] == "audio/mp4" and r.read() == b"aiff"


def test_a_new_phone_does_not_hear_old_sentences_but_a_reconnect_resumes(speaker):
    speaker.announce("Trash. chip bag, placed in trash", None)
    speaker.announce("Compost. paper napkin, placed in compost", None)
    later = read_events(speaker, 1, after=lambda: speaker.announce("Recycle. plastic bottle, placed in recycling", None))
    assert [m["id"] for m in later] == [3]
    resumed = read_events(speaker, 2, headers={"Last-Event-ID": "1"})
    assert [m["text"].split(".")[0] for m in resumed] == ["Compost", "Recycle"]


def test_only_audio_of_said_sentences_is_served(speaker, tmp_path):
    (tmp_path / f"{KEY}.m4a").write_bytes(b"x")  # on disk but never said
    for rest in [f"a/{KEY}.m4a", "a/../../pyproject.toml", "a/%2e%2e/x.m4a"]:
        with pytest.raises(urllib.error.HTTPError) as e:
            urllib.request.urlopen(url(speaker, rest), timeout=3)
        assert e.value.code == 404


def test_failed_conversion_still_sends_the_text(tmp_path):
    sp = PhoneSpeaker(0, convert=lambda src, dst: False)
    aiff = tmp_path / f"{KEY}.aiff"
    aiff.write_bytes(b"aiff")
    sp.announce("Trash. chip bag, placed in trash", aiff)
    assert sp.messages[0]["audio"] is None and sp.audio == {}


def test_lan_urls_carry_the_token():
    urls = lan_urls(8766, "tok")
    assert urls and all(u.startswith("http://") and u.endswith(":8766/s/tok/") for u in urls)


def test_say_voice_tells_the_phone_before_playing(tmp_path, monkeypatch):
    order = []
    monkeypatch.setattr(voice.subprocess, "run", lambda cmd, **kw: (tmp_path / cmd[cmd.index("-o") + 1]).write_bytes(b"a"))
    v = voice.SayVoice(tmp_path, play=True, player=lambda f: order.append("mac"),
                       on_say=lambda text, f: order.append(("phone", text, f.suffix)))
    v.speak("Trash. chip bag, placed in trash", 0.0)
    v.close()
    assert order == [("phone", "Trash. chip bag, placed in trash", ".aiff"), "mac"]


def test_page_draws_a_live_waveform_from_the_played_audio():
    """Voice-memo look: the sentence's audio goes through an analyser that drives the waveform canvas."""
    from recyclone_worker.phone_speaker import PAGE

    assert '<canvas id="wave"' in PAGE
    assert "createAnalyser" in PAGE and "src.connect(analyser)" in PAGE


def test_events_stream_is_chunked_http11_so_proxies_and_tunnels_pass_it_through(speaker):
    """A Cloudflare tunnel held the old HTTP/1.0 length-less stream until it closed: nothing reached the phone."""
    with socket.create_connection(("127.0.0.1", speaker.port), timeout=5) as s:
        s.sendall(f"GET /s/{speaker.token}/events HTTP/1.1\r\nHost: x\r\n\r\n".encode())
        head = b""
        while b"\r\n\r\n" not in head:
            head += s.recv(1024)
    status, *headers = head.split(b"\r\n\r\n")[0].decode().split("\r\n")
    hs = {k.lower(): v.strip() for k, v in (h.split(":", 1) for h in headers)}
    assert status.startswith("HTTP/1.1 200")
    assert hs["transfer-encoding"] == "chunked" and hs["content-type"] == "text/event-stream"
    assert hs.get("x-accel-buffering") == "no"


def poll(sp, after, timeout=5):
    with urllib.request.urlopen(url(sp, f"poll?after={after}"), timeout=timeout) as r:
        assert r.headers["Content-Length"] and r.headers["Content-Type"].startswith("application/json")
        return json.loads(r.read())


def test_long_poll_works_where_event_streams_are_held_by_a_tunnel(speaker):
    speaker.announce("Trash. chip bag, placed in trash", None)
    first = poll(speaker, "now")  # a new phone starts from now: old sentences are not replayed
    assert first["messages"] == [] and first["last"] == speaker.last_id()
    threading.Timer(0.3, lambda: speaker.announce("Recycle. aluminum can, placed in recycling", None)).start()
    got = poll(speaker, first["last"])  # waits for the next sentence, then answers at once
    assert [m["text"] for m in got["messages"]] == ["Recycle. aluminum can, placed in recycling"]
    assert got["messages"][0]["age_s"] < 1 and got["last"] == got["messages"][0]["id"]


def test_tunnel_url_is_read_from_cloudflared_output():
    from recyclone_worker.phone_speaker import tunnel_url
    assert tunnel_url("2026 INF |  https://agrees-hitachi-alex-preston.trycloudflare.com  |") == \
        "https://agrees-hitachi-alex-preston.trycloudflare.com"
    assert tunnel_url("INF Requesting new quick Tunnel on trycloudflare.com...") is None
