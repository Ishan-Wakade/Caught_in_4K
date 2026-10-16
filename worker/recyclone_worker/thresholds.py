"""Calibrate core's confidence thresholds for this embedder (run after `enroll`).

CLIP similarity is high even between unrelated objects (16 Oct spike: random litter scored a median
0.71 and up to 0.83 against the references). A threshold of 0.5 therefore calls everything
"identified", and the unknown-item and review-queue scenarios never happen. This scores a set of
things that are NOT in the catalog (TACO litter crops) against the gallery and suggests a threshold
above almost all of them, for demo-site.json `item_confidence_threshold` and
`business_confidence_threshold`.
"""

import json
import random
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

from .identify import Embedder, Gallery


def best_scores(crops: list[np.ndarray], embedder: Embedder, gallery: Gallery) -> list[float]:
    return [float(np.max(gallery.vecs @ embedder.embed(c))) for c in crops]


def suggest_threshold(distractor_scores: list[float], quantile: float = 0.99) -> float | None:
    if not distractor_scores:
        return None
    return round(float(np.quantile(distractor_scores, quantile)), 3)


def taco_crops(taco_data_dir: Path, n: int = 200, min_area: int = 20000, seed: int = 0) -> list[np.ndarray]:
    """Litter crops from TACO (data/annotations.json + image batches), BGR, at most n."""
    taco_data_dir = Path(taco_data_dir).expanduser()
    ann = json.loads((taco_data_dir / "annotations.json").read_text())
    images = {i["id"]: i for i in ann["images"]}
    candidates = [a for a in ann["annotations"] if a["area"] > min_area]
    random.Random(seed).shuffle(candidates)
    crops = []
    for a in candidates:
        if len(crops) >= n:
            break
        info = images[a["image_id"]]
        path = taco_data_dir / info["file_name"]
        if not path.exists():
            continue
        im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        sx, sy = im.width / info["width"], im.height / info["height"]  # some files were saved smaller
        x, y, w, h = a["bbox"]
        crop = np.asarray(im.crop((int(x * sx), int(y * sy), int((x + w) * sx), int((y + h) * sy))))[:, :, ::-1]
        if crop.size:
            crops.append(np.ascontiguousarray(crop))
    return crops
