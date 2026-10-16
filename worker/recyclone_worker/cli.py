"""recyclone-worker: run | enroll | replay-labeled | flush. See worker/README.md."""

import argparse
import json
import os
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .client import BackgroundSink, HttpSink, MemorySink, flush_outbox
from .events import dumps_event, validate_event
from .identify import Gallery
from .pipeline import Pipeline
from .site import load_catalog_ids, load_site
from .sources import RecordedClipSource

WORKER_DIR = Path(__file__).resolve().parents[1]
DEFAULT_YOLO = WORKER_DIR / "weights/yolo11n.pt"
DEFAULT_CLIP = WORKER_DIR / "weights/clip/ViT-B-32.pt"
OUTBOX = WORKER_DIR / "state/outbox.jsonl"


def make_sink(args):
    base, token = os.environ.get("API_BASE_URL"), os.environ.get("WORKER_INGEST_TOKEN")
    if not base or not token:
        raise SystemExit("set API_BASE_URL and WORKER_INGEST_TOKEN (see .env.example), or use --dry-run")
    return HttpSink(base, token, OUTBOX)


class PrintingSink(MemorySink):
    def send(self, event: dict) -> str:
        print(dumps_event(event), flush=True)
        return super().send(event)


def _realtime(source, fps: float, warn_after_s: float = 1.0):
    """Play at clip speed. Measured 16 Oct: YOLO11n on MPS tracks ~50 fps at imgsz 960, so a 30 fps
    clip keeps up; on CPU (~20 fps) it would fall behind, and this says so instead of drifting silently."""
    t0, warned = time.monotonic(), False
    for idx, offset, frame in source:
        delay = offset - (time.monotonic() - t0)
        if delay > 0:
            time.sleep(delay)
        elif -delay > warn_after_s and not warned:
            print(f"WARNING: realtime playback is {-delay:.1f} s behind the clip (model too slow for this fps)", file=sys.stderr)
            warned = True
        yield idx, offset, frame


def summarize(stats) -> None:
    order = ["created", "duplicate", "queued", "rejected"]
    print("delivery: " + ", ".join(f"{k} {stats.get(k, 0)}" for k in order), file=sys.stderr)
    total = sum(stats.get(k, 0) for k in order)
    if total and stats.get("duplicate", 0) == total:
        print("WARNING: every event was a duplicate, so nothing new reached the dashboard. "
              "Did you POST /api/demo/reset after the last rehearsal?", file=sys.stderr)
    if stats.get("queued", 0) > 0:
        print("WARNING: some events are still queued in state/outbox.jsonl; run `recyclone-worker flush`.", file=sys.stderr)


def cmd_run(args, make_tracker, make_embedder) -> int:
    source = RecordedClipSource(Path(args.clip))
    gallery = Gallery.load(Path(args.gallery)) if args.gallery else Gallery()
    if not gallery.ids:
        print("note: no reference gallery; every item will be sent as unknown", file=sys.stderr)
    else:
        unknown = set(gallery.ids) - load_catalog_ids(os.environ.get("API_BASE_URL"))
        if unknown:
            print(f"WARNING: gallery items not in the catalog (core will treat them as unknown): {sorted(unknown)}", file=sys.stderr)
    stream = None
    if not args.no_stream:
        from .stream import StreamServer, annotate

        stream = StreamServer(int(os.environ.get("WORKER_PORT", "8765")), Path(args.evidence_dir))
        stream.start()
        print(f"stream: http://localhost:{stream.port}/stream.mjpg", file=sys.stderr)
    on_frame = (lambda frame, tracks, regions: stream.publish(annotate(frame, tracks, regions))) if stream else None
    sink = PrintingSink() if args.dry_run else make_sink(args)
    if not args.dry_run and not args.no_background:
        sink = BackgroundSink(sink)
    tracker, embedder = make_tracker(), make_embedder()  # load models before taking the clock
    # Core rejects occurred_at more than 5 s in the future. Realtime: the clip "starts" now.
    # Faster than realtime: back-date the start by the clip length so every event is in the past.
    started_at = datetime.now(UTC) if args.realtime else datetime.now(UTC) - timedelta(seconds=source.duration_s)
    pipeline = Pipeline(
        load_site(args.camera), tracker, embedder, gallery, sink,
        clip_id=args.clip_id, started_at=started_at, evidence_dir=Path(args.evidence_dir), on_frame=on_frame,
    )
    try:
        events = pipeline.run(_realtime(source, source.fps) if args.realtime else source)
    finally:
        if stream:
            stream.stop()
        if isinstance(sink, BackgroundSink):
            sink.close()
    print(f"{len(events)} event(s) from {args.clip}", file=sys.stderr)
    summarize(sink.stats)
    return 0


