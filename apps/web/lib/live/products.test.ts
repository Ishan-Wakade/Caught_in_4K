import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import products from "./products.json";

const rules = readFileSync(new URL("../../../../worker/rules/cambridge-ma-2022.md", import.meta.url), "utf8");

describe("products.json (the ~110 extra product types Claude can pick)", () => {
  it("has unique ids and a valid bin for every product", () => {
    const ids = products.products.map((p) => p[0]);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of products.products) expect(["recycle", "compost", "trash", "none", "jev"]).toContain(p[2]);
  });
  it("cites a rule for every decided bin, and the cited rule's words are in the city's rules file", () => {
    for (const [id, , bin, rule] of products.products) {
      if (bin === "jev") continue;
      const text = products.rules[rule as keyof typeof products.rules];
      expect(text, id as string).toBeTruthy();
      expect(rules, `${id}: ${text}`).toContain(text as string);
    }
  });
});
