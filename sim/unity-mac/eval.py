"""Score the worker on packed Unity clips, overall and per scenario (docs/sim/unity-sim-brief.md §6–7).

    worker/.venv/bin/python sim/unity-mac/eval.py <split> [--tracker motion|yolo|world] [--yolo-weights PATH]
        [--gone-after N] [--threshold T]

Honesty: tune only on `dev`. Run `test` once per configuration you report, and report it whole.
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "worker"))
from recyclone_worker.categories import CategoryClassifier  # noqa: E402
from recyclone_worker.client import MemorySink  # noqa: E402
from recyclone_worker.evaluate import evaluate  # noqa: E402
from recyclone_worker.identify import ClipEmbedder, Gallery  # noqa: E402
from recyclone_worker.pipeline import Pipeline  # noqa: E402
from recyclone_worker.site import load_site  # noqa: E402
from recyclone_worker.sources import RecordedClipSource  # noqa: E402


def tracker_for(args, site):
    if args.tracker == "motion":
        from recyclone_worker.motion import MotionTracker
        return MotionTracker(site.regions)
    from recyclone_worker.tracking import WorldTracker, YoloTracker
    if args.tracker == "world":
        return WorldTracker(REPO / "worker/weights/yolov8s-worldv2.pt")
    return YoloTracker(Path(args.yolo_weights or REPO / "worker/weights/yolo11n.pt"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("split")
    ap.add_argument("--tracker", default="motion", choices=["motion", "yolo", "world"])
    ap.add_argument("--yolo-weights")
    ap.add_argument("--gone-after", type=int, default=None)
    ap.add_argument("--threshold", type=float, default=None, help="core item threshold for 'identified' (default: demo profile)")
    ap.add_argument("--tag", default="")
    args = ap.parse_args()

    clips = sorted(p for p in (HERE / "Output" / args.split).glob("sim_*") if (p / "video.mp4").exists())
    embedder = ClipEmbedder(REPO / "worker/weights/clip/ViT-B-32.pt")
    categories = CategoryClassifier(embedder)
    totals = Counter()
    by_scen = defaultdict(Counter)
    by_cond = defaultdict(Counter)
    rows = []
    for clip in clips:
        site_path = clip / "site.json"
        site_data = json.loads(site_path.read_text())
        destinations = {i["catalog_item_id"]: i["destination"] for i in site_data["catalog"]}
        threshold = args.threshold if args.threshold is not None else site_data["config_profiles"]["demo"]["item_confidence_threshold"]
        cfg = json.loads((clip / "config.json").read_text())
        site = load_site("cam_room_1", site_path)
        sink = MemorySink()
        kw = {"gone_after_frames": args.gone_after} if args.gone_after else {}
        Pipeline(site, tracker_for(args, site), embedder, Gallery(), sink, clip_id=clip.name,
                 started_at=datetime(2026, 10, 17, tzinfo=UTC), evidence_dir=HERE / "Output" / "evidence",
                 categories=categories, reference_threshold=threshold, **kw).run(RecordedClipSource(clip / "video.mp4"))
        labels = [json.loads(l) for l in (clip / "labels.jsonl").read_text().splitlines() if l.strip()]
        r = evaluate(labels, sink.events, destinations=destinations, details=True)
        identified = sum(1 for e in sink.events if (e["item"]["confidence"] or 0) >= threshold)
        cond = "+".join(cfg["conditions"])
        for k in ("labeled", "predicted", "matched", "missed", "extra", "wrong_bin", "rule_correct", "item_labeled"):
            totals[k] += r[k]
            by_cond[cond][k] += r[k]
        totals["identified"] += identified
        # per scenario: each label belongs to the scenario of its item (track_id = item row)
        missed = set(r["missed_labels"])
        for i, l in enumerate(labels):
            sc = cfg["scenario_by_row"][str(l["source"]["track_id"])]
            by_scen[sc]["disposals"] += 1
            by_scen[sc]["missed"] += i in missed
        # false disposals: an event no disposal explains, blamed on the throw released just before it
        releases = sorted((float(t), cfg["scenario_by_row"][row]) for row, t in cfg["release_at_by_row"].items() if float(t) >= 0)
        for j in r["extra_events"]:
            t = sink.events[j]["clip_offset_s"]
            prior = [sc for rt, sc in releases if rt <= t + 0.5]
            by_scen[prior[-1] if prior else "(before any throw)"]["false_events"] += 1
        non_disposals = [json.loads(l) for l in (clip / "non_disposals.jsonl").read_text().splitlines() if l.strip()]
        for nd in non_disposals:
            by_scen[nd["scenario"]]["non_disposals"] += 1
        rows.append(f"| {clip.name} | {cond} | {r['labeled']} | {r['matched']} | {r['missed']} | {r['extra']} | {r['wrong_bin']} | {r['rule_correct']}/{r['item_labeled']} | {identified}/{r['predicted']} |")
        print(rows[-1], flush=True)

    pct = lambda a, b: f"{100 * a / b:.0f}%" if b else "n/a"
    out = [f"# Unity sim results: split `{args.split}`, tracker `{args.tracker}` {args.tag}".rstrip(), "",
           f"{len(clips)} clips. Simulation only: not evidence of real-camera performance.", "",
           "## Totals", "",
           f"- disposals {totals['labeled']}, counted **{totals['matched']} ({pct(totals['matched'], totals['labeled'])})**, "
           f"missed {totals['missed']}, wrong bin {totals['wrong_bin']}",
           f"- **false events (counted but nothing went in): {totals['extra']}**",
           f"- bin rule right {totals['rule_correct']}/{totals['item_labeled']}; above core threshold {totals['identified']}/{totals['predicted']}",
           "", "## Per scenario", "", "| scenario | disposals | missed | non-disposals | false events |", "|---|---|---|---|---|"]
    for sc, c in sorted(by_scen.items()):
        out.append(f"| {sc} | {c['disposals']} | {c['missed']} | {c['non_disposals']} | {c['false_events']} |")
    out += ["", "## Per camera condition", "", "| conditions | disposals | counted | missed | false events |", "|---|---|---|---|---|"]
    for cond, c in sorted(by_cond.items()):
        out.append(f"| {cond} | {c['labeled']} | {c['matched']} | {c['missed']} | {c['extra']} |")
    out += ["", "## Per clip", "", "| clip | conditions | disposals | counted | missed | extra | wrong bin | rule right | identified |",
            "|---|---|---|---|---|---|---|---|---|"] + rows
    report = HERE / "Output" / f"report_{args.split}_{args.tracker}{('_' + args.tag) if args.tag else ''}.md"
    report.write_text("\n".join(out) + "\n")
    print("\n".join(out[:12]))
    print(f"\nwritten {report}")


if __name__ == "__main__":
    main()
