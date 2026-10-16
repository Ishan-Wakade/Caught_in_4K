import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DisposalEventSchema } from "../src/index.js";

// The Python worker validates with the JSON Schema and core validates with Zod. Any case where they
// disagree is an event the worker thinks is fine but core rejects (lost on stage), or the reverse.
// scripts/check_python.py runs the same cases against the JSON Schema.
type Case = { name: string; valid: boolean; event: unknown };
const cases: Case[] = JSON.parse(readFileSync(new URL("../fixtures/parity-cases.json", import.meta.url), "utf8"));

describe("Zod agrees with parity-cases.json", () => {
  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(DisposalEventSchema.safeParse(c.event).success).toBe(c.valid);
  });
});
