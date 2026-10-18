"""Prerecorded demo, "store-tuned": in a store the items people carry are already known (approved catalog, cached
answers), so the guide never waits on the network. For a recorded clip we get there in two passes:

1. observe_clip: the whole clip once through YOLO pose + CLIP (no voice, no LLM), keeping each person's best
   face-redacted item crops; prepare_answers then identifies each person's item ONCE with no deadline: CLIP's catalog
   answer when it is sure, otherwise DeepSeek (catalog pick + generic description) + Jev under the local rules. Or the
   team names the item (`item`), as a store's tuned catalog would.
2. The normal causal guide (past frames only) on the same skeletons (ReplayPose), with PreparedWatcher answering at
   once: the announcement timing is the real approach trigger; only the identification latency is taken away.

This is labelled as prepared in its outputs: it shows the store-tuned behaviour, not live identification speed.
"""

from . import guide_message as gm


class RecordingPose:
    """Wraps a pose tracker and keeps every frame's [(track_id, keypoints)] for the second pass."""

    def __init__(self, pose):
        self.pose, self.frames = pose, []

    def __call__(self, frame):
        people = self.pose(frame)
        self.frames.append(people)
        return people


class ReplayPose:
    """The first pass's skeletons, frame by frame: the second pass sees the same people with the same ids."""

    def __init__(self, frames):
        self.frames, self.i = frames, 0

    def __call__(self, frame):
        people = self.frames[self.i] if self.i < len(self.frames) else []
        self.i += 1
        return people


def observe_clip(frames, pose, watcher, trace: dict | None = None, distance=None) -> int:
    """Pass 1: every frame through pose + the item watcher (heads blanked as in the guide); the LLM is not asked here.
    trace (optional) collects, per person, (t, item box if CLIP saw the item in this frame else None, feet distance from
    distance(kp), or 0.0 without it) for every frame: where the item went (bins.thrown_into)."""
    from .demo_watcher import head_box

    namer, watcher.namer = watcher.namer, None
    n = 0
    try:
        for _, t, frame in frames:
            people = pose(frame)
            if hasattr(watcher, "set_heads"):
                watcher.set_heads([head_box(kp) for _, kp in people])
            for tid, kp in people:
                watcher.observe(tid, t, frame, kp)
                if trace is not None:
                    seen = watcher.seen(tid, t) if hasattr(watcher, "seen") else watcher.holding(tid, t)
                    box = watcher.item_box(tid, t) if seen and hasattr(watcher, "item_box") else None
                    trace.setdefault(tid, []).append((t, box, distance(kp) if distance else 0.0))
            n += 1
    finally:
        watcher.namer = namer
    return n


MIN_CARRY_VOTES = 6  # CLIP saw the item at least this often (~0.6 s): a real carrier, not a glimpse (IMG_2960)


def prepare_answers(watcher, item: str | None = None, min_hand_px: int = 0,
                    min_votes: int = MIN_CARRY_VOTES) -> dict[int, tuple[dict, str]]:
    """track_id -> (message, source) for everyone seen holding an item: "store" (the item named by the team),
    "catalog" (CLIP sure), "llm" (Claude/DeepSeek + Jev on the best crops), "nothing" (no identifiable object, or hand
    crops smaller than min_hand_px: background; not announced),
    or "default" (trash: the network failed)."""
    answers = {}
    for tid, p in watcher.people.items():
        if p.n_votes < min_votes:  # seen with an item only for a moment: not identified, never sent out
            answers[tid] = (None, "nothing")
            continue
        if min_hand_px and max((max(c[2].shape[:2]) for c in p.crops), default=0) < min_hand_px:
            answers[tid] = (None, "nothing")  # hands this small are far from the camera: background, never sent out
            continue
        if item:
            answers[tid] = (gm.from_catalog(item, watcher.table), "store")
            continue
        known = watcher._catalog(p)
        if known is not None:
            answers[tid] = (known, "catalog")
            continue
        msg = None
        if p.crops and watcher.namer is not None:
            try:
                msg = watcher._identify([c[2] for c in sorted(p.crops, key=lambda c: c[0])])
            except Exception:  # noqa: BLE001 - logged by _identify; this person gets the default
                msg = None
        if msg == gm.default_trash(None):  # nothing identifiable (e.g. a passer-by in the background): not announced
            answers[tid] = (None, "nothing")
        else:
            answers[tid] = (msg, "llm") if msg is not None else (gm.default_trash(None), "default")
    return answers


class PreparedWatcher:
    """The guide's watcher for pass 2: holding/observing as usual, answers ready at once for prepared people."""

    def __init__(self, inner, answers: dict[int, tuple[dict, str]]):
        self.inner, self.answers = inner, answers

    def __getattr__(self, name):  # set_heads, observe, forget, ... go to the real watcher
        return getattr(self.inner, name)

    def holding(self, track_id: int, now: float) -> bool:
        if track_id in self.answers and self.answers[track_id][0] is None:
            return False  # identified as carrying nothing recognizable
        return self.inner.holding(track_id, now)

    def answer(self, track_id: int, now: float):
        if track_id in self.answers:
            return self.answers[track_id] if self.answers[track_id][0] is not None else None
        return self.inner.answer(track_id, now)

    def item_box(self, track_id: int, now: float):
        return self.inner.item_box(track_id, now) if self.holding(track_id, now) else None

    def pending(self, track_id: int) -> bool:
        return False

    def failed(self, track_id: int) -> bool:
        return False
