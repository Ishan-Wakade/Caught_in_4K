import { test } from "node:test";
import assert from "node:assert/strict";
import type { Messenger, Illustrator, ReplyInterpreter, InboundReply } from "@recyclone/contracts";
import { createCore } from "../src/core.js";
import { configFor, type CoreConfig } from "../src/config.js";
import { MemoryRepository } from "../src/repository.js";
import { initialState, type SiteSeed } from "../src/model.js";
import { createLocalMocks } from "../src/mocks.js";
import { testSeed, event } from "./fixtures.js";
const START = Date.parse("2026-10-17T12:00:00.000Z");
function harness(overrides: Partial<CoreConfig> = {}, seed: SiteSeed = testSeed) {
  let time = START, failMessage = false;
  const sent: Parameters<Messenger["send"]>[0][] = [];
  const images: Parameters<Illustrator["illustrate"]>[0][] = [];
  let interpretation: Awaited<ReturnType<ReplyInterpreter["interpret"]>> | undefined;
  const config = configFor("demo", overrides), repository = new MemoryRepository(initialState(seed, config));
  const core = createCore({ seed, config, repository, inboundRepliesMocked: true, clock: () => new Date(time),
    messenger: { async send(msg) { sent.push(msg); if (failMessage) throw new Error("Transport unavailable"); return { providerMessageId: `provider_${sent.length}`, sentAt: new Date(time).toISOString(), mocked: true }; } },
    illustrator: { async illustrate(snapshot) { images.push(snapshot); return { imageUrl: "https://example.test/mock.png", generatedAt: new Date(time).toISOString(), snapshotId: snapshot.snapshotId, mocked: true }; } },
    interpreter: { async interpret(_reply, alerts) { return interpretation ?? { alertId: alerts.length === 1 ? alerts[0].alertId : null, intent: "acknowledged" }; } },
  });
  return { core, repository, sent, images, setTime(t: number) { time = t; }, fail() { failMessage = true; }, interpret(v: typeof interpretation) { interpretation = v; },
    reply(id = "reply1", contactId = "manager"): InboundReply { return { providerMessageId: id, from: { contactId }, body: "Action installed", receivedAt: new Date(time).toISOString() }; } };
}
test("concurrent/replayed events are idempotent even if replay changes payload", async () => {
  const h = harness();
  const results = await Promise.all([h.core.ingest(event("e1")), h.core.ingest(event("e1"))]);
  assert.deepEqual(results.map(x => (x as {status: string}).status).sort(), ["created", "duplicate"]);
  await h.core.ingest(event("e1", { bin_id: "recycling", event_id: event("e1").event_id }));
  assert.equal((await h.core.getBins())[0].observed_count, 1);
  assert.equal((await h.core.getFeed()).items.filter(f => f.type === "disposal").length, 1);
});
test("classification excludes unclear destinations and unidentified items", async () => {
  const h = harness({ minAssessedEvents: 99 });
  await h.core.ingest({ events: [event("wrong"), event("right", { bin_id: "recycling" }), event("unclear", { destination_confidence: 0.1 }), event("unknown", { item: { catalog_item_id: null, label: "thing", confidence: 0, candidates: [] } })] });
  const m = (await h.core.getItem("cup"));
  assert.equal(m.assessed_count, 2); assert.equal(m.correct_sorting_pct, 50); assert.equal((await h.repository.transaction(s => Object.values(s.events).filter(e => e.correctness === "unassessable"))).length, 2);
  assert.equal((await h.core.getBins())[0].observed_count, 2);
});
test("uncertain origin queues review; assignment recomputes without duplication", async () => {
  const h = harness({ minAssessedEvents: 1 });
  await h.core.ingest(event("g1", { item: { catalog_item_id: "generic", label: "can", confidence: 0.99, candidates: [] }, business: { business_id: "biz_cafe", confidence: 0.1, basis: ["logo_text"] } }));
  assert.equal((await h.core.getReviews()).length, 1); assert.equal(h.sent.length, 0);
  await h.core.review(event("g1", { item: { catalog_item_id: "generic", label: "can", confidence: 0.99, candidates: [] }, business: { business_id: "biz_cafe", confidence: 0.1, basis: ["logo_text"] } }).event_id, "biz_cafe"); await h.core.review(event("g1", { item: { catalog_item_id: "generic", label: "can", confidence: 0.99, candidates: [] }, business: { business_id: "biz_cafe", confidence: 0.1, basis: ["logo_text"] } }).event_id, "biz_cafe");
  assert.equal((await h.core.getReviews()).length, 0); assert.equal(h.sent.length, 1);
  assert.equal((await h.core.getItem("generic")).assessed_count, 1);
});
test("leave unresolved does not notify a restaurant", async () => {
  const h = harness({ minAssessedEvents: 1 });
  await h.core.ingest(event("g1", { item: { catalog_item_id: "generic", label: "can", confidence: 0.99, candidates: [] }, business: { business_id: "biz_cafe", confidence: 0.1, basis: ["logo_text"] } }));
  await h.core.review(event("g1", { item: { catalog_item_id: "generic", label: "can", confidence: 0.99, candidates: [] }, business: { business_id: "biz_cafe", confidence: 0.1, basis: ["logo_text"] } }).event_id, null);
  assert.equal((await h.core.getReviews())[0].status, "left_unresolved"); assert.equal(h.sent.length, 0);
});
test("no data means insufficient_data; normal/demo configurations are independent", async () => {
  const h = harness(); const m = (await h.core.getItem("cup"));
  assert.equal(m.correct_sorting_pct, null); assert.equal(m.status, "insufficient_data");
  assert.equal(configFor("normal").minAssessedEvents, 5); assert.equal(configFor("demo").minAssessedEvents, 2);
  assert.equal(configFor("normal").followUpMs, 86_400_000); assert.equal(configFor("demo").followUpMs, 30_000);
  assert.throws(() => configFor("demo", { halfLifeMs: 0 }));
});
test("two-day half-life and cross-station aggregation", async () => {
  const h = harness({ minAssessedEvents: 99 });
  await h.core.ingest(event("old", { bin_id: "recycling", occurred_at: "2026-10-15T12:00:00.000Z" }));
  await h.core.ingest(event("new", { bin_id: "compost", source: { camera_id: "camera2", clip_id: "clip", track_id: 2, mode: "recorded" } }));
  const m = (await h.core.getItem("cup"));
  assert.ok(Math.abs(m.correct_sorting_pct! - 100 / 3) < 0.0001);
  assert.equal(m.by_station.filter(s => s.assessed_count > 0).length, 2);
});
test("minimum evidence gates recent events rather than all historical events", async () => {
  const h = harness({ minAssessedEvents: 5, evidenceWindowMs: 86_400_000 });
  await h.core.ingest({ events: Array.from({ length: 5 }, (_, i) => event(`old${i}`, { occurred_at: "2026-10-10T12:00:00.000Z" })) });
  assert.equal(h.sent.filter(m => m.kind === "recommendation").length, 0);
  await h.core.ingest({ events: Array.from({ length: 5 }, (_, i) => event(`new${i}`)) });
  assert.equal(h.sent.filter(m => m.kind === "recommendation").length, 1);
});
test("24-hour no-response follow-up sends once under concurrent polling", async () => {
  const h = harness({ minAssessedEvents: 1, followUpMs: 86_400_000 }); await h.core.ingest(event("e1"));
  h.setTime(START + 86_399_999); await h.core.getFeed(); assert.equal(h.sent.length, 1);
  h.setTime(START + 86_400_000); await Promise.all([h.core.getFeed(), h.core.getFeed()]);
  h.setTime(START + 3 * 86_400_000); await h.core.getFeed();
  assert.equal(h.sent.filter(m => m.kind === "follow_up").length, 1);
  assert.ok((await h.core.getAlerts())[0].messages.every(m => m.mocked === true));
});
test("acknowledgement stops reminder but is not an intervention", async () => {
  const h = harness({ minAssessedEvents: 1 }); await h.core.ingest(event("e1")); await h.core.handleReply(h.reply());
  h.setTime(START + 60_000); await h.core.getFeed();
  assert.equal((await h.core.getAlerts())[0].state, "acknowledged");
  assert.equal((await h.core.getItem("cup")).interventions.length, 0); assert.equal(h.sent.length, 1);
});
test("confirmed action after ack records one intervention despite duplicate reply", async () => {
  const h = harness({ minAssessedEvents: 1 }); await h.core.ingest(event("e1")); await h.core.handleReply(h.reply("ack"));
  h.interpret({ alertId: (await h.core.getAlerts())[0].alert_id, intent: "action_confirmed" });
  assert.equal((await h.core.handleReply(h.reply("done"))).status, "applied");
  assert.equal((await h.core.handleReply(h.reply("done"))).status, "duplicate");
  const item = (await h.core.getItem("cup")); assert.equal(item.interventions.length, 1);
  assert.ok(item.interventions[0].before.from); assert.ok(item.interventions[0].after.to);
});
test("reply cannot modify another manager's alert", async () => {
  const h = harness({ minAssessedEvents: 1 }); await h.core.ingest(event("e1"));
  h.interpret({ alertId: (await h.core.getAlerts())[0].alert_id, intent: "action_confirmed" });
  assert.equal((await h.core.handleReply(h.reply("hostile", "area"))).status, "needs_clarification");
  assert.equal((await h.core.getAlerts())[0].state, "sent");
});
test("ambiguous reply requests clarification without completing an action", async () => {
  const h = harness({ minAssessedEvents: 1 }); await h.core.ingest(event("e1")); h.interpret({ alertId: null, intent: "unclear" });
  assert.equal((await h.core.handleReply(h.reply())).status, "needs_clarification");
  assert.equal(h.sent.filter(m => m.kind === "clarification").length, 1); assert.equal((await h.core.getAlerts())[0].state, "sent");
});
test("bin-emptying confirmation preserves later deposits, other bins and history", async () => {
  const h = harness({ minAssessedEvents: 99 });
  await h.core.ingest({ events: [event("e1"), event("e2"), event("other", { bin_id: "recycling" })] });
  const a = (await h.core.getAlerts()).find(a => a.kind === "emptying")!; assert.equal(a.bin_id, "trash");
  h.setTime(START + 10_000); await h.core.ingest(event("after", { occurred_at: "2026-10-17T12:00:10.000Z" }));
  h.interpret({ alertId: a.alert_id, intent: "bin_emptied", emptiedAt: "2026-10-17T12:00:05.000Z" });
  await h.core.handleReply(h.reply("empty", "area"));
  const bins = await h.core.getBins(); assert.equal(bins[0].observed_count, 1); assert.equal(bins[1].observed_count, 1);
  assert.equal((await h.core.getItem("cup")).assessed_count, 4);
  assert.equal((await h.core.handleReply(h.reply("empty", "area"))).status, "duplicate");
});
test("numeric fullness is independent of generated images and snapshots carry mocked flag", async () => {
  const h = harness({ minAssessedEvents: 99 }); await h.core.ingest(event("e1")); const bin = (await h.core.getBins())[0];
  assert.equal(bin.estimated_volume_l, 0.4); assert.equal(bin.estimated_fullness, 0.4);
  assert.equal(bin.illustration!.snapshot_id.startsWith("image_"), true); assert.equal(bin.illustration!.mocked, true);
});
test("unidentified items do not invent capacity estimates", async () => {
  const h = harness({ minAssessedEvents: 99 });
  await h.core.ingest(event("food", { item: { catalog_item_id: null, label: "unknown", confidence: null, candidates: [] } }));
  const bin = (await h.core.getBins())[0]; assert.equal(bin.unknown_count, 1); assert.equal(bin.estimated_volume_l, 0);
});
test("condition-dependent rules stay unassessable without condition observations", async () => {
  const seed = structuredClone(testSeed); seed.catalog[0].condition_rule = "Only clean cups";
  const h = harness({ minAssessedEvents: 1 }, seed); await h.core.ingest(event("e1"));
  assert.equal((await h.core.getItem("cup")).assessed_count, 0); assert.equal(h.sent.length, 0);
});
test("batch validation is atomic and rejects non-authoritative cameras", async () => {
  const h = harness();
  await assert.rejects(h.core.ingest({ events: [event("good"), event("bad", { bin_id: "missing" })] }), /Unknown bin/);
  await assert.rejects(h.core.ingest(event("badcam", { source: { camera_id: "other", clip_id: "clip", track_id: 1, mode: "recorded" } })), /authoritative camera/);
  assert.equal((await h.core.getBins())[0].observed_count, 0);
});
test("transport failure preserves event and is not retried automatically", async () => {
  const h = harness({ minAssessedEvents: 1 }); h.fail(); await h.core.ingest(event("e1")); await h.core.getFeed(); await h.core.getFeed();
  assert.equal(h.sent.length, 1); assert.match((await h.core.getAlerts())[0].trigger, /Delivery failed/);
  assert.equal((await h.core.getItem("cup")).assessed_count, 1);
});
test("catalog edits recompute classifications without duplicating history", async () => {
  const h = harness({ minAssessedEvents: 99 }); await h.core.ingest(event("e1"));
  await h.core.upsertCatalog({ ...testSeed.catalog[0], destination: "trash" });
  const m = (await h.core.getItem("cup")); assert.equal(m.assessed_count, 1); assert.equal(m.correct_sorting_pct, 100);
});
test("reset reloads demo seed and keeps polling cursors advancing; normal reset disabled", async () => {
  const h = harness(); await h.core.ingest(event("e1")); const cursor = (await h.core.getFeed()).next_cursor;
  await h.core.resetDemo(); assert.equal((await h.core.getBins())[0].observed_count, 0); await h.core.ingest(event("e1"));
  assert.ok((await h.core.getFeed(cursor)).items.some(f => f.type === "disposal"));
  const normal = createCore({ seed: testSeed, config: configFor("normal"), ...createLocalMocks(), validateEvent: v => v as ReturnType<typeof event> });
  await assert.rejects(normal.resetDemo(), /disabled/);
});
test("in-store recommendations route to the property manager", async () => {
  const seed = structuredClone(testSeed);
  const h = harness({ minAssessedEvents: 1, stationLocations: { patio: "in_store" } }, seed); await h.core.ingest(event("e1")); assert.equal(h.sent[0].to.contactId, "property");
});
test("catalog origin wins conflicting worker business; logo can identify generic packaging", async () => {
  const seed = structuredClone(testSeed);
  seed.businesses.push({ business_id: "biz_other", name: "Other" });
  const h = harness({ minAssessedEvents: 99 }, seed);
  await h.core.ingest(event("catalog", { business: { business_id: "biz_other", confidence: 1, basis: ["logo_text"] } }));
  assert.equal((await h.core.getItem("cup")).business_id, "biz_cafe");
  assert.equal((await h.core.getItem("cup")).assessed_count, 1);
  await h.core.ingest(event("logo", { item: { catalog_item_id: "generic", label: "can", confidence: 1, candidates: [] }, business: { business_id: "biz_other", confidence: 1, basis: ["logo_text"] } }));
  assert.equal((await h.core.getReviews()).length, 0);
  assert.equal((await h.core.getItem("generic")).assessed_count, 1);
});
test("ambiguous single-alert reply is visible and counts as a response for reminders", async () => {
  const h = harness({ minAssessedEvents: 1 }); await h.core.ingest(event("e1")); h.interpret({ alertId: null, intent: "unclear" });
  await h.core.handleReply(h.reply("unclear")); h.setTime(START + 60_000); await h.core.getFeed();
  assert.equal(h.sent.filter(m => m.kind === "follow_up").length, 0);
  assert.ok((await h.core.getAlerts())[0].messages.some(m => m.direction === "inbound"));
});
test("future emptying time is clarified without resetting inventory", async () => {
  const h = harness({ minAssessedEvents: 99 }); await h.core.ingest({ events: [event("e1"), event("e2")] });
  const a = (await h.core.getAlerts())[0];
  h.interpret({ alertId: a.alert_id, intent: "bin_emptied", emptiedAt: "2026-10-18T12:00:00.000Z" });
  assert.equal((await h.core.handleReply(h.reply("empty", "area"))).status, "needs_clarification");
  assert.equal((await h.core.getBins())[0].observed_count, 2);
});
test("provider reply IDs can contain arbitrary provider punctuation without breaking deduplication", async () => {
  const h = harness({ minAssessedEvents: 1 }); await h.core.ingest(event("e1"));
  assert.equal((await h.core.handleReply(h.reply("provider:/message+id="))).status, "applied");
  assert.equal((await h.core.handleReply(h.reply("provider:/message+id="))).status, "duplicate");
});
