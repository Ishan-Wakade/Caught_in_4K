import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DemoSiteSchema, checkSiteIntegrity, type DemoSite } from "../src/index.js";

const raw = JSON.parse(readFileSync(new URL("../fixtures/demo-site.json", import.meta.url), "utf8"));

describe("demo-site.json", () => {
  it("parses", () => {
    expect(() => DemoSiteSchema.parse(raw)).not.toThrow();
  });

  it("integrity is clean", () => {
    expect(checkSiteIntegrity(DemoSiteSchema.parse(raw))).toEqual([]);
  });

  it("has every bin type and a demo profile with provisional values", () => {
    const site = DemoSiteSchema.parse(raw);
    expect(new Set(site.bins.map((b) => b.type))).toEqual(new Set(["trash", "recycling", "compost"]));
    expect(site.config_profiles.demo.provisional.length).toBeGreaterThan(0);
  });
});

describe("checkSiteIntegrity", () => {
  const site = (): DemoSite => structuredClone(DemoSiteSchema.parse(raw));

  it("catches a dangling camera reference", () => {
    const s = site();
    s.bins[0]!.camera_id = "cam_missing";
    expect(checkSiteIntegrity(s).join("\n")).toContain("cam_missing");
  });

  it("catches duplicate IDs", () => {
    const s = site();
    s.catalog.push(structuredClone(s.catalog[0]!));
    expect(checkSiteIntegrity(s).join("\n")).toContain(s.catalog[0]!.catalog_item_id);
  });

  it("catches a region for an unknown bin", () => {
    const s = site();
    s.cameras[0]!.bin_regions.push({ bin_id: "bin_ghost", x: 0, y: 0, w: 0.1, h: 0.1 });
    expect(checkSiteIntegrity(s).join("\n")).toContain("bin_ghost");
  });

  it("catches an unknown catalog business", () => {
    const s = site();
    s.catalog[0]!.business_id = "biz_ghost";
    expect(checkSiteIntegrity(s).join("\n")).toContain("biz_ghost");
  });

  it("catches an unknown contact business", () => {
    const s = site();
    s.contacts[0]!.business_id = "biz_nowhere";
    expect(checkSiteIntegrity(s).join("\n")).toContain("biz_nowhere");
  });

  it("catches a bin not covered by its own camera", () => {
    const s = site();
    const bin = s.bins[0]!;
    for (const cam of s.cameras) cam.bin_regions = cam.bin_regions.filter((r) => r.bin_id !== bin.bin_id);
    expect(checkSiteIntegrity(s).join("\n")).toContain(bin.bin_id);
  });

  it("rejects a region outside the frame", () => {
    const s = structuredClone(raw);
    s.cameras[0].bin_regions[0].w = 1.5;
    expect(() => DemoSiteSchema.parse(s)).toThrow();
  });
});
