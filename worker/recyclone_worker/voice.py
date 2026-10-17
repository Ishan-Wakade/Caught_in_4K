"""The bin's speaker. Swappable: ElevenLabsVoice (the team's voice; `say` when it fails), SayVoice (macOS built-in
voice, offline), SilentVoice for tests and offline runs. Every utterance is kept with its time so the processed video can carry the voice.

SayVoice renders each sentence once to an .aiff file (`say -o`) and plays it with `afplay` in the background, so
catalog messages prepared at startup play with no synthesis delay.
"""

import concurrent.futures
import hashlib
import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.request
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

    def __init__(self, cache_dir: Path, voice: str | None = None, play: bool = True, player=None, on_say=None):
        self.cache_dir, self.voice, self.play = Path(cache_dir), voice, play
        self.player = player or _afplay
        self.on_say = on_say  # (text, file) -> None, called as each sentence starts (e.g. the phone speaker)
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
                        if self.on_say is not None:
                            try:
                                self.on_say(text, f)
                            except Exception as e:  # noqa: BLE001
                                self.errors.append(f"on_say failed ({type(e).__name__}): {text}")
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


ELEVENLABS_ENV = Path.home() / ".config/recyclone/elevenlabs.env"  # outside the repo: ELEVENLABS_API_KEY=, VOICE_ID_EN=
ELEVENLABS_MODEL = "eleven_flash_v2_5"


def elevenlabs_config(env_file: Path = ELEVENLABS_ENV) -> tuple[str | None, str | None]:
    """(api key, voice id): the environment first (ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID), then the config file."""
    vals: dict[str, str] = {}
    try:
        for line in Path(env_file).read_text().splitlines():
            k, sep, v = line.strip().partition("=")
            if sep and not k.startswith("#"):
                vals[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    key = os.environ.get("ELEVENLABS_API_KEY") or vals.get("ELEVENLABS_API_KEY") or None
    vid = os.environ.get("ELEVENLABS_VOICE_ID") or vals.get("ELEVENLABS_VOICE_ID") or vals.get("VOICE_ID_EN") or None
    return key, vid


def _http_post(url: str, headers: dict, data: bytes, timeout: float) -> bytes:
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


class ElevenLabsVoice(SayVoice):
    """SayVoice with ElevenLabs audio: each sentence is synthesized once (mp3, cached on disk), so catalog sentences
    prepared at startup play at once and only a new sentence waits (~0.4 s). Any ElevenLabs failure renders that
    sentence with `say` instead: the bin is never silent. Only the sentence's text is sent to ElevenLabs."""

    def __init__(self, cache_dir: Path, key: str, voice_id: str, post=None, timeout: float = 8.0, **kw):
        self.key, self.voice_id, self.post, self.timeout = key, voice_id, post or _http_post, timeout
        super().__init__(cache_dir, voice=f"elevenlabs:{voice_id}", **kw)

    def _file(self, text: str) -> Path:
        key = hashlib.sha256(f"{self.voice}|{ELEVENLABS_MODEL}|{text}".encode()).hexdigest()[:16]
        return self.cache_dir / f"{key}.mp3"

    def _render(self, text: str) -> Path | None:
        f = self._file(text)
        if f.exists():
            return f
        try:
            audio = self.post(f"https://api.elevenlabs.io/v1/text-to-speech/{self.voice_id}?output_format=mp3_44100_128",
                              {"xi-api-key": self.key, "Content-Type": "application/json"},
                              json.dumps({"text": text, "model_id": ELEVENLABS_MODEL}).encode(), self.timeout)
            if not audio:
                raise ValueError("empty audio")
            tmp = f.with_suffix(".part")
            tmp.write_bytes(audio)
            tmp.replace(f)  # never a half-written file in the cache
            return f
        except Exception as e:  # noqa: BLE001 - fall back to the Mac's own voice
            self.errors.append(f"elevenlabs failed ({type(e).__name__}): {text}")
            print(f"note: ElevenLabs failed ({type(e).__name__}), using say for this sentence", file=sys.stderr)
            return self._render_say(text)

    def _say_file(self, text: str) -> Path:
        return self.cache_dir / f"{hashlib.sha256(f'say|{text}'.encode()).hexdigest()[:16]}.aiff"

    def _render_say(self, text: str) -> Path | None:
        f = self._say_file(text)
        if f.exists():
            return f
        try:
            subprocess.run(["say", "-o", str(f), text], check=True, capture_output=True, timeout=30)
            return f if f.exists() else None
        except Exception as e:  # noqa: BLE001
            self.errors.append(f"render failed ({type(e).__name__}): {text}")
            return None

    def close(self) -> None:
        super().close()
        # a sentence ElevenLabs failed on was played from its `say` file: point the video mix at that file
        self.spoken = [(t, text, f if f is None or f.exists() or not self._say_file(text).exists() else self._say_file(text))
                       for t, text, f in self.spoken]

    def prepare(self, texts: list[str]) -> None:
        with concurrent.futures.ThreadPoolExecutor(4) as pool:  # first run: all catalog sentences in a few seconds
            list(pool.map(self._render, dict.fromkeys(texts)))


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
