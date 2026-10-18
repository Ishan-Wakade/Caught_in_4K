"""Prerecorded-only guide orchestration. The live cmd_guide never imports these adapters."""
import json
import os
import sys
from pathlib import Path
import numpy as np

def cmd_prepared_guide(args, make_guide_parts=None) -> int:
    """Analyze a recorded clip before rendering voice guidance; this path never accepts a live camera."""
    from .cli import WORKER_DIR, RecordedClipSource, area_from_roi, demo_memory_dir, _realtime
    import subprocess
    import tempfile

    import cv2

    from . import guide_message as gm
    from .approach import Approach, BinArea
    from .guide import YoloPoseTracker
    from .prepared_render import PreparedGuide as Guide, mix_audio
    from .sources import LiveCameraSource
    from .voice import ElevenLabsVoice, SayVoice, SilentVoice, elevenlabs_config

    homography = np.array(json.loads(Path(args.homography).read_text())) if args.homography else None
    live = args.source.isdigit() or "://" in args.source or args.source.startswith("avf:")
    if live or not args.prepared:
        print("prepared guide needs --prepared and a recorded video file", file=sys.stderr)
        return 2
    bin_layout = None
    if getattr(args, "bin_layout", None):
        from .bin_layout import BinLayout

        if live or not args.prepared or args.area == "auto":
            print("--bin-layout needs --prepared, a video file, and --area pick or coordinates", file=sys.stderr)
            return 2
        try:
            bin_layout = BinLayout(args.bin_layout)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            print(f"invalid bin layout ({type(exc).__name__})", file=sys.stderr)
            return 2
    gateway = None
    if getattr(args, "chalk", False):
        from .chalk import ChalkGateway

        if live or not args.prepared or args.namer == "clip" or args.item:
            print("--chalk requires --prepared, a video file, and --namer claude/deepseek without --item", file=sys.stderr)
            return 2
        if args.area == "auto":
            print("--chalk needs --area pick or coordinates: whole frames must not leave the machine", file=sys.stderr)
            return 2
        try:
            gateway = ChalkGateway.from_env(args.namer)
        except ValueError as exc:
            print(str(exc), file=sys.stderr)
            return 2
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
    if args.area == "auto":  # find the bins with a vision model (bins.py); fixed camera: once, on the first frame
        from . import bins

        first_frame = next(iter(LiveCameraSource(args.source) if live else RecordedClipSource(Path(args.source))))[2]
        openings = bins.detect_openings(first_frame, WORKER_DIR / "state/bins-cache")
        if openings:
            args.area = ",".join(str(v) for v in bins.area_from_openings(openings, first_frame.shape[1], first_frame.shape[0]))
            print("bins: " + ", ".join(f"{o['label']} ({o['bin']})" for o in openings) + f"  -> --area {args.area}", file=sys.stderr)
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
    namer_used = {"namer": None, "advisor": None}  # pass 2 drops the watcher's namer
    if make_guide_parts is not None:
        pose, watcher = make_guide_parts(args, area)
    else:
        from .items import Clip, Scorer, weight

        clip = Clip(weight("clip/ViT-B-32.pt"))
        namer = advisor = None
        if args.namer in ("claude", "deepseek"):
            from .prepared_providers import BinAdvisor

            if args.namer == "claude":  # Haiku 5.5: one call per item (claude_namer.py)
                from .prepared_providers import ClaudeNamer

                from .claude_namer import generic_catalog
                from .namer import load_catalog

                model = args.claude_model or ("claude-sonnet-5-5" if args.prepared else "claude-haiku-5-5")
                namer = ClaudeNamer(WORKER_DIR / "state/vlm-cache", rules_path=Path(args.local_rules), model=model,
                                    catalog=generic_catalog(load_catalog()) if args.prepared else None, gateway=gateway)
                missing = "no ANTHROPIC_API_KEY (~/.config/recyclone/anthropic.env)"
            else:
                from .prepared_providers import DeepSeekNamer

                namer = DeepSeekNamer(WORKER_DIR / "state/vlm-cache", gateway=gateway)
                missing = "no DEEPSEEK_API_KEY"
            advisor = BinAdvisor(Path(args.local_rules), WORKER_DIR / "state/generic-types.json", gateway=gateway)
            namer_used["namer"] = namer
            namer_used["advisor"] = advisor
            print(f"identification: {args.namer}{' ' + namer.model if hasattr(namer, 'model') else ''} + Jev", file=sys.stderr)
            if not namer.available:
                print(f"note: {missing}; items not recognized by CLIP will be announced as trash", file=sys.stderr)
        from .demo_watcher import DemoItemWatcher as ItemWatcher, ensure_face_detector, guide_prompts

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
        print("preparing: the whole clip through YOLO pose + CLIP, then each person's item identified once", file=sys.stderr)
        recorded, trace = RecordingPose(pose), {}
        from .approach import distance_m

        observe_clip(source, recorded, watcher, trace=trace, distance=lambda kp: distance_m(kp, area, homography))
        first = next(iter(source))[2]  # the frame width sets --min-hand in pixels
        answers = prepare_answers(watcher, args.item, int(args.min_hand * first.shape[1]))
        for tid, (msg, src) in sorted(answers.items()):
            print(f"  person {tid}: {gm.spoken(msg) if msg else '(nothing identifiable: not announced)'}  [{src}]", file=sys.stderr)
        voice.prepare([gm.spoken(m) for m, _ in answers.values() if m])
        if openings:  # which opening each announced item went into (bins.thrown_into)
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
    guide.prepared = bool(args.prepared)
    guide.bin_layout = bin_layout
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
            "fps_scope": "prepared_replay_only" if args.prepared else "frame_processing_only",
            "openings": [{"bin": o["bin"], "label": o["label"], "box": list(o["box"])} for o in openings],
            "bin_layout": bin_layout.report() if bin_layout else None,
            "camera_moved": camera_moved,
            "outcomes": [{"track_id": int(tid), "recommended": o["recommended"], "thrown_into": o["bin"], "correct": o["correct"],
                          "t": round(o["t"], 2)} for tid, o in sorted(outcomes.items())],
            "model": getattr(namer_used["namer"], "model", args.namer),
            "chalk": gateway.report() if gateway else {"enabled": False},
            "provider_usage": {"identity": dict(getattr(namer_used["namer"], "usage", {})),
                               "decision": dict(getattr(namer_used["advisor"], "usage", {}))},
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
    if gateway:
        stats = gateway.report()
        print(f"Chalk: {stats['requests']} gateway request(s), {stats['successful_requests']} successful; "
              "local/catalog/cache answers do not count as gateway requests", file=sys.stderr)
    if used is not None and hasattr(used, "cost_usd"):
        u = used.usage
        print(f"claude: {u['calls']} call(s), {u['cached']} cached, {u['input_tokens']} in / {u['output_tokens']} out tokens, "
              f"~${used.cost_usd():.4f}", file=sys.stderr)
    return 0
