"""ElevenLabs voice: same queue, cache and stale rule as SayVoice; audio from ElevenLabs, `say` when it fails."""

import json
from pathlib import Path

from recyclone_worker import voice
from recyclone_worker.phone_speaker import KEY, PhoneSpeaker

CAN = "Recycle. aluminum can, placed in recycling"


def fake_post(calls, status=200, body=b"ID3mp3"):
    def post(url, headers, data, timeout):
        calls.append((url, headers, json.loads(data), timeout))
        if status != 200:
            raise OSError(f"HTTP {status}")
        return body
    return post


def test_renders_with_elevenlabs_once_and_caches_the_mp3(tmp_path):
    calls = []
    v = voice.ElevenLabsVoice(tmp_path, key="k", voice_id="v1", play=False, post=fake_post(calls))
    v.prepare([CAN])
    v.prepare([CAN])
    assert len(calls) == 1
    url, headers, body, timeout = calls[0]
    assert url == "https://api.elevenlabs.io/v1/text-to-speech/v1?output_format=mp3_44100_128"
    assert headers["xi-api-key"] == "k"
    assert body == {"text": CAN, "model_id": "eleven_flash_v2_5"}
    f = v._file(CAN)
    assert f.suffix == ".mp3" and f.read_bytes() == b"ID3mp3"
    assert KEY.fullmatch(f.stem)  # the phone speaker serves only files named by this key


def test_plays_and_tells_the_phone_with_the_elevenlabs_file(tmp_path):
    played, told = [], []
    v = voice.ElevenLabsVoice(tmp_path, key="k", voice_id="v1", play=True, post=fake_post([]),
                              player=played.append, on_say=lambda text, f: told.append((text, f)))
    v.speak(CAN, 1.0)
    v.close()
    assert played == [v._file(CAN)] and told == [(CAN, v._file(CAN))]
    assert v.spoken[0][2] == v._file(CAN)


def test_elevenlabs_failure_falls_back_to_say(tmp_path, monkeypatch):
    monkeypatch.setattr(voice.subprocess, "run", lambda cmd, **kw: Path(cmd[cmd.index("-o") + 1]).write_bytes(b"aiff"))
    played = []
    v = voice.ElevenLabsVoice(tmp_path, key="k", voice_id="v1", play=True, post=fake_post([], status=401), player=played.append)
    v.speak(CAN, 1.0)
    v.close()
    assert len(played) == 1 and played[0].suffix == ".aiff"  # never silent
    assert any("elevenlabs" in e for e in v.errors)
    assert v.spoken[0][2] == played[0]  # the video mix uses the file that was actually played


def test_key_from_the_config_file_or_the_environment(tmp_path, monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    monkeypatch.delenv("ELEVENLABS_VOICE_ID", raising=False)
    env = tmp_path / "elevenlabs.env"
    env.write_text("ELEVENLABS_API_KEY=abc\nVOICE_ID_EN=voiceX\n")
    assert voice.elevenlabs_config(env) == ("abc", "voiceX")
    monkeypatch.setenv("ELEVENLABS_API_KEY", "fromenv")
    monkeypatch.setenv("ELEVENLABS_VOICE_ID", "v2")
    assert voice.elevenlabs_config(env) == ("fromenv", "v2")
    monkeypatch.delenv("ELEVENLABS_API_KEY")
    assert voice.elevenlabs_config(tmp_path / "missing.env") == (None, "v2")


def test_phone_speaker_converts_the_mp3_for_the_phone(tmp_path):
    sp = PhoneSpeaker(0, token="t", convert=lambda src, dst: dst.write_bytes(src.read_bytes()) or True, host="127.0.0.1")
    mp3 = tmp_path / "0123456789abcdef.mp3"
    mp3.write_bytes(b"ID3")
    sp.announce(CAN, mp3)
    assert sp.messages[-1]["audio"] == "0123456789abcdef"
    assert sp.audio["0123456789abcdef"] == tmp_path / "0123456789abcdef.m4a"
