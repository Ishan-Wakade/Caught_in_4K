import { describe, expect, it, vi } from "vitest";
import { Assist, CLIP_WAIT_S, fromCoco, GIVE_UP_AFTER_S, type Asked } from "./assist";
import type { GuideMessage } from "./message";

const CUP: GuideMessage = { bin: "recycle", explanation: "clear plastic cup, placed in recycling" };
const CLIP_CAN = { id: "aluminum_can", message: { bin: "recycle", explanation: "aluminum can, placed in recycling" } as GuideMessage };
const JPEG = "data:image/jpeg;base64,AA";
const flush = () => new Promise((r) => setTimeout(r, 0));

function make(result: () => Promise<Asked>, sayTrash = true) {
  const identify = vi.fn((_crops: string[]) => result());
  return { a: new Assist(identify, sayTrash), identify };
}

describe("Assist (CLIP first, then DeepSeek + Jev on the held item)", () => {
  it("asks with the first crop, then shows and speaks the server's signed answer once", async () => {
    const { a, identify } = make(async () => ({ message: CUP, source: "llm", sig: "ab" }));
    const crop = vi.fn(() => [JPEG]);
    expect(a.step(1, 0, 0, null, crop).banner).toBeNull();
    expect(identify).toHaveBeenCalledTimes(1);
    expect(identify.mock.calls[0][0]).toHaveLength(1);
    await flush();
    const d = a.step(1, 0, 0.1, null, crop);
    expect(d.banner).toEqual({ message: CUP, fallback: false, source: "llm" });
    expect(d.speak).toEqual({ message: CUP, source: "llm", body: { message: CUP, sig: "ab" } });
    expect(a.step(1, 0, 0.2, null, crop).speak).toBeNull(); // once per item
    expect(identify).toHaveBeenCalledTimes(1);
  });

  it("CLIP's catalog answer is shown and spoken at once, and a later server answer does not replace it", async () => {
    expect(CLIP_WAIT_S).toBe(0);
    const { a } = make(async () => ({ message: CUP, source: "llm", sig: "ab" }));
    const d = a.step(1, 0, 0, CLIP_CAN, () => [JPEG]);
    expect(d.banner).toEqual({ message: CLIP_CAN.message, fallback: false, source: "clip" });
    expect(d.speak?.body).toEqual({ kind: "catalog", id: "aluminum_can" });
    await flush();
    const later = a.step(1, 0, 0.5, CLIP_CAN, () => [JPEG]);
    expect(later.banner?.message).toEqual(CLIP_CAN.message);
    expect(later.speak).toBeNull();
  });

  it("nothing held (server says so, twice): no banner and no voice for this item", async () => {
    const { a, identify } = make(async () => ({ message: null, source: "nothing_held", sig: null }));
    a.step(1, 0, 0, null, () => [JPEG]);
    await flush();
    a.step(1, 0, 0.4, null, () => [JPEG]); // one more look (CLIP still sees an item)
    await flush();
    const d = a.step(1, 0, 0.8, null, () => [JPEG]);
    expect(identify).toHaveBeenCalledTimes(2);
    expect(d.banner).toBeNull();
    expect(d.speak).toBeNull();
    a.step(1, 0, 1.2, null, () => [JPEG]);
    expect(identify).toHaveBeenCalledTimes(2); // no third ask
  });

  it("a bad crop (nothing held or unclear) gets one more look, and that answer is shown", async () => {
    const answers: Asked[] = [{ message: null, source: "unclear", sig: null }, { message: CUP, source: "llm", sig: "ab" }];
    const { a, identify } = make(async () => answers.shift()!, false);
    a.step(1, 0, 0, null, () => [JPEG]);
    await flush();
    expect(a.step(1, 0, 0.1, null, () => [JPEG]).banner).toBeNull(); // too soon for the next crop
    a.step(1, 0, 0.4, null, () => [JPEG]);
    await flush();
    const d = a.step(1, 0, 0.5, null, () => []);
    expect(identify).toHaveBeenCalledTimes(2);
    expect(d.banner?.message).toEqual(CUP);
    expect(d.speak?.message).toEqual(CUP);
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

  it("live demo (no trash when unsure): no answer in time is silence, and a late answer is still spoken", async () => {
    let resolve!: (r: Asked) => void;
    const { a } = make(() => new Promise((r) => (resolve = r)), false);
    a.step(1, 0, 0, null, () => [JPEG, JPEG]);
    const d = a.step(1, 0, GIVE_UP_AFTER_S, null, () => []);
    expect(d.banner).toBeNull();
    expect(d.speak).toBeNull();
    resolve({ message: CUP, source: "llm", sig: "ab" });
    await flush();
    expect(a.step(1, 0, GIVE_UP_AFTER_S + 1, null, () => []).speak?.message).toEqual(CUP);
  });

  it("live demo: a failed or unsure server answer is silent, or CLIP's catalog answer if it has one", async () => {
    const unsure = { message: { bin: "trash", explanation: "not sure what this is, placed in trash" } as GuideMessage, source: "default", sig: "ab" };
    const { a } = make(async () => unsure, false);
    a.step(1, 0, 0, null, () => [JPEG, JPEG]);
    await flush();
    expect(a.step(1, 0, 0.1, null, () => [])).toEqual({ banner: null, speak: null });
    const b = make(() => Promise.reject(new Error("503")), false).a;
    b.step(1, 0, 0, null, () => [JPEG]);
    await flush();
    expect(b.step(1, 0, 0.1, CLIP_CAN, () => []).speak?.body).toEqual({ kind: "catalog", id: "aluminum_can" });
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
