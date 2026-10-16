import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const srcDir = new URL("../src/", import.meta.url);

describe("browser safety", () => {
  it("index has no node: imports", () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && f !== "event-id.ts");
    expect(files).toContain("index.ts");
    for (const f of files) {
      const text = readFileSync(new URL(f, srcDir), "utf8");
      expect(text, f).not.toMatch(/from ["']node:/);
    }
  });
});
