import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testSeed, event } from "./fixtures.js";
import { POST as ingest } from "../../../apps/web/app/api/events/route.js";
import { GET as feed } from "../../../apps/web/app/api/feed/route.js";
import { GET as bins } from "../../../apps/web/app/api/bins/route.js";
import { GET as items } from "../../../apps/web/app/api/items/route.js";
import { GET as item } from "../../../apps/web/app/api/items/[id]/route.js";
import { GET as reviews } from "../../../apps/web/app/api/reviews/route.js";
import { POST as review } from "../../../apps/web/app/api/reviews/[event_id]/route.js";
import { GET as alerts } from "../../../apps/web/app/api/alerts/route.js";
import { GET as catalog, POST as catalogPost } from "../../../apps/web/app/api/catalog/route.js";
import { POST as reset } from "../../../apps/web/app/api/demo/reset/route.js";

const req = (path: string, body: unknown, token = "worker_test") => new Request(`http://localhost/api/${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test("HTTP route flow: worker auth, intake, projections, review, catalog, reset and validation errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recyclone-api-test-"));
  const previous = { ...process.env };
  const shared = globalThis as typeof globalThis & { recycloneCore?: unknown };
  try {
    await writeFile(join(dir, "site.json"), JSON.stringify(testSeed));
    Object.assign(process.env, { CONFIG_PROFILE: "demo", CORE_STORAGE: "memory", CORE_SITE_CONFIG_PATH: join(dir, "site.json"), WORKER_INGEST_TOKEN: "worker_test", MESSENGER_MODE: "mock", ILLUSTRATOR_MODE: "mock" });
    delete process.env.MANAGER_API_TOKEN;
    const e = event("http1", { occurred_at: new Date().toISOString() });
    assert.equal((await ingest(req("events", e, "wrong"))).status, 401);
    assert.equal((await ingest(req("events", e))).status, 200);
    assert.equal((await (await ingest(req("events", e))).json()).status, "duplicate");
    assert.equal((await ingest(req("events", {}))).status, 400);
    assert.equal((await feed(new Request("http://localhost/api/feed?after=bad"))).status, 400);
    assert.ok((await (await feed(new Request("http://localhost/api/feed"))).json()).items.length > 0);
    assert.equal((await (await bins()).json()).length, 3);
    assert.equal((await (await items()).json()).length, 3);
    assert.equal((await item(new Request("http://localhost"), { params: Promise.resolve({ id: "missing" }) })).status, 404);
    assert.equal((await catalog()).status, 200); assert.equal((await alerts()).status, 200);
    const g = event("generic_http", { occurred_at: new Date().toISOString(), item: { catalog_item_id: "generic", label: "can", confidence: 1, candidates: [] }, business: { business_id: "biz_cafe", confidence: 0.1, basis: ["logo_text"] } });
    await ingest(req("events", g)); assert.equal((await (await reviews()).json()).length, 1);
    const context = { params: Promise.resolve({ event_id: g.event_id }) };
    assert.equal((await review(req("reviews/generic_http", {}), context)).status, 400);
    assert.equal((await review(req("reviews/generic_http", { business_id: "biz_cafe" }), context)).status, 200);
    process.env.MANAGER_API_TOKEN = "manager_test";
    assert.equal((await catalogPost(req("catalog", testSeed.catalog[0]))).status, 401);
    assert.equal((await catalogPost(req("catalog", testSeed.catalog[0], "manager_test"))).status, 200);
    assert.equal((await reset(req("demo/reset", {}, "manager_test"))).status, 200);
    assert.equal((await (await bins()).json())[0].observed_count, 0);
  } finally {
    delete shared.recycloneCore;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); await rm(dir, { recursive: true, force: true });
  }
});

test("API runtime loads E's demo fixture and survives a restart using network PostgreSQL", { skip: !process.env.CORE_TEST_DATABASE_URL }, async () => {
  const { randomUUID } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const { Pool } = await import("pg");
  const { BinSummarySchema, CatalogItemSchema, FeedResponseSchema } = await import("@recyclone/contracts");
  const { getCore } = await import("../../../apps/web/app/api/_core/runtime.js");
  const dir = await mkdtemp(join(tmpdir(), "recyclone-runtime-test-"));
  const previous = { ...process.env };
  const shared = globalThis as typeof globalThis & { recycloneCore?: ReturnType<typeof getCore> };
  const seed = JSON.parse(await readFile(new URL("../../../contracts/fixtures/demo-site.json", import.meta.url), "utf8"));
  seed.site.site_id = `test_${randomUUID()}`;
  const pool = new Pool({ connectionString: process.env.CORE_TEST_DATABASE_URL });
  try {
    await writeFile(join(dir, "site.json"), JSON.stringify(seed));
    Object.assign(process.env, { CONFIG_PROFILE: "demo", CORE_STORAGE: "postgres", CORE_SITE_CONFIG_PATH: join(dir, "site.json"), DATABASE_URL: process.env.CORE_TEST_DATABASE_URL, WORKER_INGEST_TOKEN: "worker_test", MESSENGER_MODE: "mock", ILLUSTRATOR_MODE: "mock" });
    const original = (await (await bins()).json()).map((b: unknown) => BinSummarySchema.parse(b));
    assert.equal(original.find((b: { type: string }) => b.type === "trash").estimated_volume_l, 93.5);
    const synthetic = JSON.parse((await readFile(new URL("../../../contracts/fixtures/synthetic-events.jsonl", import.meta.url), "utf8")).split("\n")[0]!);
    synthetic.occurred_at = new Date().toISOString();
    assert.equal((await (await ingest(req("events", synthetic))).json()).status, "created");
    await (await getCore()).close(); delete shared.recycloneCore;
    assert.equal((await (await ingest(req("events", synthetic))).json()).status, "duplicate");
    const persisted = (await (await bins()).json()).map((b: unknown) => BinSummarySchema.parse(b));
    assert.equal(persisted.find((b: { type: string }) => b.type === "recycling").observed_count, 1);
    const timeline = FeedResponseSchema.parse(await (await feed(new Request("http://localhost/api/feed"))).json());
    assert.equal(timeline.items.filter(f => f.type === "disposal").length, 1);
    for (const c of await (await catalog()).json()) CatalogItemSchema.parse(c);
    assert.equal((await (await reviews()).json()).length, 0);
  } finally {
    if (shared.recycloneCore) await (await shared.recycloneCore).close();
    delete shared.recycloneCore;
    await pool.query("DELETE FROM recyclone_core_state WHERE site_id = $1", [seed.site.site_id]); await pool.end();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous); await rm(dir, { recursive: true, force: true });
  }
});
