import { describe, expect, it } from "vitest";
import { outcomeOf, scoreLabel } from "./format";

describe("scoreLabel", () => {
  it("shows not enough data instead of 0%", () => {
    expect(scoreLabel({ status: "insufficient_data" })).toBe("not enough data");
  });
  it("shows a real 0% as 0%", () => {
    expect(scoreLabel({ status: "ok", percent: 0 })).toBe("0%");
  });
  it("rounds percentages", () => {
    expect(scoreLabel({ status: "ok", percent: 66.67 })).toBe("67%");
  });
});

describe("outcomeOf", () => {
  it("prefers the explicit outcome field", () => {
    expect(outcomeOf({ outcome: "correct", summary: "x (incorrect)" })).toBe("correct");
  });
  it("falls back to the summary text", () => {
    expect(outcomeOf({ summary: "Bean Co. cup → Trash (incorrect)" })).toBe("incorrect");
    expect(outcomeOf({ summary: "something else" })).toBeNull();
  });
});
