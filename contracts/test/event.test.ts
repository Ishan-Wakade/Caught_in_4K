import { describe, expect, it } from "vitest";
import { DisposalEventSchema } from "../src/index.js";
import { validEvent, withPatch } from "./valid-event.js";

describe("DisposalEventSchema", () => {
  it("accepts the README example", () => {
    expect(() => DisposalEventSchema.parse(validEvent)).not.toThrow();
  });

  it("accepts unknown item and business", () => {
    const e = withPatch((e) => {
      e.item = { catalog_item_id: null, label: null, confidence: null, candidates: [] };
      e.business = { business_id: null, confidence: null, basis: [] };
    });
    expect(() => DisposalEventSchema.parse(e)).not.toThrow();
  });

  const proposed = {
    generic_type_id: "gen_textile_mask", name: "disposable face mask", material: "textile", form: "mask",
    condition: "clean", hazardous: false, suggested_destination: "trash", suggestion_confidence: 0.82,
    rule_source: "cambridge-ma-2022",
  } as const;

  it("accepts an unknown item with a proposed generic type (v1.1), and events without the field", () => {
    const e = withPatch((e) => {
      e.item = { catalog_item_id: null, label: "disposable face mask", confidence: null, candidates: [], proposed_type: { ...proposed } };
    });
    expect(() => DisposalEventSchema.parse(e)).not.toThrow();
    expect(() => DisposalEventSchema.parse(withPatch((e) => (e.item.proposed_type = null)))).not.toThrow();
  });

  it.each([
    ["generic_type_id", "face mask"],
    ["material", "cloth"],
    ["suggested_destination", "landfill"],
    ["suggestion_confidence", 1.5],
  ])("rejects a proposed type with bad %s", (field, value) => {
    const e = withPatch((e) => {
      e.item = { catalog_item_id: null, label: null, confidence: null, candidates: [], proposed_type: { ...proposed, [field]: value } as never };
    });
    expect(() => DisposalEventSchema.parse(e)).toThrow();
  });

  it("rejects timestamp without timezone", () => {
    const e = withPatch((e) => (e.occurred_at = "2026-10-17T15:02:41"));
    expect(() => DisposalEventSchema.parse(e)).toThrow();
  });

  it.each([1.2, -0.1, Number.NaN])("rejects out-of-range confidence %s", (value) => {
    const e = withPatch((e) => (e.destination_confidence = value));
    expect(() => DisposalEventSchema.parse(e)).toThrow();
  });

  it("rejects bad event_id", () => {
    const e = withPatch((e) => (e.event_id = "evt_XYZ"));
    expect(() => DisposalEventSchema.parse(e)).toThrow();
  });

  it("rejects unknown mode", () => {
    const e = withPatch((e) => (e.source.mode = "replay"));
    expect(() => DisposalEventSchema.parse(e)).toThrow();
  });

  describe("cross-field rules", () => {
    it("rejects a recorded event without clip_offset_s", () => {
      const e = withPatch((e) => (e.clip_offset_s = null));
      expect(() => DisposalEventSchema.parse(e)).toThrow(/clip_offset_s/);
    });

    it("rejects a live event with clip_offset_s", () => {
      const e = withPatch((e) => (e.source.mode = "live"));
      expect(() => DisposalEventSchema.parse(e)).toThrow(/clip_offset_s/);
    });

    it("accepts a live event without clip_offset_s", () => {
      const e = withPatch((e) => {
        e.source.mode = "live";
        e.clip_offset_s = null;
      });
      expect(() => DisposalEventSchema.parse(e)).not.toThrow();
    });

    it("accepts unsorted candidates", () => {
      const e = withPatch((e) => e.item.candidates.reverse());
      expect(() => DisposalEventSchema.parse(e)).not.toThrow();
    });
  });
});
