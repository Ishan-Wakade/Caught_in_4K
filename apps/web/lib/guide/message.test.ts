import { describe, expect, it } from "vitest";
import { defaultTrash, fromCatalog, fromSuggestion, spoken, validateMessage } from "./message";
import { RULES_SOURCE } from "./rules";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("spoken message (same rules as worker/recyclone_worker/guide_message.py)", () => {
  it("catalog items read like the team example", () => {
    expect(fromCatalog("item_generic_can")).toEqual({ bin: "recycle", explanation: "aluminum can, placed in recycling" });
    expect(spoken({ bin: "recycle", explanation: "aluminum can, placed in recycling" })).toBe("Recycle. aluminum can, placed in recycling");
  });
  it("only compost / trash / recycle / none, explanation at most 8 words", () => {
    expect(() => validateMessage({ bin: "landfill" as never, explanation: "x" })).toThrow();
    expect(() => validateMessage({ bin: "trash", explanation: "one two three four five six seven eight nine" })).toThrow();
  });
  it("dangerous items are always none with where to take them, whatever Jev said", () => {
    for (const dest of ["recycling", "compost", "trash", "special"]) {
      const m = fromSuggestion({ name: "battery", form: "battery", hazardous: true, suggested_destination: dest, suggestion_confidence: 0.9 });
      expect(m).toEqual({ bin: "none", explanation: "battery is dangerous to place in any of these bins. Place it in the Recycle Center instead" });
    }
    expect(fromSuggestion({ name: "lithium battery", form: "", hazardous: false, suggested_destination: "trash", suggestion_confidence: 0.9 }).bin).toBe("none");
    expect(fromSuggestion({ name: "aluminum foil", form: "foil", hazardous: false, suggested_destination: "recycling", suggestion_confidence: 0.9 }).bin).toBe("recycle");
  });
  it("trash below 50% confidence, and for non-dangerous special items", () => {
    expect(fromSuggestion({ name: "paper card", form: "card", hazardous: false, suggested_destination: "recycling", suggestion_confidence: 0.4 }).bin).toBe("trash");
    expect(fromSuggestion({ name: "face mask", form: "mask", hazardous: false, suggested_destination: "special", suggestion_confidence: 0.96 }).bin).toBe("trash");
    expect(defaultTrash(null)).toEqual({ bin: "trash", explanation: "not sure what this is, placed in trash" });
  });
  it("the bin table and rules text are the worker's, unchanged", () => {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const table = JSON.parse(readFileSync(root + "worker/rules/cambridge-ma-2022.bins.json", "utf8")).items;
    for (const id of Object.keys(table)) expect(fromCatalog(id).bin).toBe(table[id].bin);
    expect(RULES_SOURCE).toBe("cambridge-ma-2022");
  });
});

describe("rules text", () => {
  it("is exactly worker/rules/cambridge-ma-2022.md", async () => {
    const { LOCAL_RULES } = await import("./rules");
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    expect(LOCAL_RULES).toBe(readFileSync(root + "worker/rules/cambridge-ma-2022.md", "utf8"));
  });
});

describe("electronics by any common name go to the Recycle Center (17 Oct: 'smartphone' fell through to trash)", () => {
  it.each(["smartphone", "black smartphone", "iPhone", "cell phone", "tablet", "wireless earbuds"])("%s", (name) => {
    expect(fromSuggestion({ name, hazardous: false }).explanation).toMatch(/Recycle Center/);
  });
});
