import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DemoSiteSchema, DisposalEventSchema, type DisposalEvent } from "../src/index.js";

// The fixtures teach I and J how core should behave, so they must follow the README's own rules:
// §6 attribution and the fullness formula, under the demo profile.
const read = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const site = DemoSiteSchema.parse(JSON.parse(read("demo-site.json")));
const demo = site.config_profiles.demo;
const catalog = new Map(site.catalog.map((i) => [i.catalog_item_id, i]));
const events: DisposalEvent[] = read("synthetic-events.jsonl")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => DisposalEventSchema.parse(JSON.parse(l)));
const sample = JSON.parse(read("feed-sample.json"));

const identified = (e: { item: DisposalEvent["item"] }) =>
  e.item.catalog_item_id !== null && (e.item.confidence ?? 0) >= demo.item_confidence_threshold
    ? e.item.catalog_item_id
    : null;

/** contracts/README.md §6, as core would apply it. */
function attribution(e: Pick<DisposalEvent, "item" | "business">) {
  const id = identified(e);
  if (id === null) return "unassessable";
  if (catalog.get(id)?.business_id) return "catalog";
  if (e.business.business_id && (e.business.confidence ?? 0) >= demo.business_confidence_threshold) return "event";
  if (e.business.business_id) return "review";
  return "unattributed";
}

describe("synthetic events follow §6", () => {
  it("send an item id whenever there is a candidate", () => {
    for (const e of events) if (e.item.candidates.length > 0) expect(e.item.catalog_item_id, e.event_id).not.toBeNull();
  });

  it("cover review, unassessable-with-candidate, and unassessable-without", () => {
    const kinds = events.map(attribution);
    expect(kinds).toContain("review");
    expect(events.some((e) => attribution(e) === "unassessable" && e.item.candidates.length > 0)).toBe(true);
    expect(events.some((e) => attribution(e) === "unassessable" && e.item.candidates.length === 0)).toBe(true);
  });
});

describe("bin filling (scenario 3)", () => {
  it("trash crosses the demo threshold at the first clamshell, not before", () => {
    const trash = site.bins.find((b) => b.type === "trash")!;
    let volume = trash.initial_volume_l;
    let crossedAt: string | null = null;
    for (const e of events.filter((e) => e.bin_id === trash.bin_id)) {
      const id = identified(e);
      volume += id ? catalog.get(id)!.volume_ml / 1000 : 0;
      if (crossedAt === null && volume / trash.capacity_l >= demo.fullness_alert_threshold!) crossedAt = id;
    }
    expect(crossedAt).toBe("item_tacostop_box");
  });
});

describe("feed-sample.json follows the rules", () => {
  it("opens the cup alert right after the minimum number of assessed cup events", () => {
    let assessed = 0;
    for (const f of sample.feed.items) {
      if (f.type === "disposal" && f.ref.item_id === "item_beanco_cup") assessed++;
      if (f.type === "alert_opened" && f.ref.item_id === "item_beanco_cup") break;
    }
    expect(assessed).toBe(demo.min_assessed_events);
  });

  it("queues only identified items with weak business evidence for review", () => {
    expect(sample.reviews.length).toBeGreaterThan(0);
    for (const r of sample.reviews) expect(attribution(r)).toBe("review");
  });

  it("reports fullness consistent with volume and capacity", () => {
    for (const b of sample.bins) expect(b.estimated_fullness).toBeCloseTo(b.estimated_volume_l / b.capacity_l, 3);
  });
});
