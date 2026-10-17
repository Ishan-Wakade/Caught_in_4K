import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POST as mockReply } from "../../../apps/web/app/api/photon/mock-reply/route.js";
import { handleInboundReply } from "../../../apps/web/app/api/photon/_shared.js";
import { getCore } from "../../../apps/web/app/api/_core/runtime.js";
import { testSeed, event } from "./fixtures.js";

const request = (input: unknown, token?: string) => new Request("http://localhost/api/photon/mock-reply", { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(input) });

test("actual Photon mock-reply route reaches core, validates input and records confirmations/reset", async () => {
  const previous = { ...process.env }, dir = await mkdtemp(join(tmpdir(), "recyclone-photon-route-"));
  const shared = globalThis as typeof globalThis & { recycloneCore?: ReturnType<typeof getCore> };
  try {
    await writeFile(join(dir, "site.json"), JSON.stringify(testSeed));
    Object.assign(process.env, { CONFIG_PROFILE: "demo", CORE_STORAGE: "memory", CORE_SITE_CONFIG_PATH: join(dir, "site.json"), MESSENGER_MODE: "mock", ILLUSTRATOR_MODE: "mock", MANAGER_API_TOKEN: "manager_test", ENABLE_MOCK_REPLY: "true" });
    delete process.env.PHOTON_CONTACT_MAP;
    const core = await getCore();
    await core.ingest({ events: Array.from({ length: 3 }, (_, i) => event(`photon_${i}`, { occurred_at: new Date().toISOString() })) });
    delete process.env.ENABLE_MOCK_REPLY;
    assert.equal((await mockReply(request({ contactId: "manager", body: "installed" }, "manager_test"))).status, 403);
    process.env.ENABLE_MOCK_REPLY = "true";
    delete process.env.MANAGER_API_TOKEN;
    assert.equal((await mockReply(request({ contactId: "manager", body: "installed" }))).status, 503);
    process.env.MANAGER_API_TOKEN = "manager_test";
    assert.equal((await mockReply(request({ contactId: "manager", body: "installed" }))).status, 401);
    assert.equal((await mockReply(request({ contactId: 7, body: "installed" }, "manager_test"))).status, 400);
    const malformed = new Request("http://localhost/api/photon/mock-reply", { method: "POST", headers: { Authorization: "Bearer manager_test" }, body: "{" });
    assert.equal((await mockReply(malformed)).status, 400);
    const result = await mockReply(request({ contactId: "manager", body: "DONE, sign is up at the counter" }, "manager_test"));
    assert.equal(result.status, 200); assert.equal((await result.json()).status, "applied");
    assert.equal((await core.getItem("cup")).interventions.length, 1);
    assert.equal((await mockReply(request({ contactId: "not_a_manager", body: "installed" }, "manager_test"))).status, 403);
    const reset = await mockReply(request({ contactId: "area", body: "Bin emptied" }, "manager_test"));
    assert.equal(reset.status, 200); assert.equal((await core.getBins())[0]!.observed_count, 0);
    assert.equal((await core.getItem("cup")).assessed_count, 3);
    process.env.MESSENGER_MODE = "live";
    assert.equal((await mockReply(request({ contactId: "manager", body: "installed" }, "manager_test"))).status, 403);
  } finally {
    if (shared.recycloneCore) await (await shared.recycloneCore).close(); delete shared.recycloneCore;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  }
});

test("failed sender resolution stays retryable, and successful replies are durably deduplicated by core", async () => {
  const previous = { ...process.env }, dir = await mkdtemp(join(tmpdir(), "recyclone-photon-retry-"));
  const shared = globalThis as typeof globalThis & { recycloneCore?: ReturnType<typeof getCore> };
  try {
    await writeFile(join(dir, "site.json"), JSON.stringify(testSeed));
    Object.assign(process.env, { CONFIG_PROFILE: "demo", CORE_STORAGE: "memory", CORE_SITE_CONFIG_PATH: join(dir, "site.json"), MESSENGER_MODE: "mock", ILLUSTRATOR_MODE: "mock" });
    delete process.env.PHOTON_CONTACT_MAP;
    const core = await getCore();
    await core.ingest({ events: Array.from({ length: 3 }, (_, i) => event(`retry_${i}`, { occurred_at: new Date().toISOString() })) });
    const reply = { providerMessageId: "same_provider_delivery", from: { contactId: "provider_sender" }, body: "Sign installed", receivedAt: new Date().toISOString() };
    await assert.rejects(handleInboundReply(reply), /not a configured/);
    process.env.PHOTON_CONTACT_MAP = JSON.stringify({ provider_sender: "manager" });
    assert.equal((await handleInboundReply(reply)).status, "applied");
    assert.equal((await handleInboundReply(reply)).status, "duplicate");
    assert.equal((await core.getItem("cup")).interventions.length, 1);
  } finally {
    if (shared.recycloneCore) await (await shared.recycloneCore).close(); delete shared.recycloneCore;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  }
});


test("runtime contact-phone overrides resolve provider senders and reject malformed mappings", async () => {
  const previous = { ...process.env }, dir = await mkdtemp(join(tmpdir(), "recyclone-photon-phones-"));
  const shared = globalThis as typeof globalThis & { recycloneCore?: ReturnType<typeof getCore> };
  try {
    await writeFile(join(dir, "site.json"), JSON.stringify(testSeed));
    Object.assign(process.env, { CONFIG_PROFILE: "demo", CORE_STORAGE: "memory", CORE_SITE_CONFIG_PATH: join(dir, "site.json"), MESSENGER_MODE: "mock", ILLUSTRATOR_MODE: "mock" });
    delete process.env.PHOTON_CONTACT_MAP;
    for (const value of ["{", "null", "[]", '{"manager":7}', '{"manager":""}', '{"missing":"+12025550101"}']) {
      process.env.CONTACT_PHONES_JSON = value;
      await assert.rejects(getCore(), /CONTACT_PHONES_JSON/);
    }
    process.env.CONTACT_PHONES_JSON = JSON.stringify({ manager: "+12025550101" });
    const core = await getCore();
    await core.ingest({ events: Array.from({ length: 3 }, (_, i) => event(`phones_${i}`, { occurred_at: new Date().toISOString() })) });
    assert.equal((await handleInboundReply({ providerMessageId: "phone_override", from: { contactId: "+12025550101" }, body: "Sign installed", receivedAt: new Date().toISOString() })).status, "applied");
    assert.equal((await core.getItem("cup")).interventions.length, 1);
  } finally {
    if (shared.recycloneCore) await (await shared.recycloneCore).close(); delete shared.recycloneCore;
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key]; Object.assign(process.env, previous);
    await rm(dir, { recursive: true, force: true });
  }
});
