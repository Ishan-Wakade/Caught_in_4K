#!/usr/bin/env node
// Manual smoke test for PhotonMessenger against the REAL Photon/Spectrum
// project — sends one real message. Costs a real send and requires
// MESSENGER_MODE=live + real credentials; nothing here is mocked.
//
// Usage: npm run build && node scripts/send-test-message.mjs <phone> <message>
// Example: node scripts/send-test-message.mjs +15551234567 "test from Recyclone"

import { createMessenger } from "../dist/config.js";

const [, , phone, ...msgParts] = process.argv;
const body = msgParts.join(" ");
if (!phone || !body) {
  console.error('Usage: node scripts/send-test-message.mjs "<phone>" "<message>"');
  process.exit(1);
}
if (process.env.MESSENGER_MODE !== "live") {
  console.error("Set MESSENGER_MODE=live (this script only makes sense against the real adapter).");
  process.exit(1);
}

const messenger = createMessenger();
const result = await messenger.send({
  to: { contactId: phone, phone },
  body,
  alertId: "manual-test",
  kind: "clarification",
});

console.log("Sent:", result);
