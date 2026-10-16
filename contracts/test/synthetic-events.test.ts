import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DemoSiteSchema, DisposalEventSchema, type DisposalEvent } from "../src/index.js";
import { makeEventId } from "../src/event-id.js";

const read = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const site = DemoSiteSchema.parse(JSON.parse(read("demo-site.json")));
const lines = read("synthetic-events.jsonl").split("\n").filter((l) => l.trim() !== "");
const events: DisposalEvent[] = lines.map((l) => DisposalEventSchema.parse(JSON.parse(l)));

describe("synthetic-events.jsonl", () => {
  it("every event_id is derived from its source and bin", () => {
    for (const e of events) {
      expect(e.event_id).toBe(makeEventId(e.source.camera_id, e.source.clip_id, e.source.track_id, e.bin_id));
    }
  });

  it("is labeled synthetic data", () => {
    for (const e of events) {
      expect(e.source.mode).toBe("labeled");
      expect(e.source.clip_id).toBe("clip_synthetic_v1");
    }
  });

  it("references only demo-site IDs", () => {
    const bins = new Set(site.bins.map((b) => b.bin_id));
    const items = new Set(site.catalog.map((i) => i.catalog_item_id));
    const businesses = new Set(site.businesses.map((b) => b.business_id));
    for (const e of events) {
      expect(bins).toContain(e.bin_id);
      if (e.item.catalog_item_id) expect(items).toContain(e.item.catalog_item_id);
      if (e.business.business_id) expect(businesses).toContain(e.business.business_id);
    }
  });

  it("covers the demo scenarios", () => {
    const binType = new Map(site.bins.map((b) => [b.bin_id, b.type]));
    const dest = new Map(site.catalog.map((i) => [i.catalog_item_id, i.destination]));
    const correct = events.filter((e) => e.item.catalog_item_id && dest.get(e.item.catalog_item_id) === binType.get(e.bin_id));
    const wrongByItem = new Map<string, number>();
    for (const e of events) {
      const id = e.item.catalog_item_id;
      if (id && dest.get(id) !== binType.get(e.bin_id)) wrongByItem.set(id, (wrongByItem.get(id) ?? 0) + 1);
    }
    expect(correct.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(0, ...wrongByItem.values())).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.item.catalog_item_id === null)).toBe(true);
    expect(events.some((e) => e.business.business_id === null && e.item.candidates.length > 0)).toBe(true);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(events.length);
  });
});
