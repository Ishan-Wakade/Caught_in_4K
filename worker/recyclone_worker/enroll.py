"""Build the reference gallery from an enrollment clip shot with the demo camera.

Each item is held up in front of the bins for a few seconds; `segments` says which item is on
screen when. The largest non-person track in each sampled frame becomes a reference crop.
"""

from pathlib import Path

import cv2

from .identify import Embedder, Gallery


def largest_crop(frame, tracks):
    if not tracks:
        return None
    x1, y1, x2, y2 = max(tracks, key=lambda t: (t.box[2] - t.box[0]) * (t.box[3] - t.box[1])).box
    h, w = frame.shape[:2]
    x1, y1, x2, y2 = max(0, int(x1)), max(0, int(y1)), min(w, int(x2)), min(h, int(y2))
    return frame[y1:y2, x1:x2] if x2 > x1 and y2 > y1 else None


def enroll_from_segments(video: Path, segments: list[dict], tracker, embedder: Embedder, gallery: Gallery, every_n: int = 5) -> int:
    cap = cv2.VideoCapture(str(video))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    added, idx = 0, -1
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        idx += 1
        t = idx / fps
        seg = next((s for s in segments if s["start_s"] <= t < s["end_s"]), None)
        tracks = tracker.update(frame)  # keep the tracker fed every frame so IDs stay stable
        if seg is None or idx % every_n:
            continue
        crop = largest_crop(frame, tracks)
        if crop is not None:
            gallery.add(seg["catalog_item_id"], embedder.embed(crop))
            added += 1
    cap.release()
    return added
