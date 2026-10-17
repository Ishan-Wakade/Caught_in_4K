"""Per-frame look at REAL footage: is the item found (YOLO), what is it (CLIP category), which bin rule?

    uv run python scripts/real_viz.py OUT_DIR VIDEO:ITEM_IDS[:...] ...
    e.g.  ~/Downloads/IMG_9100.MOV:item_generic_paper_cup

ITEM_IDS = the catalog ids that count as a right identification (comma-separated). Writes an annotated
MP4 and a contact sheet per video plus summary.md. Handheld clips only allow this per-frame view; the
"did it go into the bin" decision needs a fixed camera.
"""

import json
import subprocess
import sys
from pathlib import Path

import cv2

from recyclone_worker.categories import CategoryClassifier
from recyclone_worker.identify import ClipEmbedder
from recyclone_worker.tracking import is_item_class

WORKER = Path(__file__).resolve().parents[1]
CATALOG = {i["catalog_item_id"]: i for i in json.loads((WORKER.parent / "contracts/fixtures/demo-site.json").read_text())["catalog"]}


def text(img, s, org, color, scale=1.0):
    cv2.putText(img, s, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 6, cv2.LINE_AA)
    cv2.putText(img, s, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, 2, cv2.LINE_AA)


def run(video: Path, truth: set[str], out_dir: Path, yolo, cats) -> dict:
    truth_bin = {CATALOG[t]["destination"] for t in truth}
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    ok, f = cap.read()
    h, w = f.shape[:2]
    out = out_dir / f"{video.stem}_annotated.mp4"
    ff = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}", "-r", str(fps),
                           "-i", "-", "-c:v", "libx264", "-crf", "26", "-preset", "veryfast", "-pix_fmt", "yuv420p", str(out)], stdin=subprocess.PIPE)
    i = found = classified = right = rule_right = 0
    names, last, sheet = {}, None, []
    while ok:
        r = yolo.predict(f, imgsz=960, conf=0.25, device="mps", verbose=False)[0]
        dets = [(yolo.names[int(c)], float(s), b) for c, s, b in zip(r.boxes.cls, r.boxes.conf, r.boxes.xyxy.tolist())]
        items = [d for d in dets if is_item_class(d[0])]
        for name, s, (x1, y1, x2, y2) in dets:
            if not is_item_class(name):
                cv2.rectangle(f, (int(x1), int(y1)), (int(x2), int(y2)), (200, 120, 40), 2)
                text(f, f"{name} (ignored)", (int(x1) + 6, int(y1) + 30), (230, 170, 90), 0.8)
        if items:
            found += 1
            name, s, (x1, y1, x2, y2) = max(items, key=lambda d: (d[2][2] - d[2][0]) * (d[2][3] - d[2][1]))
            names[name] = names.get(name, 0) + 1
            if i % 3 == 0 or last is None:
                crop = f[int(y1):int(y2), int(x1):int(x2)]
                if crop.size:
                    last = cats.classify([crop])
                    classified += 1
                    right += last[0] in truth
                    rule_right += CATALOG.get(last[0], {}).get("destination") in truth_bin
            cv2.rectangle(f, (int(x1), int(y1)), (int(x2), int(y2)), (0, 230, 255), 4)
            text(f, f"YOLO: {name} {s:.2f}", (int(x1), max(40, int(y1) - 55)), (0, 230, 255), 1.0)
            if last:
                cid, p, prompt = last
                good = cid in truth
                text(f, f"CLIP: {prompt} {p:.2f} -> {CATALOG.get(cid, {}).get('destination', '?')}", (int(x1), max(80, int(y1) - 15)),
                     (120, 255, 120) if good else (80, 80, 255), 1.0)
        else:
            text(f, "no item detected this frame", (30, h - 40), (90, 90, 255), 1.1)
        text(f, f"{video.stem}  frame {i}  item found in {found}/{i + 1} frames", (30, 60), (255, 255, 255), 1.1)
        ff.stdin.write(f.tobytes())
        if i % 25 == 10:
            sheet.append(cv2.resize(f, (w // 4, h // 4)))
        i += 1
        ok, f = cap.read()
    ff.stdin.close()
    ff.wait()
    if sheet:
        rows = [cv2.hconcat(sheet[k:k + 6]) for k in range(0, len(sheet), 6)]
        width = rows[0].shape[1]
        rows = [r if r.shape[1] == width else cv2.copyMakeBorder(r, 0, 0, 0, width - r.shape[1], cv2.BORDER_CONSTANT) for r in rows]
        cv2.imwrite(str(out_dir / f"{video.stem}_sheet.jpg"), cv2.vconcat(rows))
    return {"video": video.stem, "frames": i, "found": found, "classified": classified, "right": right, "rule_right": rule_right,
            "truth": sorted(truth), "truth_bin": sorted(truth_bin), "yolo_names": dict(sorted(names.items(), key=lambda kv: -kv[1])[:3])}


def main():
    from ultralytics import YOLO

    out_dir = Path(sys.argv[1]).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    yolo = YOLO(str(WORKER / "weights/yolo11n.pt"))
    cats = CategoryClassifier(ClipEmbedder(WORKER / "weights/clip/ViT-B-32.pt"))
    rows = []
    for spec in sys.argv[2:]:
        path, _, ids = spec.rpartition(":")
        res = run(Path(path).expanduser(), set(ids.split(",")), out_dir, yolo, cats)
        rows.append(res)
        print(json.dumps(res), flush=True)
    pct = lambda a, b: f"{100 * a / b:.0f}%" if b else "n/a"
    lines = ["| video | right answer | item found (frames) | category right | bin rule right | YOLO called it |", "|---|---|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['video']} | {', '.join(r['truth'])} ({'/'.join(r['truth_bin'])}) | {r['found']}/{r['frames']} ({pct(r['found'], r['frames'])}) "
                     f"| {r['right']}/{r['classified']} ({pct(r['right'], r['classified'])}) | {r['rule_right']}/{r['classified']} ({pct(r['rule_right'], r['classified'])}) "
                     f"| {', '.join(f'{k} {v}' for k, v in r['yolo_names'].items())} |")
    (out_dir / "summary.md").write_text("Real handheld footage, plain YOLO11n + CLIP categories (no training on these videos).\n\n" + "\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
