"""Which catalog item is this crop? Nearest reference embedding, enrolled from the demo camera.

No training: references are crops of each real item taken with the same camera (enroll.py), and a
crop is matched by cosine similarity. The worker reports raw candidates and scores; core decides
what is confident enough (contract §6).
"""

from pathlib import Path
from typing import Protocol

import numpy as np


class Embedder(Protocol):
    def embed(self, image: np.ndarray) -> np.ndarray:
        """BGR image in, L2-normalized 1-D vector out."""
        ...


class ClipEmbedder:
    def __init__(self, weights: Path, device: str | None = None):
        import clip  # heavy import kept out of the test path
        import torch
        from PIL import Image

        self._torch, self._Image = torch, Image
        self.device = device or ("mps" if torch.backends.mps.is_available() else "cpu")
        self.model, self.preprocess = clip.load(str(Path(weights).expanduser()), device=self.device)

    def embed(self, image: np.ndarray) -> np.ndarray:
        rgb = self._Image.fromarray(image[:, :, ::-1])
        with self._torch.no_grad():
            v = self.model.encode_image(self.preprocess(rgb).unsqueeze(0).to(self.device)).float()[0]
        v = v.cpu().numpy()
        return v / np.linalg.norm(v)

    def embed_text(self, texts: list[str]) -> np.ndarray:
        import clip

        with self._torch.no_grad():
            t = self.model.encode_text(clip.tokenize(texts).to(self.device)).float()
        t = t.cpu().numpy()
        return t / np.linalg.norm(t, axis=1, keepdims=True)


class Gallery:
    """Reference vectors per catalog item; an item may have many (angles, crumpled, in hand)."""

    def __init__(self) -> None:
        self.ids: list[str] = []
        self.vecs = np.zeros((0, 0), np.float32)

    def add(self, catalog_item_id: str, vec: np.ndarray) -> None:
        vec = np.asarray(vec, np.float32)[None, :]
        self.vecs = vec if self.vecs.size == 0 else np.vstack([self.vecs, vec])
        self.ids.append(catalog_item_id)

    def save(self, path: Path) -> None:
        np.savez(path, ids=np.array(self.ids), vecs=self.vecs)

    @classmethod
    def load(cls, path: Path) -> "Gallery":
        data = np.load(path)
        g = cls()
        g.ids, g.vecs = [str(i) for i in data["ids"]], data["vecs"].astype(np.float32)
        return g


UNKNOWN = {"catalog_item_id": None, "label": None, "confidence": None, "candidates": []}


def identify(crops: list[np.ndarray], embedder: Embedder, gallery: Gallery, top_k: int = 3,
             categories=None, reference_threshold: float | None = None) -> dict:
    """The contract `item` object for a track, from its best crops.

    Registered products first. With `categories`, a generic category is reported instead when no
    registered product matched, or the best match is below `reference_threshold` (core's calibrated
    item threshold). The weak reference candidates stay in `candidates` as evidence.
    """
    ref = _reference(crops, embedder, gallery, top_k)
    weak = ref["catalog_item_id"] is None or (reference_threshold is not None and ref["confidence"] < reference_threshold)
    if categories is None or not crops or not weak:
        return ref
    cid, prob, prompt = categories.classify(crops)
    score = round(min(max(prob, 0.0), 1.0), 4)
    return {"catalog_item_id": cid, "label": prompt, "confidence": score,
            "candidates": [{"catalog_item_id": cid, "score": score}] + [c for c in ref["candidates"] if c["catalog_item_id"] != cid]}


def _reference(crops: list[np.ndarray], embedder: Embedder, gallery: Gallery, top_k: int) -> dict:
    if not crops or not gallery.ids:
        return dict(UNKNOWN, candidates=[])
    query = np.mean([embedder.embed(c) for c in crops], axis=0)
    query /= np.linalg.norm(query)
    best: dict[str, float] = {}
    for item_id, sim in zip(gallery.ids, gallery.vecs @ query):
        best[item_id] = max(best.get(item_id, -1.0), float(sim))
    ranked = sorted(best.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
    candidates = [{"catalog_item_id": i, "score": round(min(max(s, 0.0), 1.0), 4)} for i, s in ranked]
    top = candidates[0]
    return {"catalog_item_id": top["catalog_item_id"], "label": None, "confidence": top["score"], "candidates": candidates}


NO_BUSINESS = {"business_id": None, "confidence": None, "basis": []}


def business_from_candidates(item: dict, catalog_business: dict[str, str | None]) -> dict:
    """Business evidence from reference matching, as raw evidence for core (contract §6).

    The best-scoring candidate that belongs to a business gives that business and its own score.
    For a branded top candidate, core uses the catalog's business anyway. For an unbranded top
    candidate (a plain cup) with a branded runner-up (a Shake Shack cup), this is weak evidence, and
    core sends the event to the area manager's review queue when it is below the business threshold.
    """
    for c in item["candidates"]:
        business = catalog_business.get(c["catalog_item_id"])
        if business:
            return {"business_id": business, "confidence": c["score"], "basis": ["reference_match"]}
    return dict(NO_BUSINESS, basis=[])
