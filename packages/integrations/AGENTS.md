# packages/integrations/ — Photon and Grok Imagine (owner: Agent S)

Read the root `AGENTS.md` and `contracts/README.md` first. Only S edits this folder and `apps/web/app/api/photon/**`.

## Job

Implement the `Messenger`, `ReplyInterpreter`, and `Illustrator` interfaces from contract §5, each with a real adapter and an explicit mock. Every result carries `mocked: true|false`. Core decides *when* to send and *what state changes*; this package moves messages and images and interprets reply text.

Build the mocks first so I and J are never blocked. Do not claim a real integration works until a real call has succeeded; record in this file what was verified and how.

## Photon 2.0

- `Messenger.send`: send recommendations, follow-ups, emptying requests, and clarification questions to a manager contact through the configured Photon channel. The channel has not been chosen yet.
- `POST /api/photon/webhook`: receive inbound replies, verify them if Photon supports signatures, de-duplicate by `providerMessageId` (duplicate webhook delivery must not repeat actions), normalize to `InboundReply`, and pass to core's `ReplySink.handleReply`.
- `ReplyInterpreter.interpret`: link a reply to one open alert and decide its intent (`action_confirmed`, `bin_emptied`, `acknowledged`, `unclear`). If it is ambiguous which alert is meant, return `alertId: null` / `unclear` so core sends a clarification question. An acknowledgement ("ok thanks") is not a confirmation that the action was done.
- Mock: an in-app conversation the presenter can type manager replies into during the demo, clearly labeled as mocked. S provides `POST /api/photon/mock-reply` (`{ contactId, body }`), which enters exactly the same path as the webhook; J provides the input box (contract §6).

## Grok Imagine

- `Illustrator.illustrate`: generate an illustrative image of one bin's estimated contents from its `BinInventorySnapshot`.
- The image is labeled generated and illustrative, carries the snapshot timestamp, and is never used to infer counts or fullness.
- Mock: a placeholder image that shows the snapshot data, labeled as mocked.

## Verify

- Duplicate webhook delivery produces one `handleReply` call.
- Ambiguous replies come back `unclear` and do not change state.
- Each generated image is linked to the correct bin and snapshot.
- Mocks and real adapters are switchable through configuration, and the dashboard can tell which is active.

## Photon 2.0 architecture (confirmed from the real `spectrum-ts` package, v12.11.0)

Photon 2.0 is spectrum-ts (`photon.codes`), a messaging SDK, not a plain REST API:

- **There is no public HTTP "send a message" endpoint.** Sending goes through the SDK: `Spectrum({ projectId, projectSecret, providers: [...] })` builds an authenticated `app`, then `provider.space.create(userId)` resolves-or-creates a conversation and `space.send(body)` sends into it, returning a `Message` with a real `.id` and `.timestamp`. This runs fine inside a Next.js API route per-invocation — no separate always-on daemon is needed, despite the quickstart's "run in a separate process" phrasing (that means "server-side," not "long-lived").
- **Inbound replies arrive two ways**: (a) a native HTTP webhook (`app.webhook(request, handler)` — auto-verifies the `X-Spectrum-Signature`/`X-Spectrum-Timestamp` HMAC against `webhookSecret`, deserializes to `[space, message]`, this is what our route uses), or (b) an in-process `for await (const [space, message] of app.messages)` iterator, which needs a persistent process and isn't used here since the HTTP webhook fits Vercel directly.
- **Multiple provider channels exist** (`@spectrum-ts/imessage`, `whatsapp-business`, `slack`, `telegram`, `terminal`). The team still needs to pick one — the quickstart docs happened to show `imessage`, which is what this code defaults to, but that is an assumption, not a confirmed decision.

## Environment variables

`SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` (Spectrum project credentials), `PHOTON_CHANNEL` (`imessage` | `whatsapp_business`), `PHOTON_WEBHOOK_SECRET` (verifies inbound `X-Spectrum-Signature`), `MESSENGER_MODE` (`mock` | `live`). If `PHOTON_CHANNEL=whatsapp_business`: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, optional `WHATSAPP_APP_SECRET`. Separately: `GROK_API_KEY`, `ILLUSTRATOR_MODE` (`mock` | `live`).

## Build log

Status as of this scaffold, so nobody mistakes a stub for a working integration:

