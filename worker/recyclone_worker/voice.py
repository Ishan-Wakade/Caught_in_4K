"""The bin's speaker. Swappable: SayVoice (macOS built-in voice, offline) until the team picks a provider; SilentVoice
for tests and offline runs. Every utterance is kept with its time so the processed video can carry the voice.

SayVoice renders each sentence once to an .aiff file (`say -o`) and plays it with `afplay` in the background, so
catalog messages prepared at startup play with no synthesis delay.
"""

import hashlib
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Protocol


class Voice(Protocol):
    spoken: list[tuple[float, str, Path | None]]

    def prepare(self, texts: list[str]) -> None: ...

    def warm(self, text: str) -> None: ...

    def speak(self, text: str, at_s: float) -> None: ...

    def close(self) -> None: ...


class SilentVoice:
    def __init__(self):
        self.spoken: list[tuple[float, str, Path | None]] = []
        self.errors: list[str] = []

    def prepare(self, texts: list[str]) -> None:
        pass

    def warm(self, text: str) -> None:
        pass

    def speak(self, text: str, at_s: float) -> None:
        self.spoken.append((at_s, text, None))

    def close(self) -> None:
        pass


STALE_S = 3.0  # a sentence still waiting to be played after this long is dropped (the person has moved on)


def _afplay(path: Path) -> None:
    subprocess.run(["afplay", str(path)], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


class SayVoice:
    """macOS `say`, rendered to .aiff once per sentence. Rendering (~2.7 s for a new sentence) and playback run on one
    background thread, so the frame loop never waits; sentences play one after another; failures are logged."""

    def __init__(self, cache_dir: Path, voice: str | None = None, play: bool = True, player=None):
        self.cache_dir, self.voice, self.play = Path(cache_dir), voice, play
        self.player = player or _afplay
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.spoken: list[tuple[float, str, Path | None]] = []
        self.errors: list[str] = []
        self.queue: queue.Queue = queue.Queue()
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()

    def _file(self, text: str) -> Path:
        key = hashlib.sha256(f"{self.voice}|{text}".encode()).hexdigest()[:16]
        return self.cache_dir / f"{key}.aiff"

    def _render(self, text: str) -> Path | None:
        f = self._file(text)
        if f.exists():
            return f
        try:
            cmd = ["say", "-o", str(f)] + (["-v", self.voice] if self.voice else []) + [text]
            subprocess.run(cmd, check=True, capture_output=True, timeout=30)
            return f if f.exists() else None
        except Exception as e:  # noqa: BLE001 - the guide must keep running without a voice
            self.errors.append(f"render failed ({type(e).__name__}): {text}")
            print(f"note: voice render failed ({type(e).__name__})", file=sys.stderr)
            return None

    def prepare(self, texts: list[str]) -> None:
        for t in dict.fromkeys(texts):
            self._render(t)

    def warm(self, text: str) -> None:
        """Render in the background ahead of time (an answer is known before the person arrives)."""
        self.queue.put(("render", text, time.monotonic()))

    def speak(self, text: str, at_s: float) -> None:
        self.spoken.append((at_s, text, self._file(text)))
        self.queue.put(("say", text, time.monotonic()))

    def _run(self) -> None:
        while True:
            kind, text, queued = self.queue.get()
            try:
                if kind == "stop":
                    return
                f = self._render(text)
                if kind == "say" and self.play and f is not None:
                    if time.monotonic() - queued > STALE_S:
                        self.errors.append(f"dropped stale sentence: {text}")
                    else:
                        try:
                            self.player(f)
                        except Exception as e:  # noqa: BLE001
                            self.errors.append(f"playback failed ({type(e).__name__}): {text}")
            finally:
                self.queue.task_done()

    def close(self) -> None:
        """Finish what is queued (all sentences rendered for the video mix), then stop the thread."""
        self.queue.put(("stop", "", time.monotonic()))
        self.worker.join(timeout=120)


def mix_audio(video_in: Path, video_out: Path, spoken: list[tuple[float, str, Path | None]]) -> None:
    """Put each spoken clip into the video's audio at its time (one ffmpeg call); no speech: copy the video."""
    clips = [(t, f) for t, _, f in spoken if f is not None and Path(f).exists()]
    if not clips:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(video_in), "-c", "copy", str(video_out)], check=True)
        return
    cmd = ["ffmpeg", "-loglevel", "error", "-y", "-i", str(video_in)]
    for _, f in clips:
        cmd += ["-i", str(f)]
    parts = [f"[{k + 1}:a]adelay={round(t * 1000)}|{round(t * 1000)}[a{k}]" for k, (t, _) in enumerate(clips)]
    # apad: silence after the last clip, so -shortest ends at the VIDEO's end (without it the video was cut short)
    mix = "".join(f"[a{k}]" for k in range(len(clips))) + f"amix=inputs={len(clips)}:normalize=0,apad[aout]"
    cmd += ["-filter_complex", ";".join(parts + [mix]), "-map", "0:v", "-map", "[aout]", "-c:v", "copy", "-c:a", "aac",
            "-shortest", str(video_out)]
    subprocess.run(cmd, check=True)
