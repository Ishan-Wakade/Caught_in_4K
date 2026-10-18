"""recyclone-worker: run | enroll | replay-labeled | flush | ... See worker/README.md."""

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
NO_BINS = 3  # guide --headless exit code: --area auto found no bins (job.py turns it into "no_bins")


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

        stream = StreamServer(int(os.environ.get("WORKER_PORT", "8765")), Path(args.evidence_dir))
        stream.start()
        print(f"stream: http://localhost:{stream.port}/stream.mjpg", file=sys.stderr)
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


def item_bins_from_file(path: Path, clip_id: str):
    """Bin boxes from an item-tracker config (scripts/item_tracker.py format), for a moving/handheld camera:
    the entry named clip_id, or the whole file if it has a top-level "bins" list."""
    from .items import keyframe_boxes

    config = json.loads(Path(path).read_text())
    spec = config.get(clip_id, config)
    if "bins" not in spec:
        raise SystemExit(f'{path} has no entry "{clip_id}" and no top-level "bins"')
    return lambda size, n: {b["bin_id"]: keyframe_boxes(b, n) for b in spec["bins"]}


def cmd_run_items(args, analyze_items=None) -> int:
    """--tracker items: analyze the whole clip first (cached, ~2 fps), then play it at clip speed and send each
    drop's event when the video reaches it (Eymen, 17 Oct: pre-process, play live)."""
    from .item_playback import ItemPlayback
    from .items import analyze, site_bin_boxes

    source = RecordedClipSource(Path(args.clip))
    site = load_site(args.camera)
    if args.gallery:
        print("note: --tracker items names items from text prompts; --gallery is ignored", file=sys.stderr)
    bins_for = item_bins_from_file(Path(args.item_bins), args.clip_id) if args.item_bins \
        else (lambda size, n: site_bin_boxes(site.regions, size, n))
    t0 = time.monotonic()
    print(f"analyzing {args.clip} (cached in {args.items_cache}; a new clip takes ~0.5 s per frame) ...", file=sys.stderr)
    analysis = (analyze_items or analyze)(Path(args.clip), Path(args.items_cache), bins_for)
    print(f"analysis: {len(analysis.events)} drop(s) in {time.monotonic() - t0:.0f} s", file=sys.stderr)
    if args.namer == "deepseek":
        from .namer import DeepSeekNamer, pick_views, read_crops

        llm = DeepSeekNamer(WORKER_DIR / "state/vlm-cache")
        if not llm.available:
            print("note: --namer deepseek but no DEEPSEEK_API_KEY (env or ~/.config/recyclone/deepseek.env); items named by CLIP", file=sys.stderr)
        advisor = None
        if args.local_rules:
            from .generic import BinAdvisor

            advisor = BinAdvisor(Path(args.local_rules), WORKER_DIR / "state/generic-types.json")
            if not advisor.available:
                print("note: no TYPESAFE_API_KEY (env or ~/.config/recyclone/jev.env); new item types get no bin suggestion", file=sys.stderr)
        for drop in analysis.events:
            views = pick_views(analysis.tracks, analysis.per_frame, analysis.data, analysis.bins, drop["item_id"], drop["frame"])
            crops = read_crops(Path(args.clip), views)
            drop["llm"] = llm.name(crops)
            if drop["llm"] and drop["llm"]["catalog_item_id"] is None:  # not in the catalog: propose a generic type
                from .generic import for_event, generic_type

                drop["llm"]["generic"] = llm.describe(crops)
                gt = generic_type(drop["llm"])
                if gt is not None:
                    drop["llm"]["proposed_type"] = for_event(advisor.suggest(gt) if advisor and advisor.available else gt)
                    pt = drop["llm"]["proposed_type"]
                    print(f"new item type {pt['generic_type_id']} ({pt['name']}): suggested {pt['suggested_destination']} "
                          f"({pt['suggestion_confidence']}) under {pt['rule_source']}", file=sys.stderr)
        print(f"DeepSeek naming: {llm.usage}" + (f"; Jev: {advisor.usage}" if advisor else ""), file=sys.stderr)
    unknown_bins = {e["bin"] for e in analysis.events} - {r.bin_id for r in site.regions}
    if unknown_bins:
        print(f"WARNING: bins not in {args.camera}'s site config (core will reject them): {sorted(unknown_bins)}", file=sys.stderr)
    catalog = load_catalog(os.environ.get("API_BASE_URL"))
    stream = None
    if not args.no_stream:
        from .stream import StreamServer

        stream = StreamServer(int(os.environ.get("WORKER_PORT", "8765")), Path(args.evidence_dir))
        stream.start()
        print(f"stream: http://localhost:{stream.port}/stream.mjpg", file=sys.stderr)
    sink = PrintingSink() if args.dry_run else make_sink(args)
    if not args.dry_run and not args.no_background:
        sink = BackgroundSink(sink)
    if args.events_out:
        sink = FileSink(sink, Path(args.events_out))
    started_at = datetime.now(UTC) if args.realtime else datetime.now(UTC) - timedelta(seconds=source.duration_s)
    playback = ItemPlayback(analysis, sink, camera_id=site.camera_id, clip_id=args.clip_id, started_at=started_at,
                            evidence_dir=Path(args.evidence_dir), catalog_business=catalog,
                            on_frame=stream.publish if stream else None)
    try:
        events = playback.run(_realtime(source, source.fps) if args.realtime else source)
    finally:
        if stream:
            stream.stop()
        if hasattr(sink, "close"):
            sink.close()
    print(f"{len(events)} event(s) from {args.clip}", file=sys.stderr)
    summarize(sink.stats)
    return 0


