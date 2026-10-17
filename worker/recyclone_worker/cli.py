"""recyclone-worker: run | enroll | replay-labeled | flush. See worker/README.md."""

import argparse
import json

import numpy as np
import os
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

from .client import BackgroundSink, HttpSink, MemorySink, flush_outbox
from .events import dumps_event, validate_event
from .identify import Gallery
from .pipeline import Pipeline
from .site import load_catalog, load_catalog_ids, load_profile, load_site
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


class FileSink:
    """Wraps another sink and also writes every event to a JSONL file (for `evaluate`)."""

    def __init__(self, inner, path: Path):
        self.inner, self.path = inner, Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text("")

    @property
    def stats(self):
        return self.inner.stats

    def send(self, event: dict) -> str:
        with self.path.open("a") as f:
            f.write(dumps_event(event) + "\n")
        return self.inner.send(event)

    def close(self, **kw):
        if hasattr(self.inner, "close"):
            self.inner.close(**kw)


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
    catalog = load_catalog(os.environ.get("API_BASE_URL"))
    if gallery.ids:
        unknown = set(gallery.ids) - set(catalog)
        if unknown:
            print(f"WARNING: gallery items not in the catalog (core will treat them as unknown): {sorted(unknown)}", file=sys.stderr)
    stream = None
    if not args.no_stream:
        from .stream import StreamServer, annotate

        stream = StreamServer(int(os.environ.get("WORKER_PORT", "8765")), Path(args.evidence_dir),
                              token=os.environ.get("WORKER_STREAM_TOKEN"))
        stream.start()
        prefix = "/s/<WORKER_STREAM_TOKEN>" if stream.token else ""
        print(f"stream: http://localhost:{stream.port}{prefix}/stream.mjpg", file=sys.stderr)
    on_frame = (lambda frame, tracks, regions: stream.publish(annotate(frame, tracks, regions))) if stream else None
    sink = PrintingSink() if args.dry_run else make_sink(args)
    if not args.dry_run and not args.no_background:
        sink = BackgroundSink(sink)
    if args.events_out:
        sink = FileSink(sink, Path(args.events_out))
    tracker, embedder = make_tracker(), make_embedder()  # load models before taking the clock
    categories = None
    if not args.no_categories and hasattr(embedder, "embed_text"):
        from .categories import CategoryClassifier

        categories = CategoryClassifier(embedder)
    profile = os.environ.get("CONFIG_PROFILE", "demo")
    reference_threshold = load_profile(profile)["item_confidence_threshold"]
    # Core rejects occurred_at more than 5 s in the future. Realtime: the clip "starts" now.
    # Faster than realtime: back-date the start by the clip length so every event is in the past.
    started_at = datetime.now(UTC) if args.realtime else datetime.now(UTC) - timedelta(seconds=source.duration_s)
    pipeline = Pipeline(
        load_site(args.camera), tracker, embedder, gallery, sink,
        clip_id=args.clip_id, started_at=started_at, evidence_dir=Path(args.evidence_dir), on_frame=on_frame,
        catalog_business=catalog, categories=categories, reference_threshold=reference_threshold,
    )
    try:
        events = pipeline.run(_realtime(source, source.fps) if args.realtime else source)
    finally:
        if stream:
            stream.stop()
        if hasattr(sink, "close"):
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


def cmd_evaluate(args) -> int:
    from .evaluate import evaluate, format_report

    read = lambda p: [json.loads(l) for l in Path(p).read_text().splitlines() if l.strip()]
    print(format_report(evaluate(read(args.labels), read(args.predicted), tolerance_s=args.tolerance_s)))
    return 0


def cmd_calibrate(args) -> int:
    from .calibrate import calibrate

    found = calibrate(Path(args.clip), args.camera, args.at_s)
    for bin_id, roi in found.items():
        print(f"{bin_id}: x={roi[0]} y={roi[1]} w={roi[2]} h={roi[3]}")
    print("saved to contracts/fixtures/demo-site.json (commit it so core and the worker agree)", file=sys.stderr)
    return 0


def cmd_label(args) -> int:
    from .label import label

    n = label(Path(args.clip), args.clip_id, args.camera, Path(args.out))
    print(f"saved {n} labeled drop(s) to {args.out}", file=sys.stderr)
    return 0


