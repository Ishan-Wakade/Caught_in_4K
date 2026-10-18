import { describe, expect, it } from "vitest";
import type { ItemAnswer, Opening } from "./claude";
import { LiveWatcher, demoHandBox, sameOpenings, thrownInto, type Event, type Sighting } from "./watch";

type B = [number, number, number, number];
const op = (bin: Opening["bin"], label: string, box: B): Opening => ({ bin, label, box });

describe("thrownInto (bins.thrown_into on one finished carrying stretch)", () => {
  const ops = [op("recycle", "RECYCLING", [420, 950, 500, 990]), op("compost", "ORGANICS", [410, 1080, 520, 1150])];

  it("is the opening the item was held over in the stretch's last second", () => {
    const s: Sighting[] = [{ t: 1.0, box: [300, 600, 380, 680] }, { t: 2.0, box: [430, 1060, 510, 1140] }, { t: 2.2, box: [440, 1080, 500, 1140] }];
    expect(thrownInto(s, ops)).toEqual({ t: 2.2, bin: "compost", label: "ORGANICS" });
  });
  it("is null when the item was never over an opening, or no openings are known", () => {
    expect(thrownInto([{ t: 1.0, box: [0, 0, 50, 50] }], ops)).toBeNull();
    expect(thrownInto([{ t: 2.2, box: [440, 1080, 500, 1140] }], [])).toBeNull();
  });
  it("uses where the item hangs (bottom middle), not the hand centre (IMG_9117, camera above)", () => {
    const three = [op("recycle", "RECYCLING", [526, 1196, 625, 1241]), op("trash", "WASTE", [518, 1259, 635, 1320]), op("compost", "ORGANICS", [509, 1348, 648, 1435])];
    const s: Sighting[] = [...Array.from({ length: 8 }, (_, k) => ({ t: 6 + k / 10, box: [300, 1060, 400, 1160] as B })),
      { t: 6.81, box: [504, 1121, 663, 1280] }, { t: 7.31, box: [478, 1158, 642, 1322] }];
    expect(thrownInto(s, three)?.label).toBe("WASTE");
  });
});

describe("demoHandBox (demo_watcher._hand_box)", () => {
  it("is the square past the wrist along the forearm; without the elbow, the close-up box from the shoulders", () => {
    const kp = Array.from({ length: 17 }, () => [0, 0, 0]);
    kp[7] = [100, 100, 0.9];
    kp[9] = [100, 200, 0.9];
    expect(demoHandBox(kp, "L", 1000, 1000)).toEqual([40, 175, 160, 295]);
    kp[7] = [100, 100, 0.1];
    expect(demoHandBox(kp, "L", 1000, 1000)).toBeNull();  // no elbow and no body to size it from
    kp[5] = [300, 300, 0.9];
    kp[6] = [500, 300, 0.9];
    expect(demoHandBox(kp, "L", 1000, 1000)).not.toBeNull();  // webcam close-up: elbow out of frame
  });
});

