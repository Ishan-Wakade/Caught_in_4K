import { test } from "node:test";
import assert from "node:assert/strict";
import { createEventValidator, validateSeed } from "../src/validation.js";
import { event, testSeed } from "./fixtures.js";
const parser = createEventValidator();
test("input validator uses E's shared schema, including nullable unknown confidences", () => {
  assert.equal(parser(event("e1")).event_id, event("e1").event_id);
  assert.throws(() => parser({}), /Invalid disposal event/);
  assert.throws(() => parser(event("e1", { destination_confidence: -1 })), /Invalid disposal event/);
  assert.throws(() => parser(event("e1", { occurred_at: "nonsense" })), /Invalid disposal event/);
  assert.throws(() => parser(event("e1", { occurred_at: "2026-10-17T12:00:00+02:00" })), /UTC/);
  assert.equal(parser(event("unknown", { item: { catalog_item_id: null, label: null, confidence: null, candidates: [] } })).item.confidence, null);
  assert.throws(() => parser(event("e1", { source: { camera_id: "camera", clip_id: "clip", track_id: 1, mode: "live" } })), /clip_offset_s/);
});
test("shared site validation rejects zero capacities, duplicate IDs, broken references and station mismatch", () => {
  assert.equal(validateSeed(testSeed).site.site_id, "site_test");
  const zero = structuredClone(testSeed); zero.bins[0].capacity_l = 0; assert.throws(() => validateSeed(zero), /capacity/);
  const duplicate = structuredClone(testSeed); duplicate.bins.push(duplicate.bins[0]); assert.throws(() => validateSeed(duplicate), /duplicate/);
  const broken = structuredClone(testSeed); broken.bins[0].emptying_contact_id = "missing"; assert.throws(() => validateSeed(broken), /unknown/);
  const mismatch = structuredClone(testSeed); mismatch.cameras[0].station_id = "side"; assert.throws(() => validateSeed(mismatch), /station mismatch/);
});
