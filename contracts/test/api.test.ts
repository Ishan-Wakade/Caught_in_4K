import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AlertSummarySchema,
  BinSummarySchema,
  CatalogItemSchema,
  DemoSiteSchema,
  FeedResponseSchema,
  ItemDetailSchema,
  ItemSummarySchema,
  ReviewItemSchema,
} from "../src/index.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const sample = load("feed-sample.json");
const site = DemoSiteSchema.parse(load("demo-site.json"));

describe("feed-sample.json", () => {
  it("has every response", () => {
    expect(Object.keys(sample).sort()).toEqual(
      ["alerts", "bins", "catalog", "feed", "item_detail", "items", "reviews"].sort(),
    );
  });

  it("each response parses", () => {
    FeedResponseSchema.parse(sample.feed);
    BinSummarySchema.array().parse(sample.bins);
    ItemSummarySchema.array().parse(sample.items);
    ItemDetailSchema.parse(sample.item_detail);
    AlertSummarySchema.array().parse(sample.alerts);
    ReviewItemSchema.array().parse(sample.reviews);
    CatalogItemSchema.array().parse(sample.catalog);
  });

  it("feed cursors increase", () => {
    const cursors: string[] = sample.feed.items.map((i: { cursor: string }) => i.cursor);
    for (let k = 1; k < cursors.length; k++) expect(cursors[k]! > cursors[k - 1]!).toBe(true);
  });

  it("tells the whole demo story", () => {
    const types = new Set(sample.feed.items.map((i: { type: string }) => i.type));
    for (const t of ["disposal", "alert_opened", "message_sent", "reply_received", "intervention_recorded", "bin_emptied", "review_queued"]) {
      expect(types, t).toContain(t);
    }
  });

  it("uses only IDs from demo-site.json", () => {
    const bins = new Set(site.bins.map((b) => b.bin_id));
    const items = new Set(site.catalog.map((i) => i.catalog_item_id));
    for (const b of sample.bins) expect(bins).toContain(b.bin_id);
    for (const i of sample.items) expect(items).toContain(i.catalog_item_id);
  });

  it("covers empty states", () => {
    expect(sample.bins.some((b: { illustration: unknown }) => b.illustration === null)).toBe(true);
    expect(sample.items.some((i: { status: string }) => i.status === "insufficient_data")).toBe(true);
  });
});

describe("ItemSummarySchema", () => {
  const base = {
    catalog_item_id: "item_napkin", name: "Paper napkin", business_id: null, destination: "compost",
    correct_sorting_pct: null, status: "insufficient_data", assessed_count: 0, by_station: [],
  };

  it("accepts insufficient data with null pct", () => {
    expect(() => ItemSummarySchema.parse(base)).not.toThrow();
  });

  it("accepts insufficient evidence that still has a pct", () => {
    expect(() => ItemSummarySchema.parse({ ...base, correct_sorting_pct: 100, assessed_count: 1 })).not.toThrow();
  });

  it("rejects a scored status with null pct", () => {
    expect(() => ItemSummarySchema.parse({ ...base, status: "ok" })).toThrow();
  });
});
