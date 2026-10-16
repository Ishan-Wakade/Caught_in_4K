#!/usr/bin/env node
// Registers (or re-points) this project's Spectrum/Photon webhook.
// Usage: node scripts/register-webhook.mjs https://your-app.com/api/photon/webhook
//
// Reads SPECTRUM_PROJECT_ID / SPECTRUM_PROJECT_SECRET from the environment
// (source your .env first, e.g. `set -a && source ../../.env && set +a`).
// Run this once per deployment URL — including each time a new ngrok/tunnel
// URL is issued during local development, since those change on restart.

const webhookUrl = process.argv[2];
if (!webhookUrl) {
  console.error("Usage: node scripts/register-webhook.mjs <https://your-app.com/api/photon/webhook>");
  process.exit(1);
}

const projectId = process.env.SPECTRUM_PROJECT_ID;
const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
if (!projectId || !projectSecret) {
  console.error("SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET must be set in the environment.");
  process.exit(1);
}

const res = await fetch(`https://spectrum.photon.codes/projects/${projectId}/webhooks/`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${projectId}:${projectSecret}`).toString("base64")}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ webhookUrl }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`Registration failed: ${res.status} ${res.statusText}\n${text}`);
  process.exit(1);
}

console.log(`Registered webhook -> ${webhookUrl}`);
console.log(text);
// If the response includes a signing secret, set it as PHOTON_WEBHOOK_SECRET
// (see packages/integrations/AGENTS.md) — the docs excerpt we have doesn't
// show the response shape, so check this output for one.
