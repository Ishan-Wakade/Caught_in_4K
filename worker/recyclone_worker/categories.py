"""Recognize items from text descriptions: offline CLIP zero-shot, no photos needed.

Registered products (reference gallery) come first: they are exact. When none matches well enough,
the crop is compared with short descriptions of generic categories, each of which is a catalog item
with its own bin rule (so local rules, not the model, decide the bin). The score is CLIP's softmax
probability across the categories. A vision LLM (Grok) can later replace this classifier behind
the same `classify()` method.
"""

import numpy as np

# catalog_item_id (all in contracts/fixtures/demo-site.json, business_id null) -> prompts
GENERIC_PROMPTS: dict[str, list[str]] = {
    "item_generic_cup": ["a clear plastic cup", "a plastic cup with a lid and straw"],
    "item_generic_paper_cup": ["a paper coffee cup", "a disposable hot drink cup"],
    "item_generic_bottle": ["a plastic water bottle", "a plastic soda bottle"],
    "item_generic_can": ["an aluminum drink can", "a soda can"],
    "item_generic_glass": ["a glass bottle", "a glass jar"],
    "item_generic_container": ["a plastic takeout container", "a plastic food tray"],
    "item_generic_box": ["a paper takeout box", "a cardboard burger box", "a paper food box"],
    "item_generic_paper": ["a sheet of paper", "a flattened cardboard piece", "a crumpled receipt"],
    "item_generic_wrapper": ["a snack wrapper", "a chip bag", "a candy wrapper", "a crumpled plastic wrapper"],
    "item_generic_utensil": ["a plastic fork", "a plastic spoon", "plastic cutlery"],
    "item_napkin": ["a paper napkin", "a used tissue"],
    "item_generic_food": ["food scraps", "a banana peel", "an apple core", "leftover food"],
}


# Specific catalog products described in words, so they are recognized with NO registered photos.
# 16 Oct test on Eymen's real items, nothing registered: 5/7 right (Shake Shack box, Biscoff,
# Goldfish, Quaker, logo-side Shake Shack cup); a side-on cup fell back to the generic cup and the
# sauce cup to "plastic container". Registered photos, when present, still take priority.
PRODUCT_PROMPTS: dict[str, list[str]] = {
    "item_shakeshack_cup": ["a Shake Shack plastic cup", "a clear cup with the Shake Shack burger logo"],
    "item_shakeshack_box": ["a Shake Shack burger box", "a kraft paper box with the Shake Shack logo"],
    "item_biscoff_wrapper": ["a Lotus Biscoff cookie wrapper", "a red Biscoff wrapper"],
    "item_goldfish_bag": ["a Goldfish crackers bag", "a Pepperidge Farm Goldfish snack bag"],
    "item_granola_wrapper": ["a Quaker Chewy granola bar wrapper"],
    "item_sauce_cup": ["a small plastic sauce cup with a lid", "a condiment portion cup"],
}

ITEM_PROMPTS: dict[str, list[str]] = {**PRODUCT_PROMPTS, **GENERIC_PROMPTS}


class CategoryClassifier:
    """Zero-shot over ITEM_PROMPTS (products + generic categories). `embedder` needs embed(image) and embed_text(list[str])."""

    def __init__(self, embedder, prompts: dict[str, list[str]] = ITEM_PROMPTS, logit_scale: float = 100.0):
        self.embedder, self.logit_scale = embedder, logit_scale
        self.flat = [(cid, p) for cid, ps in prompts.items() for p in ps]
        self.ids = list(prompts)
        self.text = np.asarray(embedder.embed_text([p for _, p in self.flat]), np.float32)

    def _image(self, crops: list[np.ndarray]) -> np.ndarray:
        v = np.mean([self.embedder.embed(c) for c in crops], axis=0)
        return v / np.linalg.norm(v)

    def _per_category(self, crops) -> tuple[dict[str, float], dict[str, str]]:
        sims = self.text @ self._image(crops)
        best_sim: dict[str, float] = {}
        best_prompt: dict[str, str] = {}
        for (cid, prompt), s in zip(self.flat, sims):
            if s > best_sim.get(cid, -np.inf):
                best_sim[cid], best_prompt[cid] = float(s), prompt
        return best_sim, best_prompt

    def probabilities(self, crops: list[np.ndarray]) -> dict[str, float]:
        best_sim, _ = self._per_category(crops)
        logits = self.logit_scale * np.array([best_sim[c] for c in self.ids])
        p = np.exp(logits - logits.max())
        p /= p.sum()
        return {c: float(v) for c, v in zip(self.ids, p)}

    def classify(self, crops: list[np.ndarray]) -> tuple[str, float, str]:
        """(catalog_item_id, probability, matched prompt)."""
        probs = self.probabilities(crops)
        cid = max(probs, key=probs.get)
        return cid, probs[cid], self._per_category(crops)[1][cid]