describe("LiveWatcher (the demo model's item logic, live)", () => {
  const ops = [op("recycle", "RECYCLING", [420, 950, 500, 990]), op("trash", "WASTE", [414, 1007, 508, 1055])];
  const cup: ItemAnswer = { message: { bin: "recycle", explanation: "clear plastic cup, placed in recycling" }, source: "catalog",
    item: { name: "clear plastic cup", material: "rigid_plastic", form: "cup", condition: "clean", confidence: 0.9, catalog_item_id: null } };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  function run(answer: ItemAnswer) {
    const asked: string[][] = [];
    const events: Event[] = [];
    const w = new LiveWatcher(async (c) => { asked.push(c); return answer; }, (e) => events.push(e));
    w.openings = ops;
    return { w, asked, events };
  }

  it("asks Claude once (two small crops, no good one yet), and the drop is into WASTE", async () => {
    const { w, asked, events } = run(cup);
    for (let k = 0; k <= 20; k++) {  // carried for 2 s, last 0.3 s over WASTE
      const t = 5 + k / 10;
      const box: B = k < 17 ? [200, 500, 260, 560] : [425, 1005, 505, 1060];
      w.observe(1, t, [box], [0.9], () => `crop@${t}`);
      w.tick(t, new Set([1]));
      await flush();
    }
    expect(asked).toEqual([["crop@5", "crop@5.5"]]);
    expect(w.holding(1, 7.0)).toBe(true);
    w.tick(7.6, new Set([1]));  // not seen for > 0.5 s: the stretch ended over WASTE
    expect(events).toHaveLength(1);
    expect(events[0].outcome).toEqual({ t: 7.0, bin: "trash", label: "WASTE" });
    expect(events[0].answer).toBe(cup);
    expect(w.items.size).toBe(0);
  });

  it("ignores hands CLIP does not see an item in, and a blip shorter than MIN_CARRY_S", async () => {
    const { w, events, asked } = run(cup);
    w.observe(1, 1.0, [[0, 0, 50, 50]], [0.2], () => "x");
    expect(w.items.size).toBe(0);
    w.observe(1, 8.24, [[420, 945, 500, 995]], [0.9], () => "late");  // walking away: one false sighting over RECYCLING
    w.tick(9.0, new Set([1]));
    await flush();
    expect(events.filter((e) => e.outcome)).toHaveLength(0);
    expect(asked).toHaveLength(1);
  });

  it("hides the item box when Claude says nothing is held, and asks again with newer crops", async () => {
    const none: ItemAnswer = { message: null, source: "nothing_held" };
    const { w, asked } = run(none);
    for (let k = 0; k <= 15; k++) {
      w.observe(1, k / 10, [[0, 0, 100, 100]], [0.8], () => `c${k}`);
      await flush();
    }
    expect(w.holding(1, 1.5)).toBe(false);
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.length).toBeLessThanOrEqual(3);
  });

  it("puts an answer that arrives after the drop on the finished item (IMG_9117: 2nd ask came back late)", async () => {
    const unsure: ItemAnswer = { message: { bin: "trash", explanation: "not sure what this is, placed in trash" }, source: "unclear" };
    const answers = [unsure, cup];
    let release: () => void = () => {};
    const events: Array<[Event, boolean | undefined]> = [];
    const w = new LiveWatcher(async () => {
      const a = answers.shift()!;
      if (a === cup) await new Promise<void>((r) => (release = r));
      return a;
    }, (e, update) => events.push([e, update]));
    w.openings = ops;
    for (let k = 0; k <= 20; k++) {
      const t = 5 + k / 10;
      w.observe(1, t, [k < 17 ? [200, 500, 260, 560] : [425, 1005, 505, 1060]], [0.9], () => `crop@${t}`);
      await flush();
    }
    w.tick(7.6, new Set([1]));
    expect(events[0][0].answer).toBe(unsure);
    release();
    await flush();
    await flush();
    expect(events[0][0].answer).toBe(cup);
    expect(events[1]).toEqual([events[0][0], true]);
  });
});

describe("LiveWatcher ask policy (crop quality)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  it("asks at once for one large, sure crop, and again at the drop with a better crop when Claude saw nothing", async () => {
    const asked: string[][] = [];
    const w = new LiveWatcher(async (c) => { asked.push(c); return { message: null, source: "nothing_held" }; });
    w.observe(1, 0, [[0, 0, 200, 200]], [0.9], () => "big");
    await flush();
    expect(asked).toEqual([["big"]]);
    w.observe(1, 0.3, [[0, 0, 200, 200]], [0.95], () => "same");  // within CROP_GAP_S: not kept
    w.observe(1, 0.55, [[0, 0, 300, 300]], [0.99], () => "better");
    await flush();
    expect(asked).toHaveLength(1);  // ASK_AGAIN_AFTER_S not yet passed
    w.tick(1.1, new Set([1]));       // the stretch ended: final ask with the newer crop
    await flush();
    expect(asked[1]).toEqual(["big", "better"]);
  });
});

describe("LiveWatcher drop frame (moving camera)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  it("judges the drop against the openings found in the drop frame, not the stale first-frame ones", async () => {
    const cup: ItemAnswer = { message: { bin: "recycle", explanation: "clear plastic cup, placed in recycling" }, source: "catalog" };
    const events: Event[] = [];
    let asked: Sighting[] = [];
    const moved = [op("recycle", "RECYCLING", [425, 1000, 505, 1050])];  // the camera moved: RECYCLING is now here
    const w = new LiveWatcher(async () => cup, (e) => events.push(e), async (_id, s) => { asked = s; return moved; });
    w.openings = [op("trash", "WASTE", [100, 100, 200, 150])];
    for (let k = 0; k <= 10; k++) w.observe(1, k / 10, [[425, 1005, 505, 1060]], [0.9], () => "c");
    w.tick(1.7, new Set([1]));
    expect(events).toHaveLength(0);  // still finding the bins
    await flush();
    expect(asked).toHaveLength(11);
    expect(events[0].outcome).toEqual({ t: 1.0, bin: "recycle", label: "RECYCLING" });
    expect(w.items.size).toBe(0);
  });
});

describe("sameOpenings (bins.same_openings)", () => {
  const a = [op("recycle", "RECYCLING", [526, 1196, 625, 1241]), op("trash", "WASTE", [518, 1259, 635, 1321])];
  it("is true for an arm-over-the-bins shift, false for a pan or a different count", () => {
    expect(sameOpenings(a, [op("recycle", "RECYCLING", [540, 1210, 640, 1250]), op("trash", "WASTE", [520, 1270, 640, 1330])], 1080)).toBe(true);
    expect(sameOpenings(a, a.map((o) => ({ ...o, box: o.box.map((v, i) => (i % 2 ? v : v + 400)) as typeof o.box })), 1080)).toBe(false);
    expect(sameOpenings(a, a.slice(0, 1), 1080)).toBe(false);
  });
});
