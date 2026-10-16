#!/usr/bin/env node
// Manual smoke test for receiving a REAL inbound Photon/Spectrum webhook,
// without needing apps/web (Next.js) scaffolded yet. Starts a plain Node
// HTTP server, verifies + deserializes each delivery via app.webhook(),
// and logs the sender + text. Point a tunnel (e.g. `ngrok http 8787`) at
// this, register the tunnel's https URL with
// `npm run register-webhook -- <tunnel-url>`, then text the project's
// configured number/handle from a real phone and watch this log.
//
// Usage: npm run build && node scripts/listen-webhook.mjs [port=8787]

import http from "node:http";
import { getPhotonApp } from "../dist/messenger/photonApp.js";

const port = Number(process.argv[2] ?? 8787);
const app = await getPhotonApp();
console.log("Photon app ready, listening for webhook deliveries...");

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const body = Buffer.concat(chunks);
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]));

    const result = await app.webhook(
      { body, headers },
      (space, message) => {
        console.log("Inbound message:", {
          spaceId: space.id,
          messageId: message.id,
          from: message.sender?.id,
          timestamp: message.timestamp.toISOString(),
          content: message.content,
        });
      },
    );

    res.writeHead(result.status, result.headers);
    res.end(Buffer.from(result.body));
  });
});

server.listen(port, () => {
  console.log(`Listening on http://localhost:${port} — tunnel this and register the tunnel URL.`);
});
