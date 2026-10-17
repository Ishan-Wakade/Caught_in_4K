#!/usr/bin/env node
// Demo trigger: makes core send its real Photon texts on cue. Resets core, posts the 11 synthetic
// disposal events (contracts/fixtures/synthetic-events.jsonl) to a running apps/web, then polls
// /api/feed, which is what drives core's outbound message jobs. Expect two texts: the Bean Co. cup
// recommendation (ct_beanco_mgr) and the Patio trash emptying request (ct_area_mgr), plus one
// follow-up each after the demo no-reply interval if nobody answers.
//
// The events are re-timed to end "now": the demo profile only counts the last hour of evidence,
// and the fixture's own timestamps are fixed. event_ids are unchanged (they don't hash time).
//
// Needs apps/web running with CONFIG_PROFILE=demo, CORE_STORAGE=memory, MESSENGER_MODE=live and
// CONTACT_PHONES_JSON mapping those contacts to phones that have texted the Photon line
// (see packages/integrations/AGENTS.md). Reads WORKER_INGEST_TOKEN and MANAGER_API_TOKEN from the
// environment or the repo's .env.
//
// Usage: pnpm --filter @recyclone/integrations demo:trigger [baseUrl=http://localhost:3000]

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(import.meta.url), "../../../..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env")); // never overrides set variables

const base = process.argv[2] ?? "http://localhost:3000";
const { WORKER_INGEST_TOKEN, MANAGER_API_TOKEN } = process.env;
if (!WORKER_INGEST_TOKEN || !MANAGER_API_TOKEN) {
  console.error("Set WORKER_INGEST_TOKEN and MANAGER_API_TOKEN (same values the running apps/web uses).");
  process.exit(1);
}

async function call(method, path, headers = {}, body) {
  const res = await fetch(`${base}${path}`, { method, headers, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
  return JSON.parse(text);
}

try {
  await call("POST", "/api/demo/reset", { Authorization: `Bearer ${MANAGER_API_TOKEN}` });
  console.log("Core reset.");

  const events = readFileSync(resolve(root, "contracts/fixtures/synthetic-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const shift = Date.now() - 2000 - Math.max(...events.map((e) => Date.parse(e.occurred_at)));
  for (const e of events) {
    const retimed = { ...e, occurred_at: new Date(Date.parse(e.occurred_at) + shift).toISOString() };
    await call("POST", "/api/events", { Authorization: `Bearer ${WORKER_INGEST_TOKEN}`, "Content-Type": "application/json" }, JSON.stringify(retimed));
  }
  console.log(`Posted ${events.length} events.`);

  // Each feed poll runs core's pending jobs; a few seconds is enough for the sends.
  for (let i = 0; i < 8; i++) {
    await call("GET", "/api/feed");
    await new Promise((r) => setTimeout(r, 1000));
  }

  const alerts = await call("GET", "/api/alerts");
  for (const a of alerts) {
    for (const m of a.messages.filter((m) => m.direction === "outbound")) {
      console.log(`${m.mocked ? "MOCKED" : "SENT  "} ${m.kind} -> ${a.contact_id}: ${m.body.slice(0, 90)}…`);
    }
  }
  if (!alerts.some((a) => a.messages.some((m) => m.direction === "outbound"))) {
    console.log("No messages sent yet. Check the apps/web server log for Photon errors.");
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
