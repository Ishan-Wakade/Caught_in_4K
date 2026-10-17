"""The bin's speaker. Swappable: SayVoice (macOS built-in voice, offline) until the team picks a provider; SilentVoice
for tests and offline runs. Every utterance is kept with its time so the processed video can carry the voice.

SayVoice renders each sentence once to an .aiff file (`say -o`) and plays it with `afplay` in the background, so
catalog messages prepared at startup play with no synthesis delay.
"""

import hashlib
import subprocess
from pathlib import Path
from typing import Protocol


class Voice(Protocol):
    spoken: list[tuple[float, str, Path | None]]

    def prepare(self, texts: list[str]) -> None: ...

    def speak(self, text: str, at_s: float) -> None: ...


class SilentVoice:
    def __init__(self):
        self.spoken: list[tuple[float, str, Path | None]] = []

    def prepare(self, texts: list[str]) -> None:
        pass

    def speak(self, text: str, at_s: float) -> None:
        self.spoken.append((at_s, text, None))


class SayVoice:
    def __init__(self, cache_dir: Path, voice: str | None = None, play: bool = True):
        self.cache_dir, self.voice, self.play = Path(cache_dir), voice, play
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.spoken: list[tuple[float, str, Path | None]] = []

    def _file(self, text: str) -> Path:
        key = hashlib.sha256(f"{self.voice}|{text}".encode()).hexdigest()[:16]
        return self.cache_dir / f"{key}.aiff"

    def _render(self, text: str) -> Path:
        f = self._file(text)
        if not f.exists():
            cmd = ["say", "-o", str(f)] + (["-v", self.voice] if self.voice else []) + [text]
            subprocess.run(cmd, check=True, capture_output=True, timeout=30)
        return f

    def prepare(self, texts: list[str]) -> None:
        for t in dict.fromkeys(texts):
            self._render(t)

    def speak(self, text: str, at_s: float) -> None:
        f = self._render(text)
        if self.play:
            subprocess.Popen(["afplay", str(f)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.spoken.append((at_s, text, f))


def mix_audio(video_in: Path, video_out: Path, spoken: list[tuple[float, str, Path | None]]) -> None:
    """Put each spoken clip into the video's audio at its time (one ffmpeg call); no speech: copy the video."""
    clips = [(t, f) for t, _, f in spoken if f is not None]
    if not clips:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(video_in), "-c", "copy", str(video_out)], check=True)
        return
    cmd = ["ffmpeg", "-loglevel", "error", "-y", "-i", str(video_in)]
    for _, f in clips:
        cmd += ["-i", str(f)]
    parts = [f"[{k + 1}:a]adelay={round(t * 1000)}|{round(t * 1000)}[a{k}]" for k, (t, _) in enumerate(clips)]
    mix = "".join(f"[a{k}]" for k in range(len(clips))) + f"amix=inputs={len(clips)}:normalize=0[aout]"
    cmd += ["-filter_complex", ";".join(parts + [mix]), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac",
            "-shortest", str(video_out)]
    subprocess.run(cmd, check=True)
