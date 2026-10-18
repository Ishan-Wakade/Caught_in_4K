"""One uploaded video -> the annotated video with the voice mixed in, for the website's "Try your video" tab
(modal_app.py runs this on a cloud GPU; it also runs locally: python -m recyclone_worker.job --input clip.mov --out dir).

normalise: ffmpeg makes any phone/browser recording (iPhone .mov, Chrome .webm, rotated, variable frame rate) an
upright H.264 clip, short side at most 720 px, 30 fps, so its pixels are what the browser showed and the bin box
drawn there lands in the same place. Anything longer than MAX_SECONDS is refused.
guide: `recyclone-worker guide --prepared --no-verdict --headless --render` in a subprocess (its own memory; a crash is a failed
job, not a dead server). The video shows what was seen and said, not whether the right bin was used (user
decision, 17 Oct). Its "stage: ..." lines are passed to on_stage for the progress text.

The result is {"status": "done", "report": {...}} (the guide's <render>.json) or {"status": "error", "code": ...}
with code in ERRORS. The identification it runs (Claude, Jev, ElevenLabs) uses the keys in the environment.
"""

import argparse
import json
import shutil
import subprocess
import sys
from collections import deque
from pathlib import Path

from .cli import NO_BINS

MAX_SECONDS = 60
SHORT_SIDE = 720
FPS = 30
ERRORS = ("too_long", "unreadable", "no_bins", "failed")
SCALE = (f"scale='if(gt(iw,ih),-2,min({SHORT_SIDE},iw))':'if(gt(iw,ih),min({SHORT_SIDE},ih),-2)',fps={FPS}")


def normalise(src: Path, dst: Path, run=subprocess.run) -> None:
    """Upright (ffmpeg applies the rotation tag), <= SHORT_SIDE, constant FPS, no audio (the voice is the audio).
    Stops one second past the limit, so a long upload costs at most that much work before it is refused."""
    run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(src), "-t", str(MAX_SECONDS + 1), "-vf", SCALE, "-an",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(dst)],
        check=True, capture_output=True, timeout=300)


def probe(path: Path, run=subprocess.run) -> tuple[int, int, float]:
    """(width, height, seconds) of the first video stream."""
    r = run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
             "-of", "json", str(path)], check=True, capture_output=True, text=True, timeout=60)
    info = json.loads(r.stdout)
    s = info["streams"][0]
    return int(s["width"]), int(s["height"]), float(info["format"]["duration"])


def area_pixels(area_norm: tuple[float, float, float, float] | None, w: int, h: int) -> str:
    """The box drawn on the upload page (fractions of the frame) -> guide --area "x0,y0,x1,y1"; none -> "auto"."""
    if area_norm is None:
        return "auto"
    x0, y0, x1, y1 = (min(max(float(v), 0.0), 1.0) for v in area_norm)
    if x1 - x0 < 0.02 or y1 - y0 < 0.02:
        raise ValueError("bin box too small")
    return f"{round(x0 * w)},{round(y0 * h)},{round(x1 * w)},{round(y1 * h)}"


def guide_command(source: Path, area: str, render: Path, log: Path) -> list[str]:
    return [sys.executable, "-m", "recyclone_worker.cli", "guide", "--source", str(source), "--area", area,
            "--prepared", "--no-verdict", "--cctv", "--no-stream", "--headless", "--voice", "auto", "--render", str(render), "--log", str(log)]


def run_job(src: Path, out_dir: Path, area_norm=None, on_stage=print, run=subprocess.run, popen=subprocess.Popen) -> dict:
    out_dir, work = Path(out_dir), Path(out_dir) / "work"
    work.mkdir(parents=True, exist_ok=True)
    try:
        on_stage("preparing video")
        norm = work / "clip.mp4"
        try:
            normalise(Path(src), norm, run=run)
            w, h, seconds = probe(norm, run=run)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, KeyError, IndexError, ValueError):
            return {"status": "error", "code": "unreadable"}
        if seconds > MAX_SECONDS:
            return {"status": "error", "code": "too_long"}
        render = out_dir / "result.mp4"
        proc = popen(guide_command(norm, area_pixels(area_norm, w, h), render, work / "guide-log.jsonl"),
                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        tail: deque[str] = deque(maxlen=40)
        for line in proc.stderr:
            line = line.rstrip()
            tail.append(line)
            if line.startswith("stage: "):
                on_stage(line[len("stage: "):])
        code = proc.wait()
        if code == NO_BINS:
            return {"status": "error", "code": "no_bins"}
        report_file = render.with_suffix(".json")
        if code != 0 or not render.exists() or not report_file.exists():
            print("\n".join(tail), file=sys.stderr)  # the job's own log (Modal keeps it), never sent to the browser
            return {"status": "error", "code": "failed"}
        report = json.loads(report_file.read_text())
        report["video"], report["source"] = render.name, "upload"  # no server paths in what the page receives
        report_file.write_text(json.dumps(report, indent=2))
        return {"status": "done", "report": report}
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="one uploaded video -> annotated video with the voice (upload page)")
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--area-norm", help="x0,y0,x1,y1 as fractions of the frame (the box drawn on the page)")
    args = ap.parse_args(argv)
    area = tuple(float(v) for v in args.area_norm.split(",")) if args.area_norm else None
    result = run_job(Path(args.input), Path(args.out), area, on_stage=lambda s: print(f"stage: {s}", file=sys.stderr))
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "done" else 1


if __name__ == "__main__":
    raise SystemExit(main())
