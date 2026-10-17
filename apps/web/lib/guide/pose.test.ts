import { describe, expect, it } from "vitest";
import { PersonTracker, decodePose, letterbox, type Person } from "./pose";

/** A fake output0 with the given anchors set: [cx, cy, w, h, score] plus one keypoint value for all 17. */
function output(anchors: number, set: { i: number; box: number[]; score: number; kp: [number, number, number] }[]) {
  const out = new Float32Array(56 * anchors);
  for (const a of set) {
    [...a.box, a.score].forEach((v, row) => (out[row * anchors + a.i] = v));
    for (let j = 0; j < 17; j++) a.kp.forEach((v, c) => (out[(5 + 3 * j + c) * anchors + a.i] = v));
  }
  return out;
}

describe("pose decoding", () => {
  it("letterboxes like ultralytics", () => {
    expect(letterbox(1280, 720)).toEqual({ scale: 0.5, width: 640, height: 360, left: 0, top: 140 });
    expect(letterbox(1080, 1920)).toMatchObject({ width: 360, height: 640, left: 140, top: 0 });
  });

  it("maps boxes and keypoints back to frame pixels, drops low scores, and suppresses overlaps", () => {
    const lb = letterbox(1280, 720);
    const out = output(10, [
      { i: 2, box: [320, 320, 100, 200], score: 0.9, kp: [330, 300, 0.8] },
      { i: 5, box: [322, 321, 100, 200], score: 0.6, kp: [0, 0, 0.5] }, // same person, weaker: suppressed
      { i: 7, box: [100, 300, 50, 100], score: 0.2, kp: [0, 0, 0.5] }, // below conf 0.3
    ]);
    const people = decodePose(out, lb, 10);
    expect(people).toHaveLength(1);
    expect(people[0].box).toEqual([540, 160, 740, 560]);
    expect(people[0].kp[0][0]).toBeCloseTo(660);
    expect(people[0].kp[0][1]).toBeCloseTo(320);
    expect(people[0].kp[0][2]).toBeCloseTo(0.8);
  });
});

describe("person tracker", () => {
  const at = (x: number): Person => ({ box: [x, 0, x + 100, 200], score: 1, kp: [] });

  it("keeps ids across small moves and gives new people new ids", () => {
    const t = new PersonTracker();
    expect(t.update([at(0)], 0).ids).toEqual([1]);
    expect(t.update([at(10), at(500)], 0.1).ids).toEqual([1, 2]);
  });

  it("forgets people unseen for a second", () => {
    const t = new PersonTracker();
    t.update([at(0)], 0);
    expect(t.update([], 1.5).gone).toEqual([1]);
    expect(t.update([at(0)], 1.6).ids).toEqual([2]);
  });
});
