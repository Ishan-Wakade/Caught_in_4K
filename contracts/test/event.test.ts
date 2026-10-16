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
