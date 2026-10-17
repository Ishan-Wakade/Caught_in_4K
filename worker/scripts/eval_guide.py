"""Score the voice guide on labeled clips: was the person told, how early, and was it the right bin?

    uv run python scripts/eval_guide.py CONFIG.json [CONFIG.json ...] [--namer clip|deepseek] [--render-dir DIR]

CONFIG: an item-tracker config (truth drops with "frame", "bin", "ok_items"). The guide's bin area is the clip's bin
box at the first truth (the dev clips are hand-held, so it is only an approximation of a fixed camera's area).
Right bin = the standard table's bin for the truth item (worker/rules/cambridge-ma-2022.bins.json); an item not in
the catalog is right if the guide said trash (non-dangerous) or none (dangerous). Lead time = truth drop - announcement.
"""

import json
import sys
from pathlib import Path

import numpy as np

from recyclone_worker import guide_message as gm
from recyclone_worker.approach import Approach, BinArea
from recyclone_worker.guide import Guide, YoloPoseTracker
from recyclone_worker.guide_identify import ItemWatcher
from recyclone_worker.items import WORKER, Clip, Scorer, keyframe_boxes, weight
from recyclone_worker.sources import RecordedClipSource
from recyclone_worker.voice import SayVoice, mix_audio

MATCH_BEFORE_S = 1e9  # any announcement before a drop (or up to 1 s after) can belong to it: people may wait at the bins


def area_for(spec, n) -> BinArea:
    first = (spec.get("truths") or [{"frame": n // 2}])[0]["frame"]
    boxes = [keyframe_boxes(b, n)[min(first, n - 1)] for b in spec["bins"]]
    boxes = [b for b in boxes if b is not None] or [keyframe_boxes(b, n)[next(i for i, x in enumerate(keyframe_boxes(b, n)) if x)] for b in spec["bins"]]
    return BinArea(min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def main():
    configs = [a for a in sys.argv[1:] if a.endswith(".json")]
    use_llm = "--namer" in sys.argv and sys.argv[sys.argv.index("--namer") + 1] == "deepseek"
    render_dir = Path(sys.argv[sys.argv.index("--render-dir") + 1]).expanduser() if "--render-dir" in sys.argv else None
    table = gm.load_bin_table(gm.WORKER_RULES / "cambridge-ma-2022.bins.json")
    clip = Clip(weight("clip/ViT-B-32.pt"))
    scorer = Scorer(clip)
    namer = advisor = None
    if use_llm:
        from recyclone_worker.generic import BinAdvisor
        from recyclone_worker.namer import DeepSeekNamer

        namer = DeepSeekNamer(WORKER / "state/vlm-cache")
        advisor = BinAdvisor(WORKER / "rules/cambridge-ma-2022.md", WORKER / "state/generic-types.json")
    rows, leads, fps_all = [], [], []
    told = right = truths_n = false_n = 0
    for cfg in configs:
        for name, spec in json.loads(Path(cfg).read_text()).items():
            video = Path(spec["video"]).expanduser()
            src = RecordedClipSource(video)
            n = src.frame_count
            area = area_for(spec, n)
            voice = SayVoice(WORKER / "state/voice-cache", play=False)
            watcher = ItemWatcher(clip.images, scorer, table, namer=namer, advisor=advisor)
            guide = Guide(YoloPoseTracker(weight("yolo11n-pose.pt")), watcher, Approach(area), voice, area=area)
            frames = []
            on_frame = (lambda img: frames.append(img)) if render_dir else None
            said = guide.run(src, on_frame=on_frame)
            fps_all.append(guide.fps)
            truths = spec.get("truths") or []
            truths_n += len(truths)
            used = set()
            cells = []
            for g in truths:
                tt = g["frame"] / src.fps
                cand = [k for k, s in enumerate(said) if k not in used and tt - MATCH_BEFORE_S <= s["t"] <= tt + 1.0]
                if not cand:
                    cells.append(f"f{g['frame']}: NOT TOLD")
                    continue
                k = min(cand, key=lambda k: abs(tt - said[k]["t"]))
                used.add(k)
                s = said[k]
                ok_item = (g.get("ok_items") or [None])[0]
                want = table[ok_item]["bin"] if ok_item in table else "trash"
                good = s["message"]["bin"] == want
                told += 1
                right += good
                lead = tt - s["t"]
                leads.append(lead)
                cells.append(f"f{g['frame']}: \"{s['spoken']}\" ({s['source']}) lead {lead:+.1f}s {'RIGHT' if good else 'WRONG, want ' + want}")
            extra = [s for k, s in enumerate(said) if k not in used]
            false_n += len(extra)
            rows.append(f"{name:16s} {guide.fps:5.1f} fps | " + " | ".join(cells) + (f" | +{len(extra)} extra: " + "; ".join(f"{s['t']:.1f}s {s['spoken']}" for s in extra) if extra else ""))
            print(rows[-1], flush=True)
            if render_dir and frames:
                import subprocess

                render_dir.mkdir(parents=True, exist_ok=True)
                raw = render_dir / f"{name}_noaudio.mp4"
                h, w = frames[0].shape[:2]
                p = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                                      "-r", str(src.fps), "-i", "-", "-c:v", "libx264", "-crf", "24", "-preset", "veryfast",
                                      "-pix_fmt", "yuv420p", str(raw)], stdin=subprocess.PIPE)
                for img in frames:
                    p.stdin.write(np.ascontiguousarray(img).tobytes())
                p.stdin.close()
                p.wait()
                mix_audio(raw, render_dir / f"{name}_guide.mp4", voice.spoken)
                raw.unlink()
    print(f"\ntold before/at the drop: {told}/{truths_n}; right bin {right}/{told}; extra announcements {false_n}; "
          f"lead time median {np.median(leads) if leads else float('nan'):.1f}s (min {min(leads) if leads else float('nan'):.1f}s); "
          f"fast path {np.median(fps_all):.1f} fps median")


if __name__ == "__main__":
    main()
