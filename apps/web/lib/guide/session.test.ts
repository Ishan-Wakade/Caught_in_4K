import { describe, expect, it, vi } from "vitest";
import { fromMediaPipe, GuideSession } from "./session";
import type { Pose } from "./approach";
import type { GuideMessage } from "./message";

const AREA = { x0: 800, y0: 300, x1: 1000, y1: 700 };
const PX_PER_M = 340 / 0.87 / 1.7;
const CAN: GuideMessage = { bin: "recycle", explanation: "aluminum can, placed in recycling" };

function person(fx: number, fy = 700, h = 340): Pose {
  const top = fy - h / 0.87;
  const p = (x: number, y: number) => ({ x, y, v: 0.9 });
  return { nose: p(fx, fy - h), leftShoulder: p(fx + 25, top + 60), rightShoulder: p(fx - 25, top + 60),
    leftElbow: p(fx + 30, top + 130), leftWrist: p(fx + 30, top + 200), leftHip: p(fx + 15, top + 180),
    rightHip: p(fx - 15, top + 180), leftAnkle: p(fx + 10, fy), rightAnkle: p(fx - 10, fy) };
}

async function run(session: GuideSession, people: (t: number) => Array<{ id: number; pose: Pose }>, seconds = 6) {
  for (let k = 0; k < seconds * 30; k++) {
    session.step(k / 30, people(k / 30));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}

function make(result: () => Promise<{ message: GuideMessage | null; source: string }>, capture = () => "data:image/jpeg;base64,AA") {
  const speak = vi.fn();
  const identify = vi.fn((_crops: string[]) => result());
  return { s: new GuideSession(AREA, { identify, speak, capture: vi.fn(capture) }), speak, identify };
}

describe("guide session (phone)", () => {
  it("identifies once while the person walks up, and speaks before they arrive", async () => {
    const { s, speak, identify } = make(async () => ({ message: CAN, source: "catalog" }));
    await run(s, (t) => [{ id: 1, pose: person(AREA.x0 - (5 - t) * PX_PER_M) }]);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(identify.mock.calls[0][0].length).toBeLessThanOrEqual(3);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0]).toEqual(CAN);
    expect(speak.mock.calls[0][1]).toBeLessThan(5);  // spoken before arrival at t = 5 s
  });
  it("nothing in the hand: silent", async () => {
    const { s, speak } = make(async () => ({ message: null, source: "nothing_held" }));
    await run(s, () => [{ id: 1, pose: person(900, 650) }], 3);
    expect(speak).not.toHaveBeenCalled();
  });
  it("answer still missing after arrival: says trash (default)", async () => {
    const { s, speak } = make(() => new Promise(() => {}));
    await run(s, (t) => [{ id: 1, pose: person(Math.min(900, AREA.x0 - (3 - t) * PX_PER_M)) }], 8);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak.mock.calls[0][0].bin).toBe("trash");
  });
  it("no crop may leave the phone (faces could not be removed): nothing sent, nothing said", async () => {
    const { s, speak, identify } = make(async () => ({ message: CAN, source: "catalog" }), () => null as unknown as string);
    await run(s, () => [{ id: 1, pose: person(900, 650) }], 3);
    expect(identify).not.toHaveBeenCalled();
    expect(speak).not.toHaveBeenCalled();
  });
  it("two people each hear their own answer", async () => {
    const answers: Record<number, GuideMessage> = { 1: CAN, 2: { bin: "compost", explanation: "paper napkin, placed in compost" } };
    let n = 0;
    const { s, speak } = make(async () => ({ message: answers[++n], source: "catalog" }));
    await run(s, (t) => [{ id: 1, pose: person(AREA.x0 - (5 - t) * PX_PER_M) }, { id: 2, pose: person(AREA.x0 - (5.5 - t) * PX_PER_M, 520) }], 7);
    expect(speak.mock.calls.map((c) => c[0].bin).sort()).toEqual(["compost", "recycle"]);
  });
});

describe("MediaPipe landmarks -> pose", () => {
  it("maps the 33 normalized landmarks to named pixel points", () => {
    const lm = Array.from({ length: 33 }, (_, i) => ({ x: i / 100, y: 0.5, z: 0, visibility: 0.9 }));
    const p = fromMediaPipe(lm, 1000, 800);
    expect(p.nose).toEqual({ x: 0, y: 400, v: 0.9 });
    expect(p.leftWrist?.x).toBe(150);
    expect(p.rightAnkle?.x).toBe(280);
  });
});
