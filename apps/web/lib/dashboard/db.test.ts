import { describe, expect, it } from "vitest";
import { Pool } from "pg";
import { slugify, listApproved, listPending, recordSighting, decide } from "./db";

describe("slugify", () => {
  it("normalizes a name into a stable id", () => {
    expect(slugify("Plastic Cup Lid")).toBe("plastic_cup_lid");
    expect(slugify("  sauce   packet! ")).toBe("sauce_packet");
  });
  it("never returns an empty string", () => {
    expect(slugify("!!!")).toBe("item");
  });
});

// Network Postgres: skipped unless a real test database is configured, same convention as
// packages/core/test/postgres-live.test.ts's CORE_TEST_DATABASE_URL.
describe.skipIf(!process.env.DASHBOARD_TEST_DATABASE_URL)("dashboard catalog database (network Postgres)", () => {
  it("seeds the known catalog as approved, logs a new sighting as pending, and lets a manager decide it", async () => {
    process.env.DATABASE_URL = process.env.DASHBOARD_TEST_DATABASE_URL;
    const pool = new Pool({ connectionString: process.env.DASHBOARD_TEST_DATABASE_URL });
    try {
      await pool.query("DROP TABLE IF EXISTS dashboard_catalog_items");

      const approved = await listApproved();
      expect(approved.length).toBeGreaterThan(0);
      expect(approved.every((r) => r.status === "approved")).toBe(true);

      await recordSighting({ id: "test_item", name: "test item", destination: "trash", basis: "test basis", confidence: 0.6 });
      let pending = await listPending();
      expect(pending.find((r) => r.id === "test_item")).toMatchObject({ name: "test item", status: "pending", times_seen: 1 });

      await recordSighting({ id: "test_item", name: "test item", destination: "trash", basis: "test basis", confidence: 0.6 });
      pending = await listPending();
      expect(pending.find((r) => r.id === "test_item")?.times_seen).toBe(2);

      const decided = await decide("test_item", "approved");
      expect(decided?.status).toBe("approved");
      expect((await listPending()).find((r) => r.id === "test_item")).toBeUndefined();
      expect((await listApproved()).find((r) => r.id === "test_item")).toBeDefined();

      expect(await decide("not_a_real_id", "approved")).toBeNull();
    } finally {
      await pool.query("DROP TABLE IF EXISTS dashboard_catalog_items");
      await pool.end();
    }
  });
});
