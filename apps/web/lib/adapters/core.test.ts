import { describe, expect, it } from "vitest";
import * as core from "./core";
import sample from "./__fixtures__/core-responses.json";

// Responses captured from I's core running in demo memory mode with E's synthetic events
// (2026-10-16). If core's response shapes change, refresh this file and these tests.
const s = sample as unknown as Record<string, never>;

describe("core adapter", () => {
  it("parses disposal outcomes from feed summaries and keeps the cursor", () => {
    const f = core.adaptFeed(s.feed, null);
    const disposals = f.items.filter((i) => i.type === "disposal");
    expect(disposals.length).toBeGreaterThan(0);
    expect(disposals.every((d) => d.outcome)).toBe(true);
    expect(f.cursor).toBe((sample.feed as { cursor: string }).cursor);
    expect(f.demo).toBe(true);
  });

  it("converts bins to litres and links illustrations to their snapshot", () => {
    const catalog = core.adaptCatalog(s.catalog).items;
    const bins = core.adaptBins(s.bins, catalog).bins;
    const trash = bins.find((b) => b.type === "trash")!;
    expect(trash.estimated_volume_l).toBeCloseTo(4.6);
    expect(trash.observed_counts.find((c) => c.name === "Bean Co. clear cold cup")?.catalog_item_id).toBe("item_beanco_cup");
    expect(trash.illustration?.mocked).toBe(true);
    expect(trash.illustration?.snapshot_id).toMatch(/^image_/);
    expect(trash.station_name).toBe("Patio");
  });

  it("keeps insufficient data distinct from 0%", () => {
    const items = core.adaptItems(s.items).items;
    const box = items.find((i) => i.catalog_item_id === "item_tacostop_box")!;
    expect(box.score).toEqual({ status: "ok", percent: 0 });
    const chips = items.find((i) => i.catalog_item_id === "item_chip_bag")!;
    expect(chips.score).toEqual({ status: "insufficient_data" });
    expect(box.business_name).toBe("Taco Stop");
  });

  it("names contacts, strips core's [alert_id] prefix and labels the first message", () => {
    const { alerts, messenger_mocked } = core.adaptAlerts(s.alerts);
    expect(messenger_mocked).toBe(true);
    const bean = alerts.find((a) => a.item_id === "item_beanco_cup")!;
    expect(bean.contact.name).toBe("Bean Co. manager");
    expect(bean.state).toBe("sent");
    expect(bean.trigger).toMatch(/^Bean Co\. clear cold cup: 50\.0% correctly sorted/);
    expect(bean.messages[0].body.startsWith("[")).toBe(false);
    expect(bean.messages[0].kind).toBe("recommendation");
  });

  it("turns core's review records into candidates with business names", () => {
    const catalog = core.adaptCatalog(s.catalog).items;
    const [r] = core.adaptReviews(s.reviews, catalog).reviews;
    expect(r.status).toBe("pending");
    expect(r.item_name).toBe("Clear cold cup (unbranded)");
    expect(r.business_candidates[0]).toMatchObject({ business_id: "biz_beanco", name: "Bean Co." });
  });
});
