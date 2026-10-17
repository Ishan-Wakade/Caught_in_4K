"""Voice: swappable speaker; macOS `say` pre-rendered; every utterance recorded for the video's audio track."""

from pathlib import Path

from recyclone_worker import voice


def test_silent_voice_records_time_and_text():
    v = voice.SilentVoice()
    v.speak("Recycle. aluminum can, placed in recycling", 2.5)
    assert v.spoken == [(2.5, "Recycle. aluminum can, placed in recycling", None)]


def test_say_voice_prepares_files_once(tmp_path, monkeypatch):
    calls = []

    def fake_run(cmd, **kw):
        calls.append(cmd)
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"aiff")
        return None
    monkeypatch.setattr(voice.subprocess, "run", fake_run)
    v = voice.SayVoice(tmp_path, play=False)
    v.prepare(["Trash. chip bag, placed in trash"])
    v.prepare(["Trash. chip bag, placed in trash"])
    assert len(calls) == 1 and calls[0][0] == "say"


def test_say_voice_speaks_from_the_prepared_file(tmp_path, monkeypatch):
    played = []
    monkeypatch.setattr(voice.subprocess, "run", lambda cmd, **kw: Path(cmd[cmd.index("-o") + 1]).write_bytes(b"aiff"))
    v = voice.SayVoice(tmp_path, play=True, player=lambda f: played.append(f))
    v.speak("Compost. paper napkin, placed in compost", 1.0)
    v.close()
    assert played and played[0].suffix == ".aiff" and v.spoken[0][2].suffix == ".aiff"


def test_mix_audio_builds_one_ffmpeg_call(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(voice.subprocess, "run", lambda cmd, **kw: calls.append(cmd))
    clip = tmp_path / "a.aiff"
    clip.write_bytes(b"x")
    voice.mix_audio(tmp_path / "in.mp4", tmp_path / "out.mp4", [(2.5, "Trash. x", clip), (4.0, "silent", None)])
    cmd = calls[0]
    assert cmd[0] == "ffmpeg" and "adelay=2500|2500" in " ".join(cmd) and cmd.count("-i") == 2  # video + 1 clip


def test_mix_audio_without_speech_copies_the_video(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(voice.subprocess, "run", lambda cmd, **kw: calls.append(cmd))
    voice.mix_audio(tmp_path / "in.mp4", tmp_path / "out.mp4", [])
    assert calls[0][0] == "ffmpeg" and "-c" in calls[0]


def test_mixed_video_keeps_its_full_length(tmp_path):
    """Real ffmpeg: a 3 s video with a 0.2 s clip spoken at 0.5 s must stay 3 s long (the audio must not cut it)."""
    import wave

    import cv2
    import numpy as np

    video = tmp_path / "v.mp4"
    out = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 10, (64, 48))
    for _ in range(30):
        out.write(np.zeros((48, 64, 3), np.uint8))
    out.release()
    clip = tmp_path / "s.wav"
    with wave.open(str(clip), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(16000), w.writeframes(b"\x00\x01" * 3200)
    voice.mix_audio(video, tmp_path / "o.mp4", [(0.5, "Trash. x", clip)])
    import subprocess as sp
    dur = float(sp.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(tmp_path / "o.mp4")],
                       capture_output=True, text=True).stdout)
    assert abs(dur - 3.0) < 0.3


# ---- review fixes (17 Oct): rendering off the frame loop, one sentence at a time, failures never crash
def test_speak_returns_at_once_and_sentences_play_one_after_another(tmp_path, monkeypatch):
    import threading
    import time

    played, lock = [], threading.Lock()

    def fake_run(cmd, **kw):
        time.sleep(0.2)  # slow render
        Path(cmd[cmd.index("-o") + 1]).write_bytes(b"aiff")

    def fake_play(path):
        with lock:
            played.append(("start", path.name))
        time.sleep(0.05)
        with lock:
            played.append(("end", path.name))
    monkeypatch.setattr(voice.subprocess, "run", fake_run)
    v = voice.SayVoice(tmp_path, play=True, player=fake_play)
    t0 = time.perf_counter()
    v.speak("Trash. a", 1.0)
    v.speak("Recycle. b", 1.0)
    assert time.perf_counter() - t0 < 0.1
    v.close()
    kinds = [k for k, _ in played]
    assert kinds == ["start", "end", "start", "end"]


def test_a_failed_render_never_raises(tmp_path, monkeypatch):
    def broken(cmd, **kw):
        raise FileNotFoundError("say")
    monkeypatch.setattr(voice.subprocess, "run", broken)
    v = voice.SayVoice(tmp_path, play=False)
    v.prepare(["Trash. x"])
    v.speak("Trash. x", 1.0)
    v.close()
    assert v.spoken and v.errors
