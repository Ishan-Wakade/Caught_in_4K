import { describe, expect, it } from "vitest";
import { MockBackend } from "./backend";
import { SCRIPT_LENGTH_S } from "./script";

function run(untilS: number, opts: { stepS?: number } = {}) {
  let t = 1_000_000;
  const b = new MockBackend(() => t);
  const start = t;
  const step = (opts.stepS ?? 1) * 1000;
  while (t - start <= untilS * 1000) {
    b.feed(null);
    t += step;
  }
  return { b, at: () => t };
}

describe("MockBackend scripted run", () => {
  it("covers every demo scenario's feed types", () => {
    const { b } = run(SCRIPT_LENGTH_S + 1);
    const types = new Set(b.feed(null).items.map((i) => i.type));
    for (const t of ["disposal", "alert_opened", "illustration_ready", "review_queued"]) {
      expect(types, t).toContain(t);
    }
  });

  it("is deterministic: two runs produce the same events", () => {
    const a = run(SCRIPT_LENGTH_S + 1).b.feed(null).items.map((i) => `${i.type}|${i.summary}`);
    const c = run(SCRIPT_LENGTH_S + 1).b.feed(null).items.map((i) => `${i.type}|${i.summary}`);
    expect(a).toEqual(c);
  });

  it("feed cursor returns only newer items", () => {
    const { b } = run(20);
    const all = b.feed(null);
    expect(all.items.length).toBeGreaterThan(2);
    const mid = all.items[1].cursor;
    expect(b.feed(mid).items.every((i) => i.cursor > mid)).toBe(true);
    expect(b.feed(all.cursor).items).toHaveLength(0);
  });

  it("recommendation fires at 33% after 3 assessed cup drops, to Bean Co.'s manager", () => {
    const { b } = run(24);
    const rec = b.alertsList().alerts.find((a) => a.kind === "recommendation")!;
    expect(rec.trigger).toMatch(/33% < 60%, 3 assessed/);
    expect(rec.contact.contact_id).toBe("ct_beanco_mgr");
    expect(rec.business_name).toBe("Bean Co.");
  });

  it("uncertain origin goes to review and alerts nobody about it", () => {
    const { b } = run(30);
    const r = b.reviews().reviews;
    expect(r).toHaveLength(1);
    expect(r[0].item.catalog_item_id).toBe("item_generic_cup");
    expect(b.alertsList().alerts.some((a) => a.item_id === "item_generic_cup")).toBe(false);
  });

  it("unknown item is unassessable and counted as unknown content", () => {
    const { b } = run(19);
    const unk = b.feed(null).items.find((i) => i.type === "disposal" && i.outcome === "unassessable");
    expect(unk).toBeDefined();
    expect(b.bins().bins.find((x) => x.bin_id === "bin_patio_compost")!.unknown_count).toBe(1);
  });

  it("emptying request goes to the bin's emptying contact and stays open as internal state", () => {
    const { b } = run(50);
    const trash = b.bins().bins.find((x) => x.type === "trash")!;
    expect(trash.estimated_fullness).toBeGreaterThanOrEqual(0.8);
    const alert = b.alertsList().alerts.find((a) => a.kind === "emptying")!;
    expect(alert.contact.contact_id).toBe("ct_area_mgr");
    expect(alert.state).toBe("sent");
  });

  it("items with no assessed events report insufficient data, not 0%", () => {
    const { b } = run(5);
    const bowl = b.items().items.find((i) => i.catalog_item_id === "item_greenbowl_bowl")!;
    expect(bowl.score).toEqual({ status: "insufficient_data" });
  });

  it("review assignment resolves the queued event", () => {
    const { b } = run(30);
    const r = b.reviews().reviews[0];
    b.decideReview(r.event_id, { action: "assign", business_id: "biz_beanco" });
    expect(b.reviews().reviews[0].status).toBe("resolved");
  });
});
