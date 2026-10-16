import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { disposalEventJsonSchema } from "../scripts/json-schema.js";

describe("disposal-event.schema.json", () => {
  it("schema file is up to date (run: pnpm --filter @recyclone/contracts gen:schema)", () => {
    const committed = readFileSync(new URL("../disposal-event.schema.json", import.meta.url), "utf8");
    expect(committed).toBe(JSON.stringify(disposalEventJsonSchema(), null, 2) + "\n");
  });
});
