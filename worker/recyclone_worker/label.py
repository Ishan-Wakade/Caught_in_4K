"""Hand-label every drop in a clip -> contracts/fixtures/demo-events.jsonl (evaluation + stage backup).

Keys in the video window: SPACE play/pause, a/d one frame back/forward, j/l one second back/forward,
m mark a drop at the current frame (then answer in the terminal), u undo last, q save and quit.
"""

import json
from datetime import UTC, datetime
from pathlib import Path

import cv2

from .evaluate import labeled_event
from .events import dumps_event, validate_event
from .site import CONTRACTS


def _ask(prompt: str, choices: dict[str, str | None]) -> str | None:
    while True:
        answer = input(prompt).strip().lower()
        if answer in choices:
            return choices[answer]
        print(f"  pick one of: {', '.join(k or '(enter)' for k in choices)}")


def label(clip: Path, clip_id: str, camera_id: str, out: Path, fixture: Path = CONTRACTS / "fixtures/demo-site.json") -> int:
    site = json.loads(Path(fixture).read_text())
    bins = [b for b in site["bins"] if b["camera_id"] == camera_id]
    bin_keys = {b["type"][0]: b["bin_id"] for b in bins}  # t / r / c
    items = {str(n): i["catalog_item_id"] for n, i in enumerate(site["catalog"], start=1)} | {"0": None}
    businesses = {str(n): b["business_id"] for n, b in enumerate(site["businesses"], start=1)} | {"": None}
    print("items:  " + "  ".join(f"{n}={i or 'unknown'}" for n, i in items.items()))
    print("business (only if a logo is clearly visible): " + "  ".join(f"{n}={b}" for n, b in businesses.items() if n))

    cap = cv2.VideoCapture(str(clip))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    started_at = datetime.now(UTC)  # replay-labeled shifts timestamps anyway
    events: list[dict] = []
    idx, playing = 0, False
    while True:
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            idx, playing = max(0, idx - 1), False
            continue
        cv2.putText(frame, f"{idx / fps:7.2f}s  frame {idx}/{total}  drops {len(events)}  [m]ark [u]ndo [q]uit",
                    (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 255), 2)
        cv2.imshow("label drops", frame)
        key = cv2.waitKey(int(1000 / fps) if playing else 0) & 0xFF
        step = {ord("d"): 1, ord("a"): -1, ord("l"): int(fps), ord("j"): -int(fps)}
        if key == ord("q"):
            break
        if key == ord(" "):
            playing = not playing
        elif key in step:
            idx, playing = min(max(0, idx + step[key]), max(0, total - 1)), False
        elif key == ord("u") and events:
            print(f"  undone: {events.pop()['bin_id']}")
        elif key == ord("m"):
            playing = False
            item = _ask("  item number: ", items)
            bin_id = _ask(f"  bin ({'/'.join(bin_keys)}): ", bin_keys)
            business = _ask("  business number (enter = none): ", businesses)
            e = labeled_event(row=len(events) + 1, clip_id=clip_id, camera_id=camera_id, started_at=started_at,
                              offset_s=idx / fps, bin_id=bin_id, catalog_item_id=item, business_id=business)
            validate_event(e)
            events.append(e)
            print(f"  #{len(events)} at {idx / fps:.2f}s: {item or 'unknown'} -> {bin_id}")
        elif playing:
            idx += 1
    cap.release()
    cv2.destroyAllWindows()
    events.sort(key=lambda e: e["clip_offset_s"])
    Path(out).write_text("".join(dumps_event(e) + "\n" for e in events))
    return len(events)
