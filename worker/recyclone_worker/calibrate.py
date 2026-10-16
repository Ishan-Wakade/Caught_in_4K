"""Mark where each bin opening is in the demo camera's frame and save it to demo-site.json.

Run once per camera setup: `recyclone-worker calibrate --clip demo.mp4`. A window shows one frame;
drag a rectangle over each bin's opening when its name appears, then ENTER (ESC/c to skip a bin).
"""

import json
from pathlib import Path

import cv2

from .site import CONTRACTS


def normalize_roi(px: tuple[int, int, int, int], frame_size: tuple[int, int]) -> tuple[float, float, float, float]:
    x, y, w, h = px
    fw, fh = frame_size
    return round(x / fw, 4), round(y / fh, 4), round(w / fw, 4), round(h / fh, 4)


def write_regions(fixture: Path, camera_id: str, regions: dict[str, tuple[float, float, float, float]]) -> None:
    data = json.loads(Path(fixture).read_text())
    camera = next(c for c in data["cameras"] if c["camera_id"] == camera_id)
    for r in camera["bin_regions"]:
        if r["bin_id"] in regions:
            r["x"], r["y"], r["w"], r["h"] = regions[r["bin_id"]]
    Path(fixture).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def calibrate(clip: Path, camera_id: str, at_s: float, fixture: Path = CONTRACTS / "fixtures/demo-site.json") -> dict:
    cap = cv2.VideoCapture(str(clip))
    cap.set(cv2.CAP_PROP_POS_MSEC, at_s * 1000)
    ok, frame = cap.read()
    cap.release()
    if not ok:
        raise SystemExit(f"cannot read a frame at {at_s}s from {clip}")
    data = json.loads(Path(fixture).read_text())
    camera = next((c for c in data["cameras"] if c["camera_id"] == camera_id), None)
    if camera is None:
        raise SystemExit(f"camera {camera_id} not in {fixture}")
    size = (frame.shape[1], frame.shape[0])
    found = {}
    for r in camera["bin_regions"]:
        title = f"Drag over the OPENING of {r['bin_id']}, then ENTER (c = skip)"
        x, y, w, h = cv2.selectROI(title, frame, showCrosshair=False)
        cv2.destroyWindow(title)
        if w and h:
            found[r["bin_id"]] = normalize_roi((x, y, w, h), size)
            cv2.rectangle(frame, (x, y), (x + w, y + h), (0, 200, 255), 2)
    cv2.destroyAllWindows()
    write_regions(fixture, camera_id, found)
    return found
