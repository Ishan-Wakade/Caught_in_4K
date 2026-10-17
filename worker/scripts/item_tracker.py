"""Dev-clip evaluation and annotated videos for the item tracker (logic: recyclone_worker/items.py).

    uv run python scripts/item_tracker.py OUT_DIR CONFIG.json [--recompute] [--no-video]

Scores detected drops against the config's true drop frames (strict ±0.5 s, loose ±1.5 s) and writes
OUT_DIR/item_summary.md, item_results.json and, unless --no-video, OUT_DIR/<name>_items.mp4.
"""

import json
import subprocess
import sys
from pathlib import Path

import cv2

from recyclone_worker.items import (MIN_AREA, SKELETON, Clip, Scorer, center, decide, ego_motion,
                                    keyframe_boxes, perceive, track, weight)

TOLERANCE = 15                      # strict: within 0.5 s of the true release
LOOSE = 45                          # loose: within 1.5 s (the right drop into the right bin)


def text(img, s, org, color, scale=1.0):
    cv2.putText(img, s, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 6, cv2.LINE_AA)
    cv2.putText(img, s, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2, cv2.LINE_AA)


COLORS = {"carried": (0, 165, 255), "re-found": (0, 165, 255), "already in bin": (170, 170, 170)}
ARMS = [(5, 7), (7, 9), (6, 8), (8, 10)]


