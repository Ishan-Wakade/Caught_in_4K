import { z } from "zod";
import { DisposalEventSchema } from "../src/event.js";

const modeIs = (mode: string) => ({ properties: { source: { properties: { mode: { const: mode } } } } });

/**
 * The cross-field rules from checkEventInvariants, restated in JSON Schema so the Python worker
 * enforces exactly what core enforces. fixtures/parity-cases.json checks both sides agree.
 */
const crossFieldRules = [
  { if: modeIs("recorded"), then: { properties: { clip_offset_s: { type: "number" } } } },
  { if: modeIs("live"), then: { properties: { clip_offset_s: { type: "null" } } } },
];

/** JSON Schema (draft 2020-12) for DisposalEvent, generated from the Zod source of truth. */
export function disposalEventJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(DisposalEventSchema, { target: "draft-2020-12" }),
    allOf: crossFieldRules,
    $id: "https://github.com/Ishan-Wakade/Recyclone/contracts/disposal-event.schema.json",
    title: "DisposalEvent",
    description:
      "One item that entered one bin (contracts/README.md §1). Generated from contracts/src/event.ts — do not edit by hand. " +
      "allOf restates the cross-field rules in checkEventInvariants. Serialize with allow_nan=False: NaN/Infinity are not JSON.",
  };
}
