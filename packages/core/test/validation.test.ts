import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventValidator, validateSeed } from "../src/validation.js";
import { event, testSeed } from "./fixtures.js";
// Checks that core honors the injected schema, not a substitute for E's full schema.
const parser = createEventValidator({ type: "object", required: ["event_id", "source", "bin_id", "occurred_at", "item", "business", "destination_confidence"], properties: { event_id: { type: "string" }, occurred_at: { type: "string", format: "date-time" } } });
test("input validator uses the supplied schema and validates confidence/timestamp semantics", () => {
  assert.equal(parser(event("e1")).event_id, "e1");
  assert.throws(() => parser({}), /Invalid disposal event/);
  assert.throws(() => parser(event("e1", { destination_confidence: -1 })), /Confidence/);
  assert.throws(() => parser(event("e1", { occurred_at: "nonsense" })), /Invalid disposal event/);
  assert.throws(() => parser(event("e1", { occurred_at: "2026-10-17T12:00:00+02:00" })), /UTC/);
});
test("site validation rejects zero capacities, duplicate IDs, and broken contact references", () => {
  assert.equal(validateSeed(testSeed).site_id, "site_test");
  const zero = structuredClone(testSeed); zero.bins[0].capacity_l = 0; assert.throws(() => validateSeed(zero), /capacity/);
  const duplicate = structuredClone(testSeed); duplicate.bins.push(duplicate.bins[0]); assert.throws(() => validateSeed(duplicate), /duplicate/);
  const broken = structuredClone(testSeed); broken.businesses[0].manager_contact_id = "missing"; assert.throws(() => validateSeed(broken), /manager/);
});
