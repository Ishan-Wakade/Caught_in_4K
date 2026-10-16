"""Compare the worker's events with hand labels for the same clip (worker/AGENTS.md "Evaluation").

Reports what the brief asks for: event-counting errors (missed, extra), destination errors
(wrong bin at the right moment), identification errors, and the fraction of events the system could
assess (item identified). Matching is by clip time within a tolerance, each label used at most once.
"""

from datetime import datetime

from .events import build_event


def _t(e: dict) -> float:
    return float(e["clip_offset_s"])


def evaluate(labels: list[dict], predicted: list[dict], tolerance_s: float = 1.5) -> dict:
    free = sorted(range(len(labels)), key=lambda i: _t(labels[i]))
    pairs, leftovers = [], []

    def nearest(p, same_bin: bool):
        best = None
        for i in free:
            d = abs(_t(labels[i]) - _t(p))
            if d <= tolerance_s and (labels[i]["bin_id"] == p["bin_id"]) == same_bin and (best is None or d < best[0]):
                best = (d, i)
        return best

    for p in sorted(predicted, key=_t):  # first pass: right moment, right bin
        hit = nearest(p, same_bin=True)
        if hit:
            free.remove(hit[1])
            pairs.append((labels[hit[1]], p))
        else:
            leftovers.append(p)
    wrong_bin, extra = 0, 0
    for p in leftovers:  # second pass: right moment, wrong bin
        hit = nearest(p, same_bin=False)
        if hit:
            free.remove(hit[1])
            wrong_bin += 1
        else:
            extra += 1
    item_known = [(l, p) for l, p in pairs if l["item"]["catalog_item_id"] is not None]
    return {
        "labeled": len(labels),
        "predicted": len(predicted),
        "matched": len(pairs),
        "missed": len(free),
        "extra": extra,
        "wrong_bin": wrong_bin,
        "item_labeled": len(item_known),
        "item_correct": sum(l["item"]["catalog_item_id"] == p["item"]["catalog_item_id"] for l, p in item_known),
        "assessable": sum(p["item"]["catalog_item_id"] is not None for p in predicted),
        "tolerance_s": tolerance_s,
    }


def format_report(r: dict) -> str:
    pct = lambda a, b: f"{100 * a / b:.0f}%" if b else "n/a"
    return "\n".join([
        f"labeled drops {r['labeled']}, worker events {r['predicted']} (match window ±{r['tolerance_s']} s)",
        f"  counted right:  {r['matched']} ({pct(r['matched'], r['labeled'])} of labeled)",
        f"  missed:         {r['missed']}",
        f"  extra:          {r['extra']}",
        f"  wrong bin:      {r['wrong_bin']}",
        f"  item correct:   {r['item_correct']} of {r['item_labeled']} matched with a known item ({pct(r['item_correct'], r['item_labeled'])})",
        f"  assessable:     {r['assessable']} of {r['predicted']} events had an identified item ({pct(r['assessable'], r['predicted'])})",
        "Staged footage only: this does not show performance on other cameras.",
    ])


def labeled_event(*, row: int, clip_id: str, camera_id: str, started_at: datetime, offset_s: float,
                  bin_id: str, catalog_item_id: str | None, business_id: str | None) -> dict:
    """One hand label as a DisposalEvent (source.mode "labeled", track_id = label row number)."""
    item = ({"catalog_item_id": catalog_item_id, "label": None, "confidence": 1.0,
             "candidates": [{"catalog_item_id": catalog_item_id, "score": 1.0}]}
            if catalog_item_id else {"catalog_item_id": None, "label": None, "confidence": None, "candidates": []})
    e = build_event(camera_id=camera_id, clip_id=clip_id, track_id=row, bin_id=bin_id, started_at=started_at,
                    offset_s=offset_s, destination_confidence=1.0, item=item, evidence=[])
    e["source"]["mode"] = "labeled"
    if business_id:
        e["business"] = {"business_id": business_id, "confidence": 1.0, "basis": ["logo_text"]}
    return e
