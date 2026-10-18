import { describe, expect, it } from "vitest";
import { itemAndBin, outcomeText } from "./overlay";

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

describe("outcomeText (bins.outcome_text)", () => {
  const cup = { bin: "recycle" as const, explanation: "clear plastic cup, placed in recycling" };
  it("says CORRECT when the item went into its own bin", () => {
    expect(outcomeText(cup, { t: 1, bin: "recycle", label: "RECYCLING" })).toEqual(["Thrown in: Recycling", "CORRECT", true]);
  });
  it("says WRONG BIN otherwise, with the bin's standard name", () => {
    expect(outcomeText(cup, { t: 1, bin: "trash", label: "LANDFILL" })).toEqual(["Thrown in: Waste", "WRONG BIN", false]);
  });
  it("says nothing for an opening whose bin is unknown", () => {
    expect(outcomeText(cup, { t: 1, bin: "unknown", label: "UNKNOWN" })).toBeNull();
  });
});
