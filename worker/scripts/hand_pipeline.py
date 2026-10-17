"""Experimental drop detector: skeleton + given bin boxes + CLIP on the hand (no object detector).

    uv run python scripts/hand_pipeline.py OUT_DIR CONFIG.json

1. Skeleton: YOLO11n-pose gives 17 COCO keypoints per person (elbows 7/8, wrists 9/10).
2. Bins are GIVEN as boxes on a few keyframes (config); boxes are interpolated between keyframes and
   absent outside the bin's visible range. (A fixed camera needs one box. The 16 Oct first try carried
   one box with frame-to-frame homographies; it drifted onto the person and caused false drops.)
3. The object is whatever is in the hand: a square crop just past each wrist (along elbow->wrist) goes
   to CLIP, scored against the item prompts plus "empty hand" prompts. P(holding) = 1 - P(empty).
4. A drop = a hand that was holding goes empty while its wrist is inside (or just over) a bin box.
   A hand that empties anywhere else is "released elsewhere", not a disposal.
"""

import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

from recyclone_worker.categories import ITEM_PROMPTS, CategoryClassifier
from recyclone_worker.identify import ClipEmbedder

WORKER = Path(__file__).resolve().parents[1]
CATALOG = {i["catalog_item_id"]: i for i in json.loads((WORKER.parent / "contracts/fixtures/demo-site.json").read_text())["catalog"]}
EMPTY = "__empty__"
PROMPTS = {**ITEM_PROMPTS, EMPTY: ["an empty hand", "an open hand with nothing in it", "a person's arm and sleeve", "a floor or wall",
                                   "an empty hand over a trash can", "a hand reaching into a bin", "the inside of a trash can"]}
