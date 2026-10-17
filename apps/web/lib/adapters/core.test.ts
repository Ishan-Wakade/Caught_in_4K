import { describe, expect, it } from "vitest";
import * as core from "./core";
import sample from "./__fixtures__/core-responses.json";

// Responses captured from I's core (contract DTOs) running in demo memory mode on E's
// demo-site.json with E's 11 synthetic events, 2026-10-16. Refresh if the contract changes.
const s = sample as unknown as Record<string, never>;

describe("core adapter (contract DTOs)", () => {
  it("parses outcomes, the labeled-input marker and mocked flags from feed summaries", () => {
    const f = core.adaptFeed(s.feed, null);
    const disposals = f.items.filter((i) => i.type === "disposal");
    expect(disposals.length).toBeGreaterThan(0);
    expect(disposals.every((d) => d.outcome)).toBe(true);
    expect(disposals.every((d) => d.source_mode === "labeled")).toBe(true);
    expect(f.items.find((i) => i.type === "illustration_ready")?.mocked).toBe(true);
    expect(f.cursor).toBe((sample.feed as { next_cursor: string }).next_cursor);
    expect(f.demo).toBe(true);
  });

  it("keeps bin estimates and notes the assumed starting contents", () => {
    const bins = core.adaptBins(s.bins).bins;
    const trash = bins.find((b) => b.type === "trash")!;
    expect(trash.estimated_fullness).toBeGreaterThan(0.8);
    expect(trash.assumed_initial_l).toBe(93.5);
    expect(trash.observed_total).toBe(7);
    expect(trash.illustration?.mocked).toBe(true);
    expect(trash.station_name).toBe("Patio");
  });

  it("keeps insufficient data distinct from 0%", () => {
    const items = core.adaptItems(s.items).items;
    expect(items.find((i) => i.catalog_item_id === "item_chip_bag")!.score).toEqual({ status: "insufficient_data" });
    expect(items.find((i) => i.catalog_item_id === "item_tacostop_box")!.score).toEqual({ status: "ok", percent: 0 });
    expect(items.find((i) => i.catalog_item_id === "item_beanco_cup")!.business_name).toBe("Bean Co.");
  });

  it("names contacts and derives a readable trigger", () => {
    const { alerts } = core.adaptAlerts(s.alerts);
    const bean = alerts.find((a) => a.item_id === "item_beanco_cup")!;
    expect(bean.contact.name).toBe("Bean Co. manager");
    expect(bean.state).toBe("sent");
    expect(bean.trigger).toMatch(/^Bean Co\. clear cold cup: 33\.3% correctly sorted across 3 assessed disposals/);
    expect(alerts.find((a) => a.kind === "emptying")!.contact.name).toBe("Area manager");
  });

  it("maps catalog destination both ways", () => {
    const [first] = core.adaptCatalog(s.catalog).items;
    expect(first.correct_destination).toBeDefined();
    expect(core.toContractCatalog(first)).toEqual((sample.catalog as unknown[])[0]);
  });

  it("turns review items into business candidates with names", () => {
    const catalog = core.adaptCatalog(s.catalog).items;
    const [r] = core.adaptReviews(s.reviews, catalog).reviews;
    expect(r.status).toBe("pending");
    expect(r.business_candidates[0]).toMatchObject({ business_id: "biz_beanco", name: "Bean Co." });
  });
});
