"""Prepared audio export stays bounded without changing the live voice implementation."""
from pathlib import Path
from recyclone_worker import prepared_render as voice

def test_mix_audio_builds_one_ffmpeg_call(tmp_path, monkeypatch):
    import cv2
    import numpy as np

    video = tmp_path / "in.mp4"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"mp4v"), 10, (64, 48))
    for _ in range(50):
        writer.write(np.zeros((48, 64, 3), np.uint8))
    writer.release()
    calls = []
    monkeypatch.setattr(voice.subprocess, "run", lambda cmd, **kw: calls.append(cmd))
    clip = tmp_path / "a.aiff"
    clip.write_bytes(b"x")
    voice.mix_audio(tmp_path / "in.mp4", tmp_path / "out.mp4", [(2.5, "Trash. x", clip), (4.0, "silent", None)])
    cmd = calls[0]
    assert cmd[0] == "ffmpeg" and "adelay=2500|2500" in " ".join(cmd) and cmd.count("-i") == 2  # video + 1 clip
    assert float(cmd[cmd.index("-t") + 1]) == 5.0  # padded audio cannot outlive the video

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