SKELETON = [(5, 7), (7, 9), (6, 8), (8, 10), (5, 6), (5, 11), (6, 12), (11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (0, 5), (0, 6)]
HOLD_ON, HOLD_OFF, EMA = 0.6, 0.4, 0.5      # hysteresis on smoothed P(holding)
MIN_HOLD_FRAMES = 4                          # must have held for this many frames before a release counts
BIN_MARGIN = 0.15                            # bin box grown by 15% each side: wrists end just over the rim
RECENT_IN_BIN = 6                            # wrist in a bin within this many frames of the release counts
TOLERANCE = 15                               # a detected drop within ±0.5 s of the true release counts


def keyframe_boxes(spec: dict, n: int) -> list:
    """Linear interpolation between given keyframe boxes; None outside [visible_from, visible_to]."""
    kf = sorted((int(f), b) for f, b in spec["keyframes"])
    lo, hi = spec.get("visible", [kf[0][0], kf[-1][0]])
    out = [None] * n
    for i in range(max(0, lo), min(n, hi + 1)):
        prev = max((k for k in kf if k[0] <= i), default=kf[0], key=lambda k: k[0])
        nxt = min((k for k in kf if k[0] >= i), default=kf[-1], key=lambda k: k[0])
        a = 0.0 if nxt[0] == prev[0] else (i - prev[0]) / (nxt[0] - prev[0])
        out[i] = tuple((1 - a) * p + a * q for p, q in zip(prev[1], nxt[1]))
    return out


def hand_crop(kp, side: str, w: int, h: int):
    e, wr = (7, 9) if side == "L" else (8, 10)
    if kp[wr][2] < 0.3 or kp[e][2] < 0.2:
        return None
    ex, ey, wx, wy = kp[e][0], kp[e][1], kp[wr][0], kp[wr][1]
    fore = max(60.0, float(np.hypot(wx - ex, wy - ey)))
    cx, cy = wx + 0.35 * (wx - ex), wy + 0.35 * (wy - ey)
    s = 0.6 * fore  # tight: the hand and what it holds, not the bin around it
    x0, y0, x1, y1 = int(max(0, cx - s)), int(max(0, cy - s)), int(min(w, cx + s)), int(min(h, cy + s))
    return (x0, y0, x1, y1, (wx, wy)) if x1 - x0 > 20 and y1 - y0 > 20 else None


def inside(pt, box, margin):
    x0, y0, x1, y1 = box
    mx, my = (x1 - x0) * margin, (y1 - y0) * margin
    return x0 - mx <= pt[0] <= x1 + mx and y0 - my <= pt[1] <= y1 + my


def text(img, s, org, color, scale=1.0):
    cv2.putText(img, s, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 6, cv2.LINE_AA)
    cv2.putText(img, s, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2, cv2.LINE_AA)


def run(video: Path, bins: list[dict], out_dir: Path, pose, cats) -> list[dict]:
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    h, w = frames[0].shape[:2]
    poses = [pose.predict(f, imgsz=960, device="mps", verbose=False, conf=0.3)[0] for f in frames]
    bin_boxes = {b["bin_id"]: keyframe_boxes(b, len(frames)) for b in bins}

    state = {s: {"ema": 0.0, "holding": False, "held": 0, "votes": {}, "in_bin": -99, "bin": None} for s in ("L", "R")}
    events, released = [], []
    out = out_dir / f"{video.stem}_hands.mp4"
    ff = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps),
                           "-i", "-", "-c:v", "libx264", "-crf", "26", "-preset", "veryfast", "-pix_fmt", "yuv420p", str(out)], stdin=subprocess.PIPE)
    banner = 0
    trace = {"L": [None] * len(frames), "R": [None] * len(frames), "in_bin": [False] * len(frames)}
    for i, (f, p) in enumerate(zip(frames, poses)):
        vis = f.copy()
        for bid, bx in bin_boxes.items():
            if bx[i] is None:
                continue
            x0, y0, x1, y1 = map(int, bx[i])
            cv2.rectangle(vis, (x0, y0), (x1, y1), (0, 200, 0), 4)
            text(vis, bid.replace("bin_", ""), (x0 + 8, y0 + 40), (120, 255, 120), 1.1)
        # main person = largest skeleton (one thrower per clip here)
        kps = p.keypoints.data.cpu().numpy() if p.keypoints is not None and len(p.keypoints) else np.zeros((0, 17, 3))
        if len(kps):
            areas = [(b[2] - b[0]) * (b[3] - b[1]) for b in p.boxes.xyxy.tolist()]
            kp = kps[int(np.argmax(areas))]
            for a, b in SKELETON:
                if kp[a][2] > 0.3 and kp[b][2] > 0.3:
                    cv2.line(vis, (int(kp[a][0]), int(kp[a][1])), (int(kp[b][0]), int(kp[b][1])), (255, 200, 0), 4)
            for j in range(17):
                if kp[j][2] > 0.3:
                    cv2.circle(vis, (int(kp[j][0]), int(kp[j][1])), 7, (0, 140, 255), -1)
        else:
            kp = None
        for side in ("L", "R"):
            st = state[side]
            c = hand_crop(kp, side, w, h) if kp is not None else None
            if c is None:
                st["ema"] *= 0.9
                continue
            x0, y0, x1, y1, wrist = c
            probs = cats.probabilities([f[y0:y1, x0:x1]])
            p_hold = 1 - probs[EMPTY]
            st["ema"] = EMA * p_hold + (1 - EMA) * st["ema"]
            trace[side][i] = round(float(p_hold), 3)
            for bid, bx in bin_boxes.items():
                if bx[i] is not None and inside(wrist, bx[i], BIN_MARGIN):
                    st["in_bin"], st["bin"] = i, bid
                    trace["in_bin"][i] = True
            if not st["holding"] and st["ema"] > HOLD_ON:
                st["holding"], st["held"], st["votes"] = True, 0, {}
            if st["holding"]:
                st["held"] += 1
                best = max((k for k in probs if k != EMPTY), key=probs.get)
                st["votes"][best] = st["votes"].get(best, 0) + probs[best]
                if st["ema"] < HOLD_OFF:
                    st["holding"] = False
                    item = max(st["votes"], key=st["votes"].get) if st["votes"] else None
                    rec = {"frame": i, "t": round(i / fps, 2), "hand": side, "item": item,
                           "item_bin_rule": CATALOG.get(item, {}).get("destination"), "held_frames": st["held"]}
                    if st["held"] >= MIN_HOLD_FRAMES and i - st["in_bin"] <= RECENT_IN_BIN:
                        rec["bin"] = st["bin"]
                        events.append(rec)
                        banner = int(fps * 1.5)
                    else:
                        released.append(rec)
            color = (0, 230, 255) if st["holding"] else (180, 180, 180)
            cv2.rectangle(vis, (x0, y0), (x1, y1), color, 3)
            label = max((k for k in probs if k != EMPTY), key=probs.get)
            cap_txt = f"{side}: holding {[pp for pp in PROMPTS[label]][0]} ({st['ema']:.2f})" if st["holding"] else f"{side}: empty ({st['ema']:.2f})"
            text(vis, cap_txt, (x0, max(40, y0 - 12)), color, 0.9)
        if banner > 0:
            e = events[-1]
            text(vis, f"DROP -> {e['bin']}: {e['item']} (rule: {e['item_bin_rule']})", (30, h - 60), (80, 255, 80), 1.2)
            banner -= 1
        text(vis, f"{video.stem}  frame {i}  t={i / fps:.2f}s  drops {len(events)}", (30, 60), (255, 255, 255), 1.1)
        ff.stdin.write(vis.tobytes())
    for side, st in state.items():  # clip ended while a hand still held something inside a bin opening
        if st["holding"] and st["held"] >= MIN_HOLD_FRAMES and len(frames) - 1 - st["in_bin"] <= RECENT_IN_BIN:
            item = max(st["votes"], key=st["votes"].get) if st["votes"] else None
            events.append({"frame": st["in_bin"], "t": round(st["in_bin"] / fps, 2), "hand": side, "item": item,
                           "item_bin_rule": CATALOG.get(item, {}).get("destination"), "held_frames": st["held"],
                           "bin": st["bin"], "probable": True})
    ff.stdin.close()
    ff.wait()
    (out_dir / f"{video.stem}_trace.json").write_text(json.dumps(trace))
    return events, released, len(frames), fps


