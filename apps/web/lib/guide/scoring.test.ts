import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/parity.json";
import { Watcher, defaultTrash, fromCatalog, handBox, score, type GuideData, type Keypoints } from "./scoring";

// The worker's own outputs on real hand crops (scripts/build_guide_model.py); this port must reproduce them.
const data = JSON.parse(readFileSync(new URL("../../public/models/guide.json", import.meta.url), "utf8")) as GuideData;

describe("parity with the worker's voice guide", () => {
  it("scores hand crops like items.Scorer", () => {
    for (const c of fixture.score) {
      const s = score(c.embedding, data);
      expect(s.pItem).toBeCloseTo(c.p_item, 3);
      s.pCat.forEach((p, i) => expect(p).toBeCloseTo(c.p_cat[i], 3));
    }
  });

  it("finds hand boxes like items.hand_box", () => {
    for (const c of fixture.hand_box) {
      const b = handBox(c.kp as Keypoints, c.side as "L" | "R", c.size[0], c.size[1]);
      expect(b).not.toBeNull();
      b!.forEach((v, i) => expect(v).toBeCloseTo(c.box[i], 1));
    }
  });

  for (const [name, c] of Object.entries(fixture.watcher)) {
    it(`votes like ItemWatcher (${name})`, () => {
      const w = new Watcher(data);
      let next = 0;
      for (const step of c.steps) {
        // The worker embeds a crop only when an observation is due, so the sequence is consumed the same way.
        if (w.due(1, step.t)) w.observe(1, step.t, [c.embeddings[next++]]);
        expect(w.holding(1, step.t)).toBe(step.holding);
        expect(w.answer(1)).toEqual(step.answer);
      }
    });
  }

  it("words catalog messages like guide_message", () => {
    for (const [id, m] of Object.entries(fixture.catalog_messages)) expect(fromCatalog(id, data)).toEqual(m);
    expect(defaultTrash(data)).toEqual(fixture.default_trash);
  });

  it("never answers a hazard from the catalog", () => {
    expect(data.cats.filter((c) => c.startsWith("hazard:")).every((c) => !(c in data.table))).toBe(true);
  });
});
