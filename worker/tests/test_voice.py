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
    monkeypatch.setattr(voice.subprocess, "Popen", lambda cmd, **kw: played.append(cmd))
    v = voice.SayVoice(tmp_path, play=True)
    v.speak("Compost. paper napkin, placed in compost", 1.0)
    assert played and played[0][0] == "afplay" and v.spoken[0][2].suffix == ".aiff"


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
