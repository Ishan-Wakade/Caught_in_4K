import { describe, expect, it, vi } from "vitest";
import { Assist, fromCoco, GIVE_UP_AFTER_S, type Asked } from "./assist";
import type { GuideMessage } from "./message";

const CUP: GuideMessage = { bin: "recycle", explanation: "clear plastic cup, placed in recycling" };
const CLIP_CAN = { id: "aluminum_can", message: { bin: "recycle", explanation: "aluminum can, placed in recycling" } as GuideMessage };
const JPEG = "data:image/jpeg;base64,AA";
const flush = () => new Promise((r) => setTimeout(r, 0));

function make(result: () => Promise<Asked>) {
  const identify = vi.fn((_crops: string[]) => result());
  return { a: new Assist(identify), identify };
}

describe("Assist (CLIP first, then DeepSeek + Jev on the held item)", () => {
  it("asks once with two crops and then shows and speaks the server's signed answer", async () => {
    const { a, identify } = make(async () => ({ message: CUP, source: "llm", sig: "ab" }));
    const crop = vi.fn(() => [JPEG]);
    expect(a.step(1, 0, 0, null, crop).banner).toBeNull();
    a.step(1, 0, 0.3, null, crop);
    expect(identify).toHaveBeenCalledTimes(1);
    expect(identify.mock.calls[0][0]).toHaveLength(2);
    await flush();
    const d = a.step(1, 0, 0.4, null, crop);
    expect(d.banner).toEqual({ message: CUP, fallback: false, source: "llm" });
    expect(d.speak).toEqual({ message: CUP, source: "llm", body: { message: CUP, sig: "ab" } });
    expect(a.step(1, 0, 0.5, null, crop).speak).toBeNull(); // once per item
    expect(identify).toHaveBeenCalledTimes(1);
  });

  it("shows CLIP's catalog answer at once while the server is still thinking", () => {
    const { a } = make(() => new Promise(() => {}));
    expect(a.step(1, 0, 0, CLIP_CAN, () => [JPEG]).banner).toEqual({ message: CLIP_CAN.message, fallback: false, source: "clip" });
  });

  it("the server's answer replaces CLIP's (it is the better model)", async () => {
    const { a } = make(async () => ({ message: CUP, source: "llm", sig: "ab" }));
    a.step(1, 0, 0, CLIP_CAN, () => [JPEG, JPEG]);
    await flush();
    expect(a.step(1, 0, 0.1, CLIP_CAN, () => [JPEG]).banner?.message).toEqual(CUP);
  });

  it("nothing held (server says so): no banner and no voice for this item", async () => {
    const { a } = make(async () => ({ message: null, source: "nothing_held", sig: null }));
    a.step(1, 0, 0, CLIP_CAN, () => [JPEG, JPEG]);
    await flush();
    const d = a.step(1, 0, 0.1, CLIP_CAN, () => [JPEG]);
    expect(d.banner).toBeNull();
    expect(d.speak).toBeNull();
  });

  it("no answer in time: CLIP's catalog answer is spoken by id, and a late answer is ignored", async () => {
    let resolve!: (r: Asked) => void;
    const { a } = make(() => new Promise((r) => (resolve = r)));
    a.step(1, 0, 0, CLIP_CAN, () => [JPEG, JPEG]);
    const d = a.step(1, 0, GIVE_UP_AFTER_S, CLIP_CAN, () => [JPEG]);
    expect(d.speak).toEqual({ message: CLIP_CAN.message, source: "clip", body: { kind: "catalog", id: "aluminum_can" } });
    resolve({ message: CUP, source: "llm", sig: "ab" });
    await flush();
    const later = a.step(1, 0, GIVE_UP_AFTER_S + 0.5, CLIP_CAN, () => [JPEG]);
    expect(later.banner?.message).toEqual(CLIP_CAN.message);
    expect(later.speak).toBeNull();
  });

  it("no answer in time and nothing from CLIP: trash (the team's default), shown as a fallback", () => {
    const { a } = make(() => new Promise(() => {}));
    a.step(1, 0, 0, null, () => [JPEG, JPEG]);
    const d = a.step(1, 0, GIVE_UP_AFTER_S, null, () => [JPEG]);
    expect(d.banner).toMatchObject({ fallback: true, message: { bin: "trash" } });
    expect(d.speak?.body).toEqual({ kind: "default" });
  });

  it("a failed request is trash, not silence", async () => {
    const { a } = make(() => Promise.reject(new Error("503")));
    a.step(1, 0, 0, null, () => [JPEG, JPEG]);
    await flush();
    const d = a.step(1, 0, 0.1, null, () => []);
    expect(d.banner).toMatchObject({ fallback: true, message: { bin: "trash" } });
    expect(d.speak?.body).toEqual({ kind: "default" });
  });

  it("no crop may leave the device (no face detector): never asks, behaves like CLIP alone", () => {
    const { a, identify } = make(async () => ({ message: CUP, source: "llm", sig: "ab" }));
    for (let t = 0; t < 3; t += 0.1) a.step(1, 0, t, CLIP_CAN, () => []);
    expect(identify).not.toHaveBeenCalled();
  });

  it("a new item (new hold start) asks again", async () => {
    const { a, identify } = make(async () => ({ message: CUP, source: "llm", sig: "ab" }));
    a.step(1, 0, 0, null, () => [JPEG, JPEG]);
    await flush();
    a.step(1, 5, 5, null, () => [JPEG, JPEG]);
    expect(identify).toHaveBeenCalledTimes(2);
  });
});

describe("fromCoco", () => {
  it("maps the 17 COCO keypoints to named points for headBox", () => {
    const kp = Array.from({ length: 17 }, (_, i) => [i, 10 * i, 0.9]);
    const p = fromCoco(kp);
    expect(p.nose).toEqual({ x: 0, y: 0, v: 0.9 });
    expect(p.rightEar).toEqual({ x: 4, y: 40, v: 0.9 });
    expect(p.leftShoulder?.x).toBe(5);
    expect(p.rightWrist?.x).toBe(10);
    expect(p.rightAnkle?.x).toBe(16);
  });
});
