"""Stress suite: many synthetic videos, worst cases included, scored against their ground truth.

    uv run python scripts/stress.py PHOTO_DIR [--tracker motion|yolo|world] [--only dev|held_out]

Honesty rules: `dev` variants may be looked at while fixing things; `held_out` variants (other seeds,
harder conditions) are only run and reported, never tuned on. Synthetic != real camera.
"""

import argparse
import sys
import time
from dataclasses import replace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import synth  # noqa: E402

from recyclone_worker.categories import CategoryClassifier  # noqa: E402
from recyclone_worker.client import MemorySink  # noqa: E402
from recyclone_worker.evaluate import evaluate  # noqa: E402
from recyclone_worker.identify import ClipEmbedder, Gallery  # noqa: E402
from recyclone_worker.pipeline import Pipeline  # noqa: E402
from recyclone_worker.site import load_catalog, load_profile, load_site  # noqa: E402
from recyclone_worker.sources import RecordedClipSource  # noqa: E402

V = synth.Variant
DEV = [V("dev_baseline", seed=0), V("dev_random", seed=1, random_order=True)]
HELD_OUT = [
    V("ho_baseline", seed=100),
    V("ho_random_a", seed=101, random_order=True),
    V("ho_random_b", seed=102, random_order=True),
    V("ho_small_items", seed=103, item_height=65),
    V("ho_dim_noisy", seed=104, brightness=0.55, noise=8),
    V("ho_fast_blur", seed=105, fall_frames=6, blur=15),
    V("ho_shake", seed=106, shake=4),
    V("ho_jpeg", seed=107, jpeg_quality=25),
    V("ho_busy_drift", seed=108, busy_background=True, lighting_drift=0.25),
    V("ho_passerby", seed=109, passerby=True),
    V("ho_simultaneous", seed=110, simultaneous=True),
    V("ho_low_fps", seed=111, fps=15, fall_frames=12),
    V("ho_720_to_480", seed=112, w=854, h=480, item_height=75),
    V("ho_worst", seed=113, item_height=70, brightness=0.6, noise=8, blur=11, fall_frames=8, shake=3, jpeg_quality=30, passerby=True),
]
for v in HELD_OUT:
    v.held_out = True


def make_tracker(kind, regions):
    if kind == "motion":
        from recyclone_worker.motion import MotionTracker
        return MotionTracker(regions)
    from recyclone_worker.tracking import WorldTracker, YoloTracker
    weights = Path(__file__).resolve().parents[1] / "weights"
    return YoloTracker(weights / "yolo11n.pt") if kind == "yolo" else WorldTracker(weights / "yolov8s-worldv2.pt")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("photo_dir")
    ap.add_argument("--tracker", default="motion")
    ap.add_argument("--only", choices=["dev", "held_out"])
    ap.add_argument("--out", default="state/stress")
    args = ap.parse_args()
    out = Path(args.out)
    variants = (DEV if args.only != "held_out" else []) + (HELD_OUT if args.only != "dev" else [])
    site = load_site("cam_patio_1")
    threshold = load_profile("demo")["item_confidence_threshold"]
    embedder = ClipEmbedder(Path(__file__).resolve().parents[1] / "weights/clip/ViT-B-32.pt")
    categories = CategoryClassifier(embedder)
    catalog = load_catalog(None)
    import json as _json
    destinations = {i["catalog_item_id"]: i["destination"] for i in _json.loads((Path(__file__).resolve().parents[2] / "contracts/fixtures/demo-site.json").read_text())["catalog"]}
    rows = []
    for v in variants:
        video, labels_path = synth.make(v, Path(args.photo_dir), out)
        labels = [__import__("json").loads(l) for l in labels_path.read_text().splitlines() if l.strip()]
        sink = MemorySink()
        t0 = time.perf_counter()
        Pipeline(site, make_tracker(args.tracker, site.regions), embedder, Gallery(), sink, clip_id=v.name,
                 started_at=__import__("datetime").datetime(2026, 10, 17, tzinfo=__import__("datetime").UTC),
                 evidence_dir=out / "evidence", catalog_business=catalog, categories=categories,
                 reference_threshold=threshold).run(RecordedClipSource(video))
        secs = time.perf_counter() - t0
        r = evaluate(labels, sink.events, destinations=destinations)
        core_identified = sum(1 for e in sink.events if (e["item"]["confidence"] or 0) >= threshold)
        rows.append((v, r, core_identified, secs))
        print(f"{v.name:18s} drops {r['labeled']:2d} | counted {r['matched']:2d} missed {r['missed']:2d} extra {r['extra']:2d} "
              f"wrong-bin {r['wrong_bin']} | rule {r['rule_correct']}/{r['item_labeled']} (exact {r['item_correct']}) | core-identified {core_identified}/{len(sink.events)} | {secs:4.0f}s",
              flush=True)
    for group, held in (("DEV (tuned on)", False), ("HELD-OUT (reported, never tuned on)", True)):
        sel = [x for x in rows if x[0].held_out == held]
        if not sel:
            continue
        tot = lambda k: sum(x[1][k] for x in sel)
        print(f"\n{group}: drops {tot('labeled')}, counted {tot('matched')} ({100 * tot('matched') / max(1, tot('labeled')):.0f}%), "
              f"missed {tot('missed')}, extra {tot('extra')}, wrong bin {tot('wrong_bin')}, "
              f"bin rule right {tot('rule_correct')}/{tot('item_labeled')} (exact item {tot('item_correct')}), core-identified {sum(x[2] for x in sel)}/{tot('predicted')}")
    print("\nSynthetic scenes only: this is not evidence of performance on a real camera.")


if __name__ == "__main__":
    main()
