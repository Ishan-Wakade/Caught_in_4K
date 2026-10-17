import { describe, expect, it } from "vitest";
import { Approach, distanceM, headBox, handBox, metersPerPx, Tracker, type Pose } from "./approach";

const AREA = { x0: 800, y0: 300, x1: 1000, y1: 700 };

/** A standing 1.7 m person whose ankles are at (fx, fy), nose `h` px above them. */
function person(fx: number, fy = 700, h = 340): Pose {
  const top = fy - h / 0.87;
  const p = (x: number, y: number) => ({ x, y, v: 0.9 });
  return {
    nose: p(fx, fy - h), leftEye: p(fx - 5, fy - h - 5), rightEye: p(fx + 5, fy - h - 5),
    leftShoulder: p(fx + 25, top + 60), rightShoulder: p(fx - 25, top + 60),
    leftHip: p(fx + 15, top + 180), rightHip: p(fx - 15, top + 180),
    leftAnkle: p(fx + 10, fy), rightAnkle: p(fx - 10, fy),
  };
}

describe("approach (same rules as worker/recyclone_worker/approach.py)", () => {
  it("uses the person's height as a ruler", () => {
    expect(Math.abs((metersPerPx(person(100)) ?? 0) * 340 / 0.87 - 1.7)).toBeLessThan(0.05);
  });
  it("walking toward the bins triggers once, at least 1.5 s before arrival", () => {
    const a = new Approach(AREA);
    const pxPerM = 340 / 0.87 / 1.7;
    const fired: number[] = [];
    for (let k = 0; k < 100; k++) {
      const t = k / 30;
      if (a.update(1, t, person(AREA.x0 - (4 - t) * pxPerM))) fired.push(t);
    }
    expect(fired.length).toBe(1);
    expect(4 - fired[0]).toBeGreaterThanOrEqual(1.5);
  });
  it("walking away never triggers; standing inside triggers once", () => {
    const a = new Approach(AREA);
    expect(Array.from({ length: 60 }, (_, k) => a.update(1, k / 30, person(AREA.x0 - 300 - 8 * k))).some(Boolean)).toBe(false);
    const b = new Approach(AREA);
    expect(Array.from({ length: 90 }, (_, k) => b.update(2, k / 30, person(900, 650))).filter(Boolean).length).toBe(1);
  });
  it("no feet in view: no distance, no trigger", () => {
    const p = person(900, 650);
    delete p.leftAnkle;
    delete p.rightAnkle;
    expect(distanceM(p, AREA)).toBeNull();
  });
});

describe("hand crop and head box", () => {
  it("hand box sits past the wrist along the forearm", () => {
    const b = handBox({ x: 300, y: 200, v: 0.9 }, { x: 300, y: 300, v: 0.9 }, 640, 480);
    expect(b && b.y0 > 260 && b.y1 > 300).toBe(true);
  });
  it("head box covers the face and is unreliable when it cannot be sized", () => {
    const hb = headBox(person(300, 700));
    expect(hb && hb.box.x0 < 300 && hb.box.x1 > 300 && hb.reliable).toBe(true);
    const lone: Pose = { nose: { x: 300, y: 330, v: 0.9 } };
    expect(headBox(lone)?.reliable).toBe(false);
  });
});

describe("tracker", () => {
  it("keeps ids for people who move a little and gives a new id to someone new", () => {
    const tr = new Tracker();
    const [a] = tr.update([person(100)], 0);
    const [b] = tr.update([person(110)], 0.03);
    const both = tr.update([person(115), person(900)], 0.06);
    expect(b.id).toBe(a.id);
    expect(both.map((p) => p.id)).toEqual([a.id, a.id + 1]);
  });
});