- **Built and unit-tested (`pnpm --filter @recyclone/integrations test`, 16 passing):** `MockMessenger`, `MockIllustrator` (placeholder SVG rendered from the real `BinInventorySnapshot`, linked to its `snapshotId`/`binId`), `RuleBasedReplyInterpreter` (keyword-based; covers confirmed/emptied/acknowledged/unclear and the ambiguous-alert case), `InMemoryReplyDedupeStore`, and the `MESSENGER_MODE`/`ILLUSTRATOR_MODE` config switch in `src/config.ts`. Types now come directly from `@recyclone/contracts` (`src/types.ts` mirror deleted).
- **`PhotonMessenger` is implemented against the real `spectrum-ts` types** (installed as a dependency; typechecks clean against its actual `.d.ts`, see `src/messenger/photonApp.ts` and `photon.ts`). **Not yet run against a real Photon project** — no credentials exist to test with, so this is unverified, not working. `providerMessageId`/`sentAt` come straight off the real `Message.id`/`.timestamp`, no guessing needed there.
- **`apps/web/app/api/photon/webhook/route.ts` now delegates to `app.webhook(request, handler)`** instead of hand-rolled signature/payload parsing — the SDK does verification and normalization. Uses Next's `after()` to keep `handleReply` work alive past the response (the SDK's own handler is fire-and-forget on serverless; confirm `after()` is available once apps/web's Next version is chosen — needs Next 15+). J's Next.js 16 app now builds with this route. `_replySink.ts` forwards to the provider-aware core sink, tested through the mock route in the built app. Signed live-provider delivery and `after()` lifecycle remain unverified.
- **`GrokIllustrator` is still a stub that throws** — Grok Imagine's API hasn't been checked yet.
- This package is part of the root pnpm workspace now: run `pnpm install` at the repo root, then `pnpm --filter @recyclone/integrations test` (not plain `npm`/`npm test`, which bypass the workspace's `@recyclone/contracts` link).

### Resolved

- **Project credentials exist**: `SPECTRUM_PROJECT_ID` / `SPECTRUM_PROJECT_SECRET` (top of the repo's `.env`, gitignored — not reproduced here).
- **Webhook registration is a one-time call**: `POST https://spectrum.photon.codes/projects/$SPECTRUM_PROJECT_ID/webhooks/` (basic auth `$SPECTRUM_PROJECT_ID:$SPECTRUM_PROJECT_SECRET`, body `{"webhookUrl": "..."}`). Wrapped in `pnpm --filter @recyclone/integrations register-webhook -- <url>` (`scripts/register-webhook.mjs`) — run it once a public URL for `/api/photon/webhook` exists (a deployed `apps/web`, or a local tunnel during development; tunnel URLs change on restart, so re-run it each time one does). **Check that call's response for a signing secret** and set it as `PHOTON_WEBHOOK_SECRET` — the docs excerpt we have doesn't show the response shape, so this needs eyes-on when it's actually run.

### Open questions (need a human to supply this; not decidable from the repo)

1. **Confirm the channel.** This code defaults to `imessage` because that's what the quickstart docs happened to show — the team needs to actually decide (`imessage` vs `whatsapp_business` vs another provider) and confirm iMessage really needs no extra per-channel config beyond the project credentials (as the quickstart's zero-arg `imessage.config()` implies).
2. **Grok Imagine API reference** — endpoint, auth, request/response shape — needed to replace the `GrokIllustrator` stub.
3. **Contact routing** — how `ContactRef.phone`/`handle` maps to a real recipient (phone number for iMessage/WhatsApp) for each restaurant/property manager; produced by the area manager's data entry (root `AGENTS.md`), not by S, but S's adapter needs the mapping confirmed.
4. **If `PHOTON_CHANNEL=whatsapp_business`**: `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` credentials — only needed if that channel is chosen over `imessage`.

### Core wiring integration

The user authorized the required cross-area integration fixes. `_shared.ts` and
`_replySink.ts` delegate to core without pre-marking deliveries seen, so failed
contact lookups remain retryable. The mock route validates input and requires
`ENABLE_MOCK_REPLY=true` plus a manager token. Provider sender IDs resolve through
configured phone/handle values or `PHOTON_CONTACT_MAP` after SDK verification.
J's Next app and workspace dependencies are now present; live Photon delivery and
the webhook request lifecycle still need end-to-end verification. Grok remains a
live-mode stub. The optional protobufjs advisory postinstall is explicitly disabled.
