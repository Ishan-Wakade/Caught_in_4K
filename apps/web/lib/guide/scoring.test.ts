import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fixture from "./__fixtures__/parity.json";
import { Watcher, defaultTrash, fromCatalog, handBox, handScan, lookAt, score, type GuideData, type Keypoints } from "./scoring";

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

  it("scans the same boxes as items.hand_scan", () => {
    for (const c of fixture.hand_scan) {
      const boxes = handScan(c.kp as Keypoints, c.size[0], c.size[1]);
      expect(boxes).toHaveLength(c.boxes.length);
      boxes.forEach((b, j) => b.forEach((v, i) => expect(v).toBeCloseTo(c.boxes[j][i], 1)));
    }
  });

  it("scans a raised hand up to the face (the hold-up screenshot, 17 Oct)", () => {
    const k = Array.from({ length: 17 }, () => [0, 0, 0]);
    [k[0], k[5], k[6], k[7], k[9], k[8], k[10]] = [[998, 421, 0.93], [1356, 773, 0.79], [612, 796, 0.67], [1569, 1035, 0.36],
      [1426, 840, 0.65], [429, 1089, 0.12], [500, 971, 0.32]];
    const inside = (b: number[]) => b[0] <= 1000 && 1000 <= b[2] && b[1] <= 650 && 650 <= b[3];
    expect(inside(handBox(k, "L", 2000, 1089)!)).toBe(false);
    expect(handScan(k, 2000, 1089).some(inside)).toBe(true);
    // items.hand_scan on the same keypoints (worker, 17 Oct): hand boxes, grown, then wrist-to-face for each raised wrist
    const worker = [[1188.4, 584.2, 1563.5, 959.3], [1075.8, 471.6, 1676.1, 1071.9], [57.1, 423.9, 942.9, 1089], [0, 47.8, 1208.6, 1089],
      [762.8, 181.3, 1661.2, 1079.7], [192.5, 139.5, 1305.5, 1089]];
    handScan(k, 2000, 1089).forEach((box, j) => box.forEach((v, i) => expect(v).toBeCloseTo(worker[j][i], 0)));
  });

  // Same cases as worker/tests/test_guide_identify.py (hold-up at a webcam: the elbow is below the frame).
  const webcam = ({ shoulders = true, ears = false } = {}): Keypoints => {
    const k = Array.from({ length: 17 }, () => [0, 0, 0]);
    k[9] = [420, 250, 0.9];
    if (shoulders) [k[5], k[6]] = [[400, 300, 0.9], [800, 300, 0.9]];
    if (ears) [k[3], k[4]] = [[560, 200, 0.9], [720, 200, 0.9]];
    return k;
  };

  it("finds a hand box without the elbow, sized from the shoulders or ears", () => {
    handBox(webcam(), "L", 1280, 720)!.forEach((v, i) => expect(v).toBeCloseTo([182, 0, 658, 432][i], 1));
    handBox(webcam({ shoulders: false, ears: true }), "L", 1280, 720)!
      .forEach((v, i) => expect(v).toBeCloseTo([188.8, 0, 651.2, 426.8][i], 1));
    expect(handBox(webcam({ shoulders: false }), "L", 1280, 720)).toBeNull();
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

  it("labels a crop with its closest prompt, background included (debug overlay)", () => {
    expect(lookAt(data.bg_text[data.background.indexOf("a hand")], data).label).toBe("a hand");
    const can = data.item_text[data.prompt_owner.indexOf(data.cats.indexOf("item_generic_can"))];
    expect(lookAt(can, data)).toMatchObject({ label: "can" });
  });

  it("votes split between a product and its generic kind answer the generic kind (ItemWatcher._catalog)", () => {
    const w = new Watcher(data);
    const bag = data.cats.indexOf("item_goldfish_bag");
    const wrapper = data.cats.indexOf("item_generic_wrapper");
    // one embedding per category: its own text embedding, so CLIP votes for it; alternate the two, as on 17 Oct
    const emb = (c: number) => data.item_text[data.prompt_owner.indexOf(c)];
    for (let i = 0; i < 8; i++) w.observe(1, 0.1 * i, [emb(i % 2 ? wrapper : bag)]);
    expect(w.answerId(1)).toBe("item_generic_wrapper");
  });

  it("never answers a hazard from the catalog", () => {
    expect(data.cats.filter((c) => c.startsWith("hazard:")).every((c) => !(c in data.table))).toBe(true);
  });
});
