import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ANNOUNCEMENTS, CAMERA_OFFLINE_SINCE, CATALOG, NOW, PROPOSED, buckets, slice, windowFor } from "./sample";

const BINS = JSON.parse(readFileSync(new URL("../../../../worker/rules/cambridge-ma-2022.bins.json", import.meta.url), "utf8")).items as Record<
  string,
  { bin: string; name: string }
>;

describe("dashboard sample data", () => {
  it("uses the worker's standard bin and name for every catalog item", () => {
    for (const c of CATALOG) expect({ id: c.id, bin: BINS[c.id]?.bin, name: BINS[c.id]?.name }).toEqual({ id: c.id, bin: c.dest, name: c.name });
  });

  it("never sends an unsure answer anywhere but trash, and only dangerous items to special disposal", () => {
    for (const a of ANNOUNCEMENTS) {
      if (a.source === "unsure" || a.source === "late") expect(a.dest).toBe("trash");
      if (a.dest === "none") expect(PROPOSED.find((p) => p.name === a.item)?.suggested).toBe("none");
    }
  });

  it("has nothing after now or from a camera after it went offline", () => {
    for (const a of ANNOUNCEMENTS) {
      expect(a.at).toBeLessThanOrEqual(NOW);
      expect(a.at).toBeLessThan(CAMERA_OFFLINE_SINCE[a.camera] ?? Infinity);
    }
  });

  it("buckets add up to the slice", () => {
    for (const range of ["today", "7d", "30d"] as const) {
      const w = windowFor(range);
      const rows = slice("all", w.from, w.to);
      expect(buckets(rows, range).reduce((s, b) => s + b.total, 0)).toBe(rows.length);
    }
  });
});