def main():
    from ultralytics import YOLO

    out_dir = Path(sys.argv[1]).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    config = json.loads(Path(sys.argv[2]).read_text())
    pose = YOLO(str(WORKER / "weights/yolo11n-pose.pt"))
    cats = CategoryClassifier(ClipEmbedder(WORKER / "weights/clip/ViT-B-32.pt"), PROMPTS)
    results = {}
    for name, spec in config.items():
        events, released, n, fps = run(Path(spec["video"]).expanduser(), spec["bins"], out_dir, pose, cats)
        results[name] = {"events": events, "released_elsewhere": released, "frames": n, "fps": fps}
        print(name, json.dumps({"events": events, "released_elsewhere": released}), flush=True)
    (out_dir / "hand_results.json").write_text(json.dumps(results, indent=1))
    lines = ["| video | true drop (frame, bin) | detected drops | verdict | item (bin rule) |", "|---|---|---|---|---|"]
    tp = fp = fn = 0
    for name, spec in config.items():
        gt = spec.get("truth")
        evs = results[name]["events"]
        if not gt:
            continue
        hit = [e for e in evs if abs(e["frame"] - gt["frame"]) <= TOLERANCE and e["bin"] == gt["bin"]]
        tp += bool(hit); fn += not hit; fp += len(evs) - (1 if hit else 0)
        det = ", ".join(f"f{e['frame']}{'?' if e.get('probable') else ''}" for e in evs) or "none"
        verdict = ("HIT" + (f" ({hit[0]['frame'] - gt['frame']:+d} fr)" if hit else "")) if hit else "MISS"
        if len(evs) - (1 if hit else 0):
            verdict += f", {len(evs) - (1 if hit else 0)} false"
        item = f"{hit[0]['item']} ({hit[0]['item_bin_rule']})" if hit else "-"
        lines.append(f"| {name} | f{gt['frame']} {gt['bin']} | {det} | {verdict} | {item} |")
    lines.append(f"\nDrops found {tp}/{tp + fn}, false drops {fp}. Tolerance ±{TOLERANCE} frames. '?' = probable (clip ended while holding in the bin).")
    (out_dir / "hand_summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