def cmd_enroll(args, make_tracker, make_embedder) -> int:
    from .enroll import enroll_from_segments

    segments = json.loads(Path(args.segments).read_text())
    catalog = load_catalog_ids(os.environ.get("API_BASE_URL"))
    unknown = sorted({s["catalog_item_id"] for s in segments} - catalog)
    if unknown:
        raise SystemExit(f"segments name items that are not in the catalog: {unknown}")
    gallery = Gallery.load(Path(args.out)) if Path(args.out).exists() else Gallery()
    n = enroll_from_segments(Path(args.clip), segments, make_tracker(), make_embedder(), gallery, every_n=args.every_n)
    gallery.save(Path(args.out))
    print(f"added {n} reference crop(s); gallery now has {len(gallery.ids)} in {args.out}", file=sys.stderr)
    return 0


def _parse(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def cmd_replay_labeled(args) -> int:
    """Stage backup: post hand-labeled events. Start from POST /api/demo/reset (contract §6).

    The file's timestamps are from when it was labeled. They are shifted so the replay happens now,
    keeping the gaps: by default each event is sent when its moment arrives (so the dashboard plays
    it like the real clip); --no-wait sends at once with the last event at "now".
    """
    sink = make_sink(args)
    events = [json.loads(l) for l in Path(args.file).read_text().splitlines() if l.strip()]
    if not events:
        return 0
    first, last = _parse(events[0]["occurred_at"]), _parse(events[-1]["occurred_at"])
    start = datetime.now(UTC) - ((last - first) if args.no_wait else timedelta(0))
    t0 = time.monotonic()
    for event in events:
        gap = _parse(event["occurred_at"]) - first
        event["occurred_at"] = _iso(start + gap)
        validate_event(event)
        if not args.no_wait:
            time.sleep(max(0.0, gap.total_seconds() - (time.monotonic() - t0)))
        sink.send(event)
    print(f"replayed {len(events)} labeled event(s)", file=sys.stderr)
    summarize(sink.stats)
    return 0


def cmd_flush(args) -> int:
    sent, left = flush_outbox(make_sink(args))
    print(f"resent {sent}, still queued {left}", file=sys.stderr)
    return 0 if left == 0 else 1


def main(argv=None, *, make_tracker=None, make_embedder=None) -> int:
    ap = argparse.ArgumentParser(prog="recyclone-worker")
    sub = ap.add_subparsers(dest="cmd", required=True)
    run = sub.add_parser("run", help="process a recorded clip")
    run.add_argument("--clip", required=True)
    run.add_argument("--clip-id", required=True)
    run.add_argument("--camera", default="cam_patio_1")
    run.add_argument("--gallery", help="reference .npz from `enroll`")
    run.add_argument("--evidence-dir", default=str(WORKER_DIR / "evidence"))
    run.add_argument("--dry-run", action="store_true", help="print events instead of posting")
    run.add_argument("--realtime", action="store_true", help="play at clip speed (live demo)")
    run.add_argument("--no-stream", action="store_true")
    run.add_argument("--no-background", action="store_true", help="send events inline (debugging)")
    enroll = sub.add_parser("enroll", help="build reference gallery from an enrollment clip")
    enroll.add_argument("--clip", required=True)
    enroll.add_argument("--segments", required=True, help='JSON: [{"catalog_item_id", "start_s", "end_s"}]')
    enroll.add_argument("--out", required=True)
    enroll.add_argument("--every-n", type=int, default=5)
    replay = sub.add_parser("replay-labeled", help="stage backup: post hand-labeled events")
    replay.add_argument("--file", required=True)
    replay.add_argument("--no-wait", action="store_true", help="send all at once instead of at their original pace")
    sub.add_parser("flush", help="resend events queued while the API was down")
    for p in (run, enroll):
        p.add_argument("--yolo", default=str(DEFAULT_YOLO))
        p.add_argument("--clip-weights", default=str(DEFAULT_CLIP))
    args = ap.parse_args(argv)

    if args.cmd in ("run", "enroll"):
        from .identify import ClipEmbedder
        from .tracking import YoloTracker

        make_tracker = make_tracker or (lambda: YoloTracker(Path(args.yolo)))
        make_embedder = make_embedder or (lambda: ClipEmbedder(Path(args.clip_weights)))
        return (cmd_run if args.cmd == "run" else cmd_enroll)(args, make_tracker, make_embedder)
    return {"replay-labeled": cmd_replay_labeled, "flush": cmd_flush}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