def cmd_suggest_thresholds(args) -> int:
    from .identify import ClipEmbedder
    from .thresholds import best_scores, suggest_threshold, taco_crops

    gallery = Gallery.load(Path(args.gallery))
    crops = taco_crops(Path(args.taco), n=args.n)
    scores = best_scores(crops, ClipEmbedder(Path(args.clip_weights)), gallery)
    t = suggest_threshold(scores, quantile=args.quantile)
    if t is None:
        raise SystemExit(f"no distractor crops found under {args.taco}")
    print(f"{len(scores)} non-catalog crops: median {np.median(scores):.3f}, max {max(scores):.3f}")
    print(f"suggested threshold (p{int(args.quantile * 100)}): {t}")
    print('set in contracts/fixtures/demo-site.json -> config_profiles.demo: "item_confidence_threshold" and '
          '"business_confidence_threshold" (then restart core; they are provisional values)')
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
    run.add_argument("--events-out", help="also write every event to this JSONL file (for `evaluate`)")
    run.add_argument("--no-categories", action="store_true", help="report unregistered items as unknown instead of a generic category")
    enroll = sub.add_parser("enroll", help="build reference gallery from an enrollment clip")
    enroll.add_argument("--clip", required=True)
    enroll.add_argument("--segments", required=True, help='JSON: [{"catalog_item_id", "start_s", "end_s"}]')
    enroll.add_argument("--out", required=True)
    enroll.add_argument("--every-n", type=int, default=5)
    enroll.add_argument("--camera", default="cam_patio_1")
    replay = sub.add_parser("replay-labeled", help="stage backup: post hand-labeled events")
    replay.add_argument("--file", required=True)
    replay.add_argument("--no-wait", action="store_true", help="send all at once instead of at their original pace")
    sub.add_parser("flush", help="resend events queued while the API was down")
    th = sub.add_parser("suggest-thresholds", help="calibrate core's confidence thresholds for CLIP scores")
    th.add_argument("--gallery", required=True)
    th.add_argument("--taco", default="~/recycle-cv/data/TACO/data", help="TACO data dir (annotations.json + batches)")
    th.add_argument("--n", type=int, default=200)
    th.add_argument("--quantile", type=float, default=0.99)
    th.add_argument("--clip-weights", default=str(DEFAULT_CLIP))
    ev = sub.add_parser("evaluate", help="compare worker events with hand labels")
    ev.add_argument("--labels", required=True)
    ev.add_argument("--predicted", required=True)
    ev.add_argument("--tolerance-s", type=float, default=1.5)
    cal = sub.add_parser("calibrate", help="draw the bin openings on a frame; saves demo-site.json")
    cal.add_argument("--clip", required=True)
    cal.add_argument("--camera", default="cam_patio_1")
    cal.add_argument("--at-s", type=float, default=1.0, help="which moment of the clip to show")
    lab = sub.add_parser("label", help="hand-label every drop -> demo-events.jsonl")
    lab.add_argument("--clip", required=True)
    lab.add_argument("--clip-id", required=True)
    lab.add_argument("--camera", default="cam_patio_1")
    lab.add_argument("--out", default=str(WORKER_DIR.parent / "contracts/fixtures/demo-events.jsonl"))
    for p in (run, enroll):
        p.add_argument("--tracker", choices=["yolo", "world", "motion"], default="yolo",
                       help="world = YOLO-World with packaging prompts; motion = background subtraction near the bins")
        p.add_argument("--world-weights", default=str(WORKER_DIR / "weights/yolov8s-worldv2.pt"))
        p.add_argument("--yolo", default=str(DEFAULT_YOLO))
        p.add_argument("--clip-weights", default=str(DEFAULT_CLIP))
    args = ap.parse_args(argv)

    if args.cmd in ("run", "enroll"):
        from .identify import ClipEmbedder
        from .tracking import YoloTracker

        if make_tracker is None and args.tracker == "world":
            from .tracking import WorldTracker

            make_tracker = lambda: WorldTracker(Path(args.world_weights))
        if make_tracker is None and args.tracker == "motion":
            from .motion import MotionTracker

            make_tracker = lambda: MotionTracker(load_site(args.camera).regions)
        make_tracker = make_tracker or (lambda: YoloTracker(Path(args.yolo)))
        make_embedder = make_embedder or (lambda: ClipEmbedder(Path(args.clip_weights)))
        return (cmd_run if args.cmd == "run" else cmd_enroll)(args, make_tracker, make_embedder)
    return {"replay-labeled": cmd_replay_labeled, "flush": cmd_flush, "evaluate": cmd_evaluate,
            "calibrate": cmd_calibrate, "label": cmd_label, "suggest-thresholds": cmd_suggest_thresholds}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
