import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AlertSummarySchema, BinSummarySchema, CatalogItemSchema, DemoSiteSchema,
  DisposalEventSchema, FeedResponseSchema, ItemDetailSchema, ItemSummarySchema, ReviewItemSchema,
} from "@recyclone/contracts";
import { createCore } from "../src/core.js";
import { configFromSite } from "../src/config.js";
import { createLocalMocks } from "../src/mocks.js";
import { createEventValidator } from "../src/validation.js";
const fixture = (path: string) => new URL(`../../../contracts/fixtures/${path}`, import.meta.url);
// Roundtrip through JSON as the HTTP API does; also assert no undocumented fields.
function exact(schema: { parse(value: unknown): unknown }, value: unknown) {
  const json = JSON.parse(JSON.stringify(value)); assert.deepEqual(schema.parse(json), json);
}

test("E's synthetic scenario runs through core and all dashboard projections match shared schemas exactly", async () => {
  const seed = DemoSiteSchema.parse(JSON.parse(await readFile(fixture("demo-site.json"), "utf8")));
  const events = (await readFile(fixture("synthetic-events.jsonl"), "utf8")).trim().split("\n").map(line => DisposalEventSchema.parse(JSON.parse(line)));
  let time = Date.parse(events[0]!.occurred_at);
  const clock = () => new Date(time);
  const config = configFromSite("demo", seed.config_profiles.demo);
  const core = createCore({ seed, config, ...createLocalMocks(clock), clock, inboundRepliesMocked: true });
  assert.equal(config.minAssessedEvents, 3); assert.equal(config.followUpMs, 120_000); assert.equal(config.halfLifeMs, 3_600_000);
  const initial = (await core.getBins()).find(b => b.type === "trash")!;
  assert.equal(initial.estimated_volume_l, 93.5); assert.equal(initial.observed_count, 0);
  for (const e of events) { time = Date.parse(e.occurred_at); assert.equal((await core.ingest(e) as { status: string }).status, "created"); }
  const feed = await core.getFeed(); exact(FeedResponseSchema, feed);
  assert.ok(feed.items.filter(f => f.type === "disposal").every(f => f.summary.includes("[labeled backup input]")));
  for (const bin of await core.getBins()) exact(BinSummarySchema, bin);
  for (const item of await core.getItems()) { exact(ItemSummarySchema, item); exact(ItemDetailSchema, await core.getItem(item.catalog_item_id)); }
  for (const item of await core.getCatalog()) exact(CatalogItemSchema, item);
  const reviews = await core.getReviews(); assert.equal(reviews.length, 1); exact(ReviewItemSchema, reviews[0]);
  assert.equal(reviews[0]!.event_id, events[9]!.event_id);
  const alerts = await core.getAlerts(); for (const alert of alerts) exact(AlertSummarySchema, alert);
  const recommendation = alerts.find(a => a.kind === "recommendation")!;
  assert.equal(recommendation.contact_id, "ct_beanco_mgr");
  assert.equal(alerts.filter(a => a.kind === "recommendation").length, 1);
  assert.ok(alerts.some(a => a.kind === "emptying" && a.contact_id === "ct_area_mgr"));
  assert.equal((await core.getItem("item_generic_can")).assessed_count, 1);
  assert.equal((await core.getItem("item_napkin")).assessed_count, 1);
  const beforeReplay = await core.getBins();
  for (const e of events) assert.equal((await core.ingest(e) as { status: string }).status, "duplicate");
  assert.deepEqual(await core.getBins(), beforeReplay);
  assert.equal((await core.getFeed()).items.filter(f => f.type === "disposal").length, 11);
  const assigned = await core.review(reviews[0]!.event_id, "biz_beanco"); exact(ReviewItemSchema, assigned); assert.equal(assigned.status, "resolved");
  await core.handleReply({ providerMessageId: "fixture_confirm", from: { contactId: "ct_beanco_mgr" }, body: `[${recommendation.alert_id}] Sign installed`, receivedAt: clock().toISOString() });
  const detail = await core.getItem("item_beanco_cup"); exact(ItemDetailSchema, detail); assert.equal(detail.interventions.length, 1);
  const emptying = (await core.getAlerts()).find(a => a.kind === "emptying")!;
  const recyclingBefore = (await core.getBins()).find(b => b.type === "recycling")!.estimated_volume_l;
  await core.handleReply({ providerMessageId: "fixture_empty", from: { contactId: "ct_area_mgr" }, body: `[${emptying.alert_id}] Emptied`, receivedAt: clock().toISOString() });
  const bins = await core.getBins(); assert.equal(bins.find(b => b.type === "trash")!.estimated_volume_l, 0);
  assert.equal(bins.find(b => b.type === "recycling")!.estimated_volume_l, recyclingBefore);
  assert.equal((await core.getItem("item_beanco_cup")).assessed_count, 4);
  for (const a of await core.getAlerts()) { exact(AlertSummarySchema, a); for (const m of a.messages) assert.equal(m.mocked, true); }
  await core.resetDemo(); assert.equal((await core.getBins()).find(b => b.type === "trash")!.estimated_volume_l, 93.5);
});

test("unconfigured normal thresholds remain disabled rather than receiving demo defaults", async () => {
  const seed = DemoSiteSchema.parse(JSON.parse(await readFile(fixture("demo-site.json"), "utf8")));
  const config = configFromSite("normal", seed.config_profiles.normal);
  assert.equal(config.correctSortingThreshold, null); assert.equal(config.fullnessThreshold, null);
  assert.equal(config.evidenceWindowMs, null); assert.equal(config.minAssessedEvents, 5); assert.equal(config.followUpMs, 86_400_000);
});

test("event intake validation agrees with E's published cross-language parity cases", async () => {
  const cases = JSON.parse(await readFile(fixture("parity-cases.json"), "utf8")) as { name: string; valid: boolean; event: unknown }[];
  const validate = createEventValidator();
  for (const c of cases) {
    if (c.valid) assert.doesNotThrow(() => validate(c.event), c.name);
    else assert.throws(() => validate(c.event), c.name);
  }
});
