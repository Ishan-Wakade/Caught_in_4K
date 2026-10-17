import { test } from "node:test";
import assert from "node:assert/strict";
import { MockMessenger } from "@recyclone/integrations";
import { createIntegrationAdapters } from "../../../apps/web/app/api/_core/adapters.js";
import { photonContactMap } from "../../../apps/web/app/api/_core/reply-sink.js";
import { createCore } from "../src/core.js";
import { configFor } from "../src/config.js";
import { resolveReplyContact } from "../src/contact-routing.js";
import { event, testSeed } from "./fixtures.js";

function setup(overrides: Parameters<typeof configFor>[1] = {}) {
  const adapters = createIntegrationAdapters({ MESSENGER_MODE: "mock", ILLUSTRATOR_MODE: "mock" });
  const messenger = adapters.messenger as MockMessenger;
  const core = createCore({ seed: testSeed, config: configFor("demo", { minAssessedEvents: 1, ...overrides }), ...adapters, inboundRepliesMocked: true });
  const input = (id: string, bin = "trash") => event(id, { bin_id: bin, occurred_at: new Date().toISOString() });
  const reply = (id: string, body: string, contactId = "manager") => ({ providerMessageId: id, from: { contactId }, body, receivedAt: new Date().toISOString() });
  return { core, messenger, input, reply };
}

test("S's real mock factories drive core messages, images, manager confirmation and reply deduplication", async () => {
  const h = setup(); await h.core.ingest(h.input("real_factory"));
  assert.equal(h.messenger.sent.length, 1); assert.equal(h.messenger.sent[0]!.mocked, true);
  const bin = (await h.core.getBins())[0]!; assert.equal(bin.illustration!.mocked, true);
  assert.equal(h.messenger.sent[0]!.alertId, (await h.core.getAlerts())[0]!.alert_id);
  const reply = h.reply("confirmed", "The sign is installed");
  assert.equal((await h.core.handleProviderReply(reply, { allowContactIds: true })).status, "applied");
  assert.equal((await h.core.handleProviderReply(reply, { allowContactIds: true })).status, "duplicate");
  assert.equal((await h.core.getItem("cup")).interventions.length, 1);
});

test("negative and future-tense replies cannot be mistaken for completed work by S's interpreter", async () => {
  const h = setup(); await h.core.ingest(h.input("negative"));
  for (const [i, body] of ["The sign is not installed", "I haven't installed it", "I will put up a sign"].entries()) {
    assert.equal((await h.core.handleProviderReply(h.reply(`negative_${i}`, body), { allowContactIds: true })).status, "needs_clarification");
  }
  assert.equal((await h.core.getItem("cup")).interventions.length, 0);
  assert.equal((await h.core.getAlerts())[0]!.state, "sent");
  assert.ok(h.messenger.sent.some(m => m.kind === "clarification"));
});

test("empty/nontext replies clarify instead of failing or confirming work", async () => {
  const h = setup(); await h.core.ingest(h.input("empty"));
  assert.equal((await h.core.handleProviderReply(h.reply("attachment", ""), { allowContactIds: true })).status, "needs_clarification");
  assert.equal((await h.core.getItem("cup")).interventions.length, 0);
});

test("an explicit alert ID disambiguates two bins owned by the same area manager", async () => {
  const h = setup({ minAssessedEvents: 99 });
  await h.core.ingest({ events: [h.input("t1"), h.input("t2"), h.input("r1", "recycling"), h.input("r2", "recycling")] });
  const alerts = (await h.core.getAlerts()).filter(a => a.kind === "emptying"); assert.equal(alerts.length, 2);
  const trash = alerts.find(a => a.bin_id === "trash")!;
  assert.equal((await h.core.handleProviderReply(h.reply("targeted", `[${trash.alert_id}] bin emptied`, "area"), { allowContactIds: true })).status, "applied");
  const bins = await h.core.getBins(); assert.equal(bins[0]!.observed_count, 0); assert.equal(bins[1]!.observed_count, 2);
});

test("invalid modes and missing live credentials fail without silently using mocks", async () => {
  assert.throws(() => createIntegrationAdapters({ MESSENGER_MODE: "lve" }), /MESSENGER_MODE/);
  assert.throws(() => createIntegrationAdapters({ ILLUSTRATOR_MODE: "lve" }), /ILLUSTRATOR_MODE/);
  assert.throws(() => createIntegrationAdapters({ MESSENGER_MODE: "live" }), /SPECTRUM_PROJECT_ID/);
  assert.throws(() => createIntegrationAdapters({ ILLUSTRATOR_MODE: "live" }), /GROK_API_KEY/);
  const image = await createIntegrationAdapters({}).illustrator.illustrate({ snapshotId: "check", binId: "trash", binType: "trash", takenAt: new Date().toISOString(), estimatedFullness: 0, items: [], unknownCount: 0 });
  assert.equal(image.mocked, true);
});

test("live provider identities map through phone, handle or explicit aliases, never an untrusted local ID", () => {
  const contacts = structuredClone(testSeed.contacts);
  contacts[0]!.phone = "+1 (202) 555-0101"; contacts[1]!.handle = "property_handle";
  assert.equal(resolveReplyContact(contacts, { contactId: "+12025550101" }).contactId, "manager");
  assert.equal(resolveReplyContact(contacts, { contactId: "property_handle" }).contactId, "property");
  assert.equal(resolveReplyContact(contacts, { contactId: "opaque_provider_id" }, { aliases: { opaque_provider_id: "area" } }).contactId, "area");
  assert.throws(() => resolveReplyContact(contacts, { contactId: "manager" }), /not a configured/);
  assert.equal(resolveReplyContact(contacts, { contactId: "manager" }, { allowContactIds: true }).contactId, "manager");
  assert.throws(() => resolveReplyContact(contacts, { contactId: "+19995550123" }), /not a configured/);
  contacts[1]!.phone = "+12025550101";
  assert.throws(() => resolveReplyContact(contacts, { contactId: "+12025550101" }), /multiple/);
  assert.throws(() => resolveReplyContact(contacts, { contactId: "opaque" }, { aliases: { opaque: "missing" } }), /unknown contact/);
});

test("malformed contact-map configuration fails visibly", () => {
  assert.deepEqual(photonContactMap(undefined), {});
  assert.deepEqual(photonContactMap('{"provider_id":"manager"}'), { provider_id: "manager" });
  for (const value of ["oops", "null", "[]", '{"provider_id":7}', '{"provider_id":""}']) assert.throws(() => photonContactMap(value), /PHOTON_CONTACT_MAP/);
});

test("replying with the requested bin ID selects the correct bin among several full bins", async () => {
  const h = setup({ minAssessedEvents: 99 });
  await h.core.ingest({ events: [h.input("id_t1"), h.input("id_t2"), h.input("id_r1", "recycling"), h.input("id_r2", "recycling")] });
  assert.equal((await h.core.handleProviderReply(h.reply("bin_id_reply", "trash emptied", "area"), { allowContactIds: true })).status, "applied");
  const bins = await h.core.getBins(); assert.equal(bins[0]!.observed_count, 0); assert.equal(bins[1]!.observed_count, 2);
});

test("a manager saying they are emptying a bin has not confirmed completion", async () => {
  const h = setup({ minAssessedEvents: 99 }); await h.core.ingest({ events: [h.input("doing_t1"), h.input("doing_t2")] });
  assert.equal((await h.core.handleProviderReply(h.reply("in_progress", "I'm emptying it", "area"), { allowContactIds: true })).status, "needs_clarification");
  assert.equal((await h.core.getBins())[0]!.observed_count, 2);
});
