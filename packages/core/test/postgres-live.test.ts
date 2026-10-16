import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresRepository } from "../src/repository.js";
import { initialState } from "../src/model.js";
import { configFor } from "../src/config.js";
import { createCore } from "../src/core.js";
import { createLocalMocks } from "../src/mocks.js";
import { testSeed, event } from "./fixtures.js";

test("network Postgres: concurrent idempotent intake, restart persistence, row locking and rollback", { skip: !process.env.CORE_TEST_DATABASE_URL }, async () => {
  const pool = new Pool({ connectionString: process.env.CORE_TEST_DATABASE_URL, max: 5 });
  const seed = structuredClone(testSeed); seed.site.site_id = `test_${randomUUID()}`;
  const config = configFor("demo", { minAssessedEvents: 99, fullnessThreshold: null });
  const clock = () => new Date("2026-10-17T12:00:00Z");
  const state = initialState(seed, config);
  const repository = new PostgresRepository(pool, seed.site.site_id, state);
  try {
    await repository.migrate();
    const create = (repo: PostgresRepository) => createCore({ seed, config, repository: repo, ...createLocalMocks(clock), clock });
    const core = create(repository);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => core.ingest(event(`concurrent_${i % 2}`))));
    assert.equal(results.filter(r => (r as { status: string }).status === "created").length, 2);
    const restarted = create(new PostgresRepository(pool, seed.site.site_id, state));
    assert.equal((await restarted.getBins())[0]!.observed_count, 2);
    assert.equal((await restarted.getItem("cup")).assessed_count, 2);
    assert.equal((await restarted.getFeed()).items.filter(f => f.type === "disposal").length, 2);
    await assert.rejects(repository.transaction(s => { s.events = {}; throw new Error("rollback check"); }), /rollback check/);
    assert.equal((await restarted.getItem("cup")).assessed_count, 2);
  } finally {
    await pool.query("DELETE FROM recyclone_core_state WHERE site_id = $1", [seed.site.site_id]);
    await pool.end();
  }
});
