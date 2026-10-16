"""Did a tracked item actually go INTO a bin? (worker/AGENTS.md pipeline step 5)

Seeing an item near a bin, or in someone's hand above it, is not a disposal. The decision is made
once per track, after it disappears, from the path of its box centers.
"""

from .site import BinRegion

Point = tuple[float, float]


def throw_score(history: list[Point], bin_roi: tuple[int, int, int, int]) -> float:
    """How strongly this path looks like the item went into the bin opening, from 0 to 1.

    history: (x, y) centers of the item's box in pixels, oldest first, one per frame it was seen.
    bin_roi: (x, y, w, h) of the bin opening in pixels.

    The returned score becomes the event's destination_confidence, and entered_bin() counts a
    disposal only at 0.5 or above. Cases it must handle are in tests/test_entry.py: falling in,
    being held near the bin and carried away, passing over it, and a too-short history.

    Coordinates are image pixels, so y grows DOWNWARD.

    Heuristic (written by Claude at Eymen's request): the item must have moved, and must vanish
    inside the opening (score 0.5-1.0, higher when it stayed inside and was falling) or just above
    it while falling (0.6, the rim hides throws). It cannot tell an item that fell in from one
    hidden by a hand right above the opening; pipeline.gone_after_frames covers short hiding.
    """
    if len(history) < 3:
        return 0.0  # a blip of one or two frames is not evidence of anything
    x, y, w, h = bin_roi
    (x0, y0), (lx, ly) = history[0], history[-1]
    if ((lx - x0) ** 2 + (ly - y0) ** 2) ** 0.5 < 0.5 * min(w, h):
        return 0.0  # never really moved: a lid, or something left on the bin
    falling = ly - history[-3][1] > 0  # image y grows downward, toward and into the opening
    inside = [x <= px <= x + w and y <= py <= y + h for px, py in history[-3:]]
    if inside[-1]:
        # Vanished inside the opening; stronger when it stayed inside and was falling.
        return round(0.5 + 0.3 * sum(inside) / 3 + 0.2 * falling, 4)
    if falling and x <= lx <= x + w and y - 0.5 * h <= ly < y:
        return 0.6  # vanished just above the opening while falling: the rim hid the last frames
    return 0.0


def entered_bin(
    history: list[Point], regions: list[BinRegion], frame_size: tuple[int, int], min_score: float = 0.5
) -> tuple[str, float] | None:
    """The bin this track went into and the confidence, or None if no bin (or two bins equally) qualify."""
    scored = sorted(
        ((throw_score(history, r.to_pixels(*frame_size)), r.bin_id) for r in regions), reverse=True
    )
    if not scored or scored[0][0] < min_score:
        return None
    if len(scored) > 1 and scored[1][0] == scored[0][0]:
        return None  # ambiguous destination: report nothing rather than guess (worker/AGENTS.md)
    score, bin_id = scored[0]
    return bin_id, min(1.0, max(0.0, float(score)))  # becomes destination_confidence: plain float in 0..1