def cmd_run_station(args, analyze_items=None) -> int:
    """Several cameras of one station (multicam.py): each camera through the item tracker, unchanged; drops merged
    across cameras and reported by the camera the person faced; a combined view with the active camera marked."""
    import subprocess

    from .item_playback import ItemPlayback
    from .items import analyze, keyframe_boxes, site_bin_boxes
    from .multicam import CameraRun, StationPlayback, fuse, load_station, station_started_at

    station = load_station(Path(args.station))
    catalog = load_catalog(os.environ.get("API_BASE_URL"))
    cams = []
    for c in station["cameras"]:
        video = Path(c["video"]).expanduser()
        if c.get("bins"):
            bins_for = (lambda spec: lambda size, n: {b["bin_id"]: keyframe_boxes(b, n) for b in spec})(c["bins"])
        else:
            site = load_site(c["camera_id"])
            bins_for = (lambda regions: lambda size, n: site_bin_boxes(regions, size, n))(site.regions)
        print(f"analyzing {c['camera_id']}: {video} ...", file=sys.stderr)
        analysis = (analyze_items or analyze)(video, Path(args.items_cache), bins_for)
        cams.append(CameraRun(c["camera_id"], analysis, float(c.get("offset_s", 0.0)), video))
        views = {v: cams[-1].facing.count(v) for v in ("front", "back", "unknown", "none")}
        print(f"  {c['camera_id']}: {len(analysis.events)} drop(s); person facing it {views['front']} frames, back {views['back']}", file=sys.stderr)
    fused = fuse(cams)
    print(f"station: {sum(len(c.analysis.events) for c in cams)} camera drop(s) -> {len(fused)} drop(s)", file=sys.stderr)
    if args.namer == "deepseek":
        from .namer import DeepSeekNamer, pick_views, read_crops

        llm = DeepSeekNamer(WORKER_DIR / "state/vlm-cache")
        by_id = {c.camera_id: c for c in cams}
        for d in fused:  # named once per physical drop, from the camera that reports it
            c = by_id[d["camera_id"]]
            a = c.analysis
            views = pick_views(a.tracks, a.per_frame, a.data, a.bins, d["drop"]["item_id"], d["drop"]["frame"])
            d["drop"]["llm"] = llm.name(read_crops(c.video, views))
    sink = PrintingSink() if args.dry_run else make_sink(args)
    if not args.dry_run and not args.no_background:
        sink = BackgroundSink(sink)
    if args.events_out:
        sink = FileSink(sink, Path(args.events_out))
    started_at = station_started_at(cams, args.realtime)
    playbacks = {c.camera_id: ItemPlayback(c.analysis, sink, camera_id=c.camera_id, clip_id=args.clip_id,
                                           started_at=started_at + timedelta(seconds=c.offset_s),
                                           evidence_dir=Path(args.evidence_dir), catalog_business=catalog) for c in cams}
    stream, writer = None, None
    if not args.no_stream:
        from .stream import StreamServer

        stream = StreamServer(int(os.environ.get("WORKER_PORT", "8765")), Path(args.evidence_dir))
        stream.start()
        print(f"stream: http://localhost:{stream.port}/stream.mjpg", file=sys.stderr)

    def on_frame(grid):
        nonlocal writer
        if stream:
            stream.publish(grid)
        if args.render:
            if writer is None:
                h, w = grid.shape[:2]
                fps = max(c.fps for c in cams)
                writer = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                                           "-r", str(fps), "-i", "-", "-c:v", "libx264", "-crf", "26", "-preset", "veryfast",
                                           "-pix_fmt", "yuv420p", str(args.render)], stdin=subprocess.PIPE)
            writer.stdin.write(np.ascontiguousarray(grid).tobytes())

    try:
        events = StationPlayback(cams, fused, playbacks, on_frame=on_frame if (stream or args.render) else None,
                                 realtime=args.realtime).run()
    finally:
        if stream:
            stream.stop()
        if writer:
            writer.stdin.close()
            writer.wait()
        if hasattr(sink, "close"):
            sink.close()
    print(f"{len(events)} event(s) from station {station['station_id']}", file=sys.stderr)
    summarize(sink.stats)
    return 0


