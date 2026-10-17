import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { CORE_STATE_MIGRATION } from "../src/migration.js";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PostgresRepository, type SqlPool } from "../src/repository.js";
import { initialState } from "../src/model.js";
import { configFor } from "../src/config.js";
import { testSeed } from "./fixtures.js";

test("Postgres migration, persistence across repository instances and transaction rollback", async () => {
  const db = new PGlite();
  // PGlite executes real PostgreSQL SQL in-process. This checks storage behavior,
  // not network/Neon configuration or cross-client lock contention.
  const pool: SqlPool = { async connect() { return { async query(sql, values) { return db.query(sql, values); }, release() {} }; } };
  const seed = initialState(testSeed, configFor("demo"));
  try {
    const first = new PostgresRepository(pool, testSeed.site.site_id, seed); await first.migrate();
    await first.transaction(s => { s.sequence = 42; });
    const restarted = new PostgresRepository(pool, testSeed.site.site_id, seed);
    assert.equal(await restarted.transaction(s => s.sequence), 42);
    await assert.rejects(first.transaction(s => { s.sequence = 999; throw new Error("abort"); }), /abort/);
    assert.equal(await restarted.transaction(s => s.sequence), 42);
    const rows = await db.query<{ revision: number }>("SELECT revision FROM recyclone_core_state");
    assert.equal(Number(rows.rows[0].revision), 3);
  } finally { await db.close(); }
});

test("bundled migration matches the standalone SQL migration", async () => {
  const sql = await readFile(new URL("../migrations/001_core_state.sql", import.meta.url), "utf8");
  assert.equal(CORE_STATE_MIGRATION, sql);
});