def render(video: Path, out: Path, data, bins, tracks, per_frame, roles, events):
    title = out.stem.removesuffix("_items")
    cap = cv2.VideoCapture(str(video))
    w, h = (int(v) for v in data["size"])
    fps = float(data["fps"])
    big = max(w, h) / 1920  # line widths and text scale follow the frame size
    lw, ts = max(2, int(4 * big)), max(0.5, big)
    ff = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps),
                           "-i", "-", "-c:v", "libx264", "-crf", "27", "-preset", "veryfast", "-pix_fmt", "yuv420p", str(out)], stdin=subprocess.PIPE)
    by_id = {t["id"]: t for t in tracks}
    identity = data["_identity"]
    names = {iid: chr(ord("A") + k) for k, iid in enumerate(sorted(set(identity.values())))}
    i = 0
    while True:
        ok, f = cap.read()
        if not ok:
            break
        for bid, bx in bins.items():
            if bx[i] is not None:
                x0, y0, x1, y1 = map(int, bx[i])
                cv2.rectangle(f, (x0, y0), (x1, y1), (0, 200, 0), lw)
                text(f, bid.replace("bin_", ""), (x0 + 8, y0 + int(40 * big)), (120, 255, 120), 1.1 * ts)
        kp = data["kps"][i]
        for a, b in SKELETON:
            if kp[a][2] > 0.3 and kp[b][2] > 0.3:
                arm = (a, b) in ARMS
                cv2.line(f, (int(kp[a][0]), int(kp[a][1])), (int(kp[b][0]), int(kp[b][1])), (0, 255, 255) if arm else (255, 200, 0),
                         lw * 2 if arm else lw)
        holding = {tid for _, tid, _ in data["_links"][i]}
        for side, tid, (wx, wy) in data["_links"][i]:  # arm -> the one object that hand holds
            if roles.get(tid) in ("carried", "re-found"):
                cx, cy = center(next(b for t2, b, _ in per_frame[i] if t2 == tid))
                cv2.line(f, (int(wx), int(wy)), (int(cx), int(cy)), (255, 0, 255), lw)
        for tid, b, p in per_frame[i]:
            role = roles.get(tid)
            if role not in COLORS:
                continue  # not brought by a person: not drawn
            x0, y0, x1, y1 = map(int, b)
            cv2.rectangle(f, (x0, y0), (x1, y1), COLORS[role], lw if role != "already in bin" else max(1, lw // 2))
            if role == "already in bin":
                text(f, "already in bin", (x0, max(30, y0 - 8)), COLORS[role], 0.7 * ts)
                continue
            iid = identity[tid]
            state = "in hand" if tid in holding else ("re-found" if role == "re-found" else "carried")
            cat = (by_id[iid]["category"] or "unknown").replace("item_generic_", "").replace("item_", "")
            text(f, f"item {names[iid]}: {cat} ({state})", (x0, max(30, y0 - 10)), COLORS[role], 0.85 * ts)
        for e in events:
            if e["frame"] <= i < e["frame"] + int(1.5 * fps):
                text(f, f"DROP item {names[e['item_id']]} -> {e['bin']}: {e['item']} (rule {e['item_bin_rule']}, {e['how']})",
                     (int(30 * big), h - int(60 * big)), (80, 255, 80), ts)
        seen = sorted({names[identity[t]] for t2 in range(i + 1) for _, t, _ in data["_links"][t2] if t in identity})
        text(f, f"{title}  frame {i}  brought by a person: {', '.join(seen) or '-'}  drops {sum(e['frame'] <= i for e in events)}",
             (int(30 * big), int(60 * big)), (255, 255, 255), ts)
        ff.stdin.write(f.tobytes())
        i += 1
    ff.stdin.close()
    ff.wait()


def main():
    from ultralytics import YOLO, FastSAM

    out_dir = Path(sys.argv[1]).expanduser()
    (out_dir / "cache").mkdir(parents=True, exist_ok=True)
    config = json.loads(Path(sys.argv[2]).read_text())
    if "--recompute" in sys.argv:
        for c in (out_dir / "cache").glob("*.npz"):
            c.unlink()
    clip = Clip(weight("clip/ViT-B-32.pt"))
    sam = pose = None
    scorer = Scorer(clip)
    results = {}
    rows, score = [], {"strict": [0, 0, 0], "loose": [0, 0, 0]}  # tp, fn, fp
    for name, spec in config.items():
        video = Path(spec["video"]).expanduser()
        cache = out_dir / "cache" / f"{name}.npz"  # config name: several clips may share a file name (video.mp4)
        if not cache.exists() and sam is None:
            sam, pose = FastSAM(str(weight("FastSAM-s.pt"))), YOLO(str(weight("yolo11n-pose.pt")))
        data = perceive(video, cache, sam, pose, clip, spec.get("min_item_area", MIN_AREA))
        n = len(data["kps"])
        bins = {b["bin_id"]: keyframe_boxes(b, n) for b in spec["bins"]}
        motion = ego_motion(video, out_dir / "cache" / f"{name}_motion.npy")
        tracks, per_frame = track(data, bins, scorer, motion)
        events, roles = decide(tracks, data, bins, float(data["fps"]), motion, per_frame)
        if "--no-video" not in sys.argv:
            render(video, out_dir / f"{name}_items.mp4", data, bins, tracks, per_frame, roles, events)
        count = {r: sum(v == r for v in roles.values()) for r in ("carried", "re-found", "already in bin")}
        count["items brought"] = len(set(data["_identity"].values()))
        results[name] = {"events": events, "roles": count,
                         "carried": [{"id": t["id"], "frames": [t["frames"][0], t["frames"][-1]], "n": len(t["frames"]),
                                      "category": t["category"], "role": roles[t["id"]], "item_id": data["_identity"][t["id"]]}
                                     for t in tracks if roles[t["id"]] in ("carried", "re-found")]}
        print(name, json.dumps(results[name]["events"]), count, flush=True)
        truths = spec.get("truths") or ([spec["truth"]] if spec.get("truth") else [])
        if not truths and "truths" not in spec:
            continue
        cells = []
        for key, tol in (("strict", TOLERANCE), ("loose", LOOSE)):
            free, matched = list(events), []
            for gt in truths:  # each true drop takes the closest unused detection into the same bin
                hit = sorted((e for e in free if abs(e["frame"] - gt["frame"]) <= tol and e["bin"] == gt["bin"]),
                             key=lambda e: abs(e["frame"] - gt["frame"]))
                if hit:
                    free.remove(hit[0]); matched.append((gt, hit[0]))
            score[key][0] += len(matched); score[key][1] += len(truths) - len(matched); score[key][2] += len(free)
            if len(truths) == 1:
                cells.append((f"HIT ({matched[0][1]['frame'] - matched[0][0]['frame']:+d} fr)" if matched else "MISS") + (f", {len(free)} false" if free else ""))
            else:
                cells.append(f"{len(matched)}/{len(truths)} found" + (f", {len(free)} false" if free else ""))
            if key == "loose":
                item = "; ".join(f"{e['item']} ({e['item_bin_rule']})" for _, e in matched) or "-"
        det = ", ".join(f"f{e['frame']}" for e in events) or "none"
        true = ", ".join(f"f{g['frame']} {g['bin']}" for g in truths) or "none (no drop)"
        rows.append(f"| {name} | {true} | {det} | {cells[0]} | {cells[1]} | {item} | "
                    f"{count['items brought']} brought by a person ({count['carried']} tracks in hand, {count['re-found']} re-found), {count['already in bin']} already in bin |")
    lines = [f"| video | true drop | detected drops | ±{TOLERANCE} fr (0.5 s) | ±{LOOSE} fr (1.5 s) | item (bin rule, how) | objects |",
             "|---|---|---|---|---|---|---|", *rows, ""]
    for key in ("strict", "loose"):
        tp, fn, fp = score[key]
        lines.append(f"{key}: drops found {tp}/{tp + fn}, false drops {fp}.")
    lines.append("DEV videos: the rules were tuned while looking at these 5 clips, so this is not a held-out accuracy.")
    (out_dir / "item_results.json").write_text(json.dumps(results, indent=1))
    (out_dir / "item_summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