def demo_memory_dir(log: Path) -> Path:
    """Where the prerecorded demo remembers what the model said: next to the guide log (worker/state by default)."""
    return Path(log).parent / "demo-memory"


def area_from_roi(roi) -> str | None:
    """cv2.selectROI's (x, y, w, h) -> "x0,y0,x1,y1"; None for an empty box (Enter without dragging)."""
    x, y, w, h = (int(v) for v in roi)
    return f"{x},{y},{x + w},{y + h}" if w >= 10 and h >= 10 else None


def cmd_guide(args, make_guide_parts=None) -> int:
    """Voice guide (docs/superpowers/specs/2026-10-17-voice-guidance-roadmap-design.md): a person with waste close to
    the bins hears "<bin>. <explanation>". Live camera (index / Continuity Camera / rtsp://) or a recorded file."""
    import subprocess
    import tempfile

    import cv2

    from . import guide_message as gm
    from .approach import Approach, BinArea
    from .guide import Guide, YoloPoseTracker
    from .sources import LiveCameraSource
    from .voice import ElevenLabsVoice, SayVoice, SilentVoice, elevenlabs_config, mix_audio

    homography = np.array(json.loads(Path(args.homography).read_text())) if args.homography else None
    live = args.source.isdigit() or "://" in args.source or args.source.startswith("avf:")
    table = gm.load_bin_table(Path(args.bins))
    speaker = tunnel = None
    if args.speaker != "mac":  # a second phone plays the voice (recyclone_worker/phone_speaker.py)
        from .phone_speaker import PhoneSpeaker, lan_urls, start_tunnel

        speaker = PhoneSpeaker(args.speaker_port)
        speaker.start()
        if args.speaker_tunnel:
            tunnel, public = start_tunnel(speaker.port)
            if public:
                print(f"phone speaker (any network, via Cloudflare tunnel): open on the speaker phone, tap once:\n"
                      f"  {public}/s/{speaker.token}/", file=sys.stderr)
            else:
                print("note: could not start a Cloudflare tunnel (is cloudflared installed?); use a LAN URL", file=sys.stderr)
        print("phone speaker on the same Wi-Fi:", file=sys.stderr)
        for url in lan_urls(speaker.port, speaker.token):
            print(f"  {url}", file=sys.stderr)
        if not (live or args.realtime):
            print("note: a file without --realtime is not spoken, so the phone stays silent", file=sys.stderr)
    if args.voice == "silent":
        voice = SilentVoice()
    else:
        player = (lambda f: None) if args.speaker == "phone" else None  # None = afplay on the Mac
        common = dict(play=live or args.realtime, player=player, on_say=speaker.announce if speaker else None)
        el_key, el_voice = elevenlabs_config()
        if args.voice in ("auto", "elevenlabs") and el_key and el_voice:
            voice = ElevenLabsVoice(WORKER_DIR / "state/voice-cache", key=el_key, voice_id=el_voice, **common)
            print("voice: ElevenLabs (macOS say if it fails)", file=sys.stderr)
        else:
            if args.voice == "elevenlabs":
                print("note: no ElevenLabs key (ELEVENLABS_API_KEY + voice id, or ~/.config/recyclone/elevenlabs.env); "
                      "using macOS say", file=sys.stderr)
            voice = SayVoice(WORKER_DIR / "state/voice-cache", **common)
            print("voice: macOS say", file=sys.stderr)
    voice.prepare([gm.spoken(gm.from_catalog(c, table)) for c in table] + [gm.spoken(gm.default_trash(None))])  # before the camera
    source = LiveCameraSource(args.source) if live else RecordedClipSource(Path(args.source))
    openings: list[dict] = []
    if args.headless and args.area == "pick":
        print("--headless cannot draw the area by hand: pass --area auto or x0,y0,x1,y1", file=sys.stderr)
        return 2
    if args.area == "auto":  # find the bins with a vision model (bins.py); fixed camera: once, on the first frame
        from . import bins

        print("stage: finding bins", file=sys.stderr)

        first_frame = next(iter(LiveCameraSource(args.source) if live else RecordedClipSource(Path(args.source))))[2]
        openings = bins.detect_openings(first_frame, WORKER_DIR / "state/bins-cache")
        if openings:
            args.area = ",".join(str(v) for v in bins.area_from_openings(openings, first_frame.shape[1], first_frame.shape[0]))
            print("bins: " + ", ".join(f"{o['label']} ({o['bin']})" for o in openings) + f"  -> --area {args.area}", file=sys.stderr)
        elif args.headless:  # no one to draw it (the upload page): the caller asks the person for a box instead
            print("bins: none found", file=sys.stderr)
            return NO_BINS
        else:
            print("bins: none found; draw the area by hand", file=sys.stderr)
            args.area = "pick"
    if args.area == "pick":  # draw the box around the bins on the first frame with the mouse
        picker = LiveCameraSource(args.source) if live else RecordedClipSource(Path(args.source))
        first = next(iter(picker))[2]
        if hasattr(picker, "close"):
            picker.close()  # otherwise its reader kept the camera busy for the whole session
        title = "STILL FRAME: drag ONE box around all the bins (and the floor in front), then press Enter"
        while (area := area_from_roi(cv2.selectROI(title, first, showCrosshair=False))) is None:
            print("no box drawn: drag a box around the bins, then press Enter", file=sys.stderr)
        cv2.destroyAllWindows()
        args.area = area
        print(f"bin area: --area {args.area}  (reuse it next time)", file=sys.stderr)
    area = BinArea(*[float(v) for v in args.area.split(",")])
    namer_used = {"namer": None}  # for the cost line at the end (the prepared demo's pass 2 drops the watcher's namer)
    if make_guide_parts is not None:
        pose, watcher = make_guide_parts(args, area)
    else:
        from .guide_identify import ItemWatcher
        from .items import Clip, Scorer, weight

        clip = Clip(weight("clip/ViT-B-32.pt"))
        namer = advisor = None
        if args.namer in ("claude", "deepseek"):
            from .generic import BinAdvisor

            if args.namer == "claude":  # Haiku 5.5: one call per item (claude_namer.py)
                from .claude_namer import ClaudeNamer

                from .claude_namer import generic_catalog
                from .namer import load_catalog

                model = args.claude_model or ("claude-sonnet-5-5" if args.prepared else "claude-haiku-5-5")
                namer = ClaudeNamer(WORKER_DIR / "state/vlm-cache", rules_path=Path(args.local_rules), model=model,
                                    catalog=generic_catalog(load_catalog()) if args.prepared else None)
                missing = "no ANTHROPIC_API_KEY (~/.config/recyclone/anthropic.env)"
            else:
                from .namer import DeepSeekNamer

                namer = DeepSeekNamer(WORKER_DIR / "state/vlm-cache")
                missing = "no DEEPSEEK_API_KEY"
            advisor = BinAdvisor(Path(args.local_rules), WORKER_DIR / "state/generic-types.json")
            namer_used["namer"] = namer
            print(f"identification: {args.namer}{' ' + namer.model if hasattr(namer, 'model') else ''} + Jev", file=sys.stderr)
            if not namer.available:
                print(f"note: {missing}; items not recognized by CLIP will be announced as trash", file=sys.stderr)
        if args.prepared:  # the prerecorded demo has its own watcher (demo_watcher.py), independent of live changes
            from .demo_watcher import DemoItemWatcher as ItemWatcher, ensure_face_detector, guide_prompts
        else:
            from .guide_identify import ensure_face_detector, guide_prompts

        ensure_face_detector()

        pose = YoloPoseTracker(weight("yolo11n-pose.pt"))
        watcher = ItemWatcher(clip.images, Scorer(clip, guide_prompts()), table, namer=namer, advisor=advisor)
    answers, outcomes, camera_moved = None, {}, False
    if args.prepared:  # prerecorded, store-tuned demo (prepared.py): items identified from the whole clip first
        from .prepared import PreparedWatcher, RecordingPose, ReplayPose, observe_clip, prepare_answers

        if live:
            print("--prepared needs a video file, not a live camera", file=sys.stderr)
            return 2
        if args.item and args.item not in table:
            print(f"--item {args.item} is not in the bin table ({Path(args.bins).name})", file=sys.stderr)
            return 2
        print("stage: identifying", file=sys.stderr)
        print("preparing: the whole clip through YOLO pose + CLIP, then each person's item identified once", file=sys.stderr)
        recorded, trace = RecordingPose(pose), {}
        from .approach import distance_m

        observe_clip(source, recorded, watcher, trace=trace, distance=lambda kp: distance_m(kp, area, homography))
        first = next(iter(source))[2]  # the frame width sets --min-hand in pixels
        answers = prepare_answers(watcher, args.item, int(args.min_hand * first.shape[1]))
        for tid, (msg, src) in sorted(answers.items()):
            print(f"  person {tid}: {gm.spoken(msg) if msg else '(nothing identifiable: not announced)'}  [{src}]", file=sys.stderr)
        voice.prepare([gm.spoken(m) for m, _ in answers.values() if m])
        if openings and not args.no_verdict:  # which opening each announced item went into (bins.thrown_into)
            from . import bins as bins_mod

            # the openings are found again on the frame where the item left the hand: a moving camera (IMG_9121 pans)
            # has them elsewhere by then; on a fixed camera they match the first frame (and the answer is cached)
            ends = {tid: bins_mod.carry_end(trace.get(tid, [])) for tid, (msg, _) in answers.items() if msg}
            ends = {tid: t for tid, t in ends.items() if t is not None}
            frames_at, wanted = {}, sorted(set(ends.values()))
            for _, t, frame in RecordedClipSource(Path(args.source)):
                while wanted and t >= wanted[0]:
                    frames_at[wanted.pop(0)] = frame
                if not wanted:
                    break
            for tid, t_end in ends.items():
                frame = frames_at.get(t_end)
                here = (bins_mod.detect_openings(frame, WORKER_DIR / "state/bins-cache") if frame is not None else []) or openings
                here = bins_mod.fill_from_reference(here, openings)
                if bins_mod.same_openings(openings, here, frame.shape[1] if frame is not None else 1):
                    here = openings  # fixed camera: the first frame's openings (nobody's arm over them)
                else:
                    camera_moved = True
                msg = answers[tid][0]
                went = bins_mod.thrown_into(trace.get(tid, []), here)
                if went and went["bin"] in bins_mod.BIN_NAME:  # an opening of unknown type gives no verdict
                    outcomes[tid] = dict(went, recommended=msg["bin"], correct=went["bin"] == msg["bin"], message=msg)
                    print(f"  person {tid}: went into {went['label'] or went['bin']} -> {'CORRECT' if outcomes[tid]['correct'] else 'WRONG BIN'}",
                          file=sys.stderr)
            if camera_moved:
                print("  the camera moved: openings are not drawn; results use the openings at each drop", file=sys.stderr)
        watcher.people.clear()  # pass 2 watches again from the start, on the same skeletons
        watcher.last_observed.clear()
        watcher.namer = None
        pose, watcher = ReplayPose(recorded.frames), PreparedWatcher(watcher, answers)
    guide = Guide(pose, watcher, Approach(area, homography), voice, log_path=Path(args.log), area=area, homography=homography)
    guide.openings, guide.outcomes = ([] if camera_moved else openings), outcomes
    guide.draw_area = not camera_moved
    stream = writer = tmp = None
    if not args.no_stream:
        from .stream import StreamServer

        stream = StreamServer(int(os.environ.get("WORKER_PORT", "8765")), Path(args.evidence_dir))
        stream.start()
        print(f"stream: http://localhost:{stream.port}/stream.mjpg", file=sys.stderr)

    shown = {"window": False}

    def on_frame(img):
        nonlocal writer, tmp
        if stream:
            stream.publish(img)
        if args.show or args.fullscreen:  # a window on the laptop (or the monitor) with what the camera sees
            name = "Caught in 4K - guide"
            if args.fullscreen:
                if not shown["window"]:  # drag it to the monitor first if needed; f toggles full screen
                    cv2.namedWindow(name, cv2.WINDOW_NORMAL)
                    cv2.setWindowProperty(name, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_FULLSCREEN)
                    shown["window"] = True
                cv2.imshow(name, img)
            else:
                cv2.imshow(name, cv2.resize(img, (img.shape[1] * 720 // img.shape[0], 720)))
            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                raise KeyboardInterrupt
            if key == ord("f") and args.fullscreen:
                full = cv2.getWindowProperty(name, cv2.WND_PROP_FULLSCREEN) == cv2.WINDOW_FULLSCREEN
                cv2.setWindowProperty(name, cv2.WND_PROP_FULLSCREEN, cv2.WINDOW_NORMAL if full else cv2.WINDOW_FULLSCREEN)
        if args.render:
            if writer is None:
                h, w = img.shape[:2]
                tmp = Path(tempfile.mkdtemp()) / "video.mp4"
                writer = subprocess.Popen(["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24", "-s", f"{w}x{h}",
                                           "-r", str(source.fps), "-i", "-", "-c:v", "libx264", "-crf", "24", "-preset", "veryfast",
                                           "-pix_fmt", "yuv420p", str(tmp)], stdin=subprocess.PIPE)
            writer.stdin.write(np.ascontiguousarray(img).tobytes())

    frames = _realtime(source, source.fps) if (args.realtime and not live) else source
    if args.render:
        print("stage: rendering", file=sys.stderr)
    try:
        guide.run(frames, on_frame=on_frame if (stream or args.render or args.show or args.fullscreen) else None, cctv=args.cctv)
    except KeyboardInterrupt:  # Ctrl-C ends a live run: still finish the video and print the numbers
        print("stopped", file=sys.stderr)
    finally:
        if stream:
            stream.stop()
        if writer:
            writer.stdin.close()
            writer.wait()
        voice.close()
        if speaker:
            speaker.stop()
        if tunnel is not None:
            tunnel.terminate()
    said = guide.said
    if args.render and tmp is not None:
        mix_audio(tmp, Path(args.render), voice.spoken)
        print(f"video with the voice: {args.render}", file=sys.stderr)
        report = {  # for a UI that uploads a video and shows the result (and for checking the run)
            "video": str(args.render), "source": str(args.source), "prepared": bool(args.prepared),
            "items": [{"track_id": int(tid), "message": m, "source": src} for tid, (m, src) in sorted((answers or {}).items())],
            "announcements": said, "fps": round(guide.fps, 1),
            "openings": [{"bin": o["bin"], "label": o["label"], "box": list(o["box"])} for o in openings],
            "camera_moved": camera_moved,
            "outcomes": [{"track_id": int(tid), "recommended": o["recommended"], "thrown_into": o["bin"], "correct": o["correct"],
                          "t": round(o["t"], 2)} for tid, o in sorted(outcomes.items())],
            "model": getattr(namer_used["namer"], "model", args.namer),
        }
        Path(args.render).with_suffix(".json").write_text(json.dumps(report, indent=2))
        if args.prepared:  # remember what the model said, per clip (state/demo-memory next to the log, never committed)
            memory = demo_memory_dir(Path(args.log))
            memory.mkdir(parents=True, exist_ok=True)
            (memory / f"{Path(args.source).stem}.json").write_text(json.dumps(report, indent=2))
            with (memory / "ledger.jsonl").open("a") as f:
                for it in report["items"]:
                    if it["message"]:
                        out = next((o for o in report["outcomes"] if o["track_id"] == it["track_id"]), None)
                        f.write(json.dumps({"clip": Path(args.source).name, "track_id": it["track_id"], "model": report["model"],
                                            "spoken": gm.spoken(it["message"]), "source": it["source"],
                                            "thrown_into": out and out["thrown_into"], "correct": out and out["correct"]}) + "\n")
    print(f"guide: {len(said)} announcement(s); fast path {guide.fps:.1f} fps (camera {source.fps:.0f} fps)", file=sys.stderr)
    used = namer_used["namer"]
    if used is not None and hasattr(used, "cost_usd"):
        u = used.usage
        print(f"claude: {u['calls']} call(s), {u['cached']} cached, {u['input_tokens']} in / {u['output_tokens']} out tokens, "
              f"~${used.cost_usd():.4f}", file=sys.stderr)
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


def main(argv=None, *, make_tracker=None, make_embedder=None, analyze_items=None, make_guide_parts=None) -> int:
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
    run.add_argument("--items-cache", default=str(WORKER_DIR / "state/items-cache"), help="--tracker items: perception cache")
    run.add_argument("--namer", choices=["clip", "deepseek"], default="clip",
                     help="--tracker items: who names each dropped item. deepseek = vision LLM on crops of the item only "
                          "(key: DEEPSEEK_API_KEY or ~/.config/recyclone/deepseek.env; answers cached in state/vlm-cache)")
    run.add_argument("--local-rules", default=str(WORKER_DIR / "rules/cambridge-ma-2022.md"),
                     help="--namer deepseek: local rules text used to SUGGEST a bin for item types not in the catalog (Jev); "
                          "'' to turn off")
    run.add_argument("--item-bins", help="--tracker items: bin boxes per frame (item-tracker config) for a moving camera; "
                                         "default: the camera's fixed bin regions from demo-site.json")
    gd = sub.add_parser("guide", help="voice guide: tell a person with waste which bin, before they reach the bins")
    gd.add_argument("--source", required=True, help="camera index (0 = built-in webcam), rtsp:// URL, or a video file")
    gd.add_argument("--area", required=True, help="one box around all the bins: x0,y0,x1,y1 in pixels, 'pick' to draw it, or 'auto' (a vision model finds the bins and their labels)")
    gd.add_argument("--show", action="store_true", help="show the camera view in a window (q to stop)")
    gd.add_argument("--prepared", action="store_true",
                    help="video file only: identify each person's item from the whole clip first (store-tuned demo), "
                         "then run the guide with the answers ready")
    gd.add_argument("--item", help="with --prepared: the catalog item everyone in the clip carries (skips identification)")
    gd.add_argument("--claude-model", choices=["claude-haiku-5-5", "claude-sonnet-5-5"],
                    help="default: Sonnet 5.5 for --prepared (more accurate; ~$0.004 per item), Haiku 5.5 live (fast)")
    gd.add_argument("--min-hand", type=float, default=0.0,
                    help="with --prepared: people whose hand crop is smaller than this fraction of the frame width are "
                         "background (not identified, not announced), e.g. 0.1 for a hand-held phone clip")
    gd.add_argument("--fullscreen", action="store_true",
                    help="the camera view full screen at full resolution, e.g. on a monitor behind the bins (f toggles, q stops)")
    gd.add_argument("--cctv", nargs="?", const="CAM 01", help="surveillance look: camera name + clock on the video")
    gd.add_argument("--homography", help="optional floor calibration: JSON 3x3 matrix, image pixels -> floor meters")
    gd.add_argument("--namer", choices=["clip", "claude", "deepseek"], default="claude",
                    help="who identifies items CLIP is not sure of: Claude Haiku 5.5 (default), DeepSeek, or CLIP only")
    gd.add_argument("--local-rules", default=str(WORKER_DIR / "rules/cambridge-ma-2022.md"))
    gd.add_argument("--bins", default=str(WORKER_DIR / "rules/cambridge-ma-2022.bins.json"), help="standard bin per catalog item")
    gd.add_argument("--voice", choices=["auto", "elevenlabs", "say", "silent"], default="auto",
                    help="auto = ElevenLabs when its key is set (~/.config/recyclone/elevenlabs.env), else macOS say")
    gd.add_argument("--realtime", action="store_true", help="for a file: play at clip speed and speak aloud")
    gd.add_argument("--speaker", choices=["mac", "phone", "both"], default="mac",
                    help="where the voice plays: this Mac, a second phone that opens the printed URL, or both")
    gd.add_argument("--speaker-tunnel", action="store_true",
                    help="also give the speaker page a public https URL (Cloudflare quick tunnel): works on any network")
    gd.add_argument("--speaker-port", type=int, default=int(os.environ.get("SPEAKER_PORT", "8766")))
    gd.add_argument("--render", help="write the annotated video with the voice mixed in to this .mp4")
    gd.add_argument("--no-stream", action="store_true")
    gd.add_argument("--no-verdict", action="store_true",
                    help="with --prepared: do not work out which bin each item went into (no CORRECT / WRONG BIN on the "
                         "video); the bins still set the area (upload page)")
    gd.add_argument("--headless", action="store_true",
                    help="no windows: if --area auto finds no bins, exit with code 3 instead of asking for a box (upload page)")
    gd.add_argument("--evidence-dir", default=str(WORKER_DIR / "evidence"))
    gd.add_argument("--log", default=str(WORKER_DIR / "state/guide-log.jsonl"))
    sub.add_parser("cameras", help="list the cameras this computer sees (iPhone via Continuity Camera included)")
    st = sub.add_parser("run-station", help="several cameras of one station: drops merged, reported by the camera the person faces")
    st.add_argument("--station", required=True, help='JSON: {"station_id", "cameras": [{"camera_id", "video", "offset_s", "bins"}]}')
    st.add_argument("--clip-id", required=True)
    st.add_argument("--items-cache", default=str(WORKER_DIR / "state/items-cache"))
    st.add_argument("--namer", choices=["clip", "deepseek"], default="clip")
    st.add_argument("--evidence-dir", default=str(WORKER_DIR / "evidence"))
    st.add_argument("--dry-run", action="store_true")
    st.add_argument("--realtime", action="store_true")
    st.add_argument("--no-stream", action="store_true")
    st.add_argument("--no-background", action="store_true")
    st.add_argument("--events-out")
    st.add_argument("--render", help="also write the combined camera view to this .mp4")
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
    for p, choices in ((run, ["yolo", "world", "motion", "items"]), (enroll, ["yolo", "world", "motion"])):
        p.add_argument("--tracker", choices=choices, default="yolo",
                       help="world = YOLO-World with packaging prompts; motion = background subtraction near the bins; "
                            "items (run only) = item tracker: analyze the clip first (~2 fps, cached), then play it back live")
        p.add_argument("--world-weights", default=str(WORKER_DIR / "weights/yolov8s-worldv2.pt"))
        p.add_argument("--yolo", default=str(DEFAULT_YOLO))
        p.add_argument("--clip-weights", default=str(DEFAULT_CLIP))
    args = ap.parse_args(argv)

    if args.cmd == "guide":
        return cmd_guide(args, make_guide_parts)
    if args.cmd == "cameras":
        from .guide import list_cameras

        for i, w, h in list_cameras():
            print(f"--source {i}   {w}x{h}")
        from .sources import avf_devices

        try:  # an iPhone through Continuity Camera is only listed here (OpenCV does not ask macOS for it)
            for i, name in avf_devices():
                if "capture screen" not in name.lower():
                    print(f"--source avf:{i}   {name}" + ("   (or --source avf:iphone)" if "iphone camera" in name.lower() else ""))
        except Exception:  # noqa: BLE001 - no ffmpeg: OpenCV's list above is all there is
            pass
        return 0
    if args.cmd == "run-station":
        return cmd_run_station(args, analyze_items)
    if args.cmd == "run" and args.tracker == "items":
        return cmd_run_items(args, analyze_items)
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
