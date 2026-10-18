import { describe, expect, it } from "vitest";
import { autoLevels, keepRegion, pickPrimary, raisedHands, upperBody } from "./focus";

const kp = (over: Record<number, [number, number, number]> = {}) => Array.from({ length: 17 }, (_, j) => over[j] ?? [0, 0, 0]);

describe("pickPrimary (the person at the camera)", () => {
  it("picks the largest person, only if near enough", () => {
    const far = { box: [0, 0, 100, 200] as [number, number, number, number], kp: kp() };
    const near = { box: [300, 100, 900, 700] as [number, number, number, number], kp: kp() };
    expect(pickPrimary([far, near], 1280, 720)).toBe(1);
    expect(pickPrimary([far], 1280, 720)).toBe(-1); // only small people: nobody is at the camera
    expect(pickPrimary([], 1280, 720)).toBe(-1);
  });
});

describe("raisedHands", () => {
  it("drops a wrist below its elbow (resting on a table), keeps a raised one and one whose elbow is unseen", () => {
    const k = raisedHands(kp({ 7: [100, 300, 0.9], 9: [110, 400, 0.9], 8: [500, 300, 0.9], 10: [520, 200, 0.9], 4: [0, 0, 0] }));
    expect(k[9][2]).toBe(0);
    expect(k[10][2]).toBe(0.9);
    const closeUp = raisedHands(kp({ 9: [300, 600, 0.9] }));
    expect(closeUp[9][2]).toBe(0.9);
  });
});

describe("keepRegion / upperBody", () => {
  it("stays inside the person's grown box and the frame, and contains the hand", () => {
    const p = { box: [400, 100, 800, 700] as [number, number, number, number], kp: kp({ 5: [500, 300, 0.9], 6: [700, 300, 0.9], 10: [650, 250, 0.9] }) };
    const [k0, k1, k2, k3] = keepRegion(p, 1280, 720);
    expect([k0, k1, k2, k3]).toEqual([340, 10, 860, 720]);
    const [x0, y0, x1, y1] = upperBody(p, [600, 150, 720, 270], 1280, 720);
    expect(x0).toBeGreaterThanOrEqual(k0);
    expect(x1).toBeLessThanOrEqual(k2);
    expect(x0).toBeLessThanOrEqual(600);
    expect(y0).toBeLessThanOrEqual(150);
    expect(y1).toBeGreaterThanOrEqual(300);
  });
});

describe("autoLevels", () => {
  it("stretches a dim picture and leaves black (redacted) pixels black", () => {
    const px = new Uint8ClampedArray(4 * 400);
    for (let i = 0; i < 400; i++) px.set(i < 100 ? [0, 0, 0, 255] : [40 + (i % 40), 40 + (i % 40), 40 + (i % 40), 255], 4 * i);
    autoLevels(px);
    expect([px[0], px[1], px[2]]).toEqual([0, 0, 0]);
    const vals = Array.from({ length: 300 }, (_, i) => px[4 * (i + 100)]);
    expect(Math.max(...vals) - Math.min(...vals)).toBeGreaterThan(200);
  });
});
