import { describe, expect, it } from "vitest";
import { itemAndBin, unionBox } from "./overlay";

describe("itemAndBin (the bottom bar, same as the worker's item_and_bin)", () => {
  it("splits a placed message into the item and the bin label", () => {
    expect(itemAndBin({ bin: "recycle", explanation: "clear plastic cup, placed in recycling" })).toEqual(["clear plastic cup", "Recycle"]);
    expect(itemAndBin({ bin: "compost", explanation: "paper napkin, placed in compost" })).toEqual(["paper napkin", "Compost"]);
  });
  it("names the drop-off for a dangerous item, without a leading 'the'", () => {
    const m = { bin: "none" as const, explanation: "AA battery is dangerous to place in any of these bins. Place it in the Recycle Center instead" };
    expect(itemAndBin(m)).toEqual(["AA battery", "No bin: Recycle Center"]);
  });
  it("keeps an explanation it cannot split as the item", () => {
    expect(itemAndBin({ bin: "trash", explanation: "not sure" })).toEqual(["not sure", "Trash"]);
  });
});

describe("unionBox (one black box around the hands holding the item)", () => {
  it("covers every hand box", () => {
    expect(unionBox([[10, 20, 30, 40], [25, 5, 50, 35]])).toEqual([10, 5, 50, 40]);
  });
  it("is null without hands", () => {
    expect(unionBox([])).toBeNull();
  });
});
