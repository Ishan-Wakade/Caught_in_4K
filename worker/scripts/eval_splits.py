"""Score the item tracker on several clip sets at once, from cached perception (seconds per run).

    uv run python scripts/eval_splits.py CONFIG.json:CACHE_DIR [CONFIG.json:CACHE_DIR ...] [--set NAME=VALUE ...]

CONFIG is an item-tracker config (examples/item_tracker.example.json); CACHE_DIR holds the perception cache
`scripts/item_tracker.py OUT CONFIG` wrote to OUT/cache. A truth may also give the dropped item:
  {"frame": 300, "bin": "bin_recycle", "ok_items": ["item_generic_paper"], "rule": "recycling"}
"ok_items" are the catalog ids accepted as the right name ([null] = not in the catalog, unknown is right);
"rule" is the right bin rule. --set overrides a constant of recyclone_worker.items for this run, e.g.
--set MAX_GROWTH=1.6, to compare a change on dev before touching the code. --namer deepseek names every detected
drop with the vision LLM (recyclone_worker/namer.py; key from ~/.config/recyclone/deepseek.env, answers cached).
"""

import json
import sys
from pathlib import Path

import numpy as np

from recyclone_worker import items as it


def score(config: Path, cache: Path, scorer, namer=None) -> list[dict]:
    """One row per clip: matched drops (with timing and naming), misses and false drops."""
    rows = []
    for name, spec in json.loads(config.read_text()).items():
        data = dict(np.load(cache / f"{name}.npz"))
        n = len(data["kps"])
        bins = {b["bin_id"]: it.keyframe_boxes(b, n) for b in spec["bins"]}
        motion = np.load(cache / f"{name}_motion.npy")
        tracks, per_frame = it.track(data, bins, scorer, motion)
        events, _ = it.decide(tracks, data, bins, float(data["fps"]), motion, per_frame)
        if namer is not None:
            namer(name, spec, data, tracks, per_frame, events)
        truths = spec.get("truths") or ([spec["truth"]] if spec.get("truth") else [])
        tol = it.at_fps(45, data["fps"])  # loose: 1.5 s
        free, matched = list(events), []
        for gt in truths:
            hit = sorted((e for e in free if e["bin"] == gt["bin"] and abs(e["frame"] - gt["frame"]) <= tol),
                         key=lambda e: abs(e["frame"] - gt["frame"]))
            if hit:
                free.remove(hit[0])
                matched.append((gt, hit[0]))
        rows.append({"clip": name, "truths": len(truths), "matched": matched, "false": free, "fps": float(data["fps"])})
    return rows


def summarize(label: str, rows: list[dict]) -> str:
    t = sum(r["truths"] for r in rows)
    m = [pair for r in rows for pair in r["matched"]]
    strict = sum(abs(e["frame"] - g["frame"]) <= it.at_fps(15, r["fps"]) for r in rows for g, e in r["matched"])
    named = [(g, e) for g, e in m if "ok_items" in g]
    name_ok = sum(e.get("item") in g["ok_items"] for g, e in named)
    rule_ok = sum(e.get("item_bin_rule") == g.get("rule") for g, e in named)
    false = sum(len(r["false"]) for r in rows)
    per = " ".join(f"{r['clip']}:{len(r['matched'])}/{r['truths']}" + (f"+{len(r['false'])}f" if r["false"] else "") for r in rows)
    return (f"{label:12s} drops {len(m)}/{t} (±0.5 s {strict}), false {false}, item name {name_ok}/{len(named)}, "
            f"bin rule {rule_ok}/{len(named)} | {per}")


def main():
    pairs = [a for a in sys.argv[1:] if ":" in a and not a.startswith("--")]
    sets = [a.split("=", 1) for i, a in enumerate(sys.argv) if i > 0 and sys.argv[i - 1] == "--set"]
    for k, v in sets:
        setattr(it, k, type(getattr(it, k))(json.loads(v)) if not isinstance(getattr(it, k), bool) else v.lower() == "true")
    scorer = it.Scorer(it.Clip(it.weight("clip/ViT-B-32.pt")))
    namer = None
    if "--namer" in sys.argv and sys.argv[sys.argv.index("--namer") + 1] == "deepseek":
        from recyclone_worker.namer import DeepSeekNamer, pick_views, read_crops

        llm = DeepSeekNamer(it.WORKER / "state/vlm-cache")
        if not llm.available:
            raise SystemExit("no DEEPSEEK_API_KEY (env or ~/.config/recyclone/deepseek.env)")

        def namer(name, spec, data, tracks, per_frame, events):
            n = len(data["kps"])
            bins = {b["bin_id"]: it.keyframe_boxes(b, n) for b in spec["bins"]}
            for e in events:
                views = pick_views(tracks, per_frame, data, bins, e["item_id"], e["frame"])
                answer = llm.name(read_crops(Path(spec["video"]).expanduser(), views))
                if answer is not None:
                    e["item"] = answer["catalog_item_id"]
                    e["item_bin_rule"] = it.CATALOG.get(answer["catalog_item_id"], {}).get("destination")
                    e["llm"] = answer
    total = []
    for pair in pairs:
        config, cache = pair.split(":", 1)
        rows = score(Path(config), Path(cache).expanduser(), scorer, namer)
        if "--show-items" in sys.argv:
            for r in rows:
                for g, e in r["matched"]:
                    print(f"   {r['clip']} f{g['frame']}: truth {g.get('what')} -> {e.get('item')} ({e.get('item_bin_rule')})"
                          + (f" | llm: {e['llm']['what']}, {e['llm']['material']}, conf {e['llm']['confidence']}" if "llm" in e else ""))
        total += rows
        print(summarize(Path(config).stem, rows))
    if len(pairs) > 1:
        print(summarize("ALL", total))
    if namer is not None:
        u = llm.usage
        cost = u["prompt_tokens"] * 0.30e-6 + u["completion_tokens"] * 1.20e-6  # peak prices, 17 Oct 2026
        print(f"DeepSeek: {u['calls']} calls, {u['cached']} cached, {u['errors']} errors, "
              f"{u['prompt_tokens']}+{u['completion_tokens']} tokens, <= ${cost:.4f}")


if __name__ == "__main__":
    main()
