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

`PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET` (Spectrum project credentials), `PHOTON_CHANNEL` (`imessage` | `whatsapp_business`), `PHOTON_WEBHOOK_SECRET` (verifies inbound `X-Spectrum-Signature`), `MESSENGER_MODE` (`mock` | `live`). If `PHOTON_CHANNEL=whatsapp_business`: `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, optional `WHATSAPP_APP_SECRET`. Separately: `GROK_API_KEY`, `ILLUSTRATOR_MODE` (`mock` | `live`).

## Build log

Status as of this scaffold, so nobody mistakes a stub for a working integration:

- **Built and unit-tested (`npm test` in this folder, 16 passing):** `MockMessenger`, `MockIllustrator` (placeholder SVG rendered from the real `BinInventorySnapshot`, linked to its `snapshotId`/`binId`), `RuleBasedReplyInterpreter` (keyword-based; covers confirmed/emptied/acknowledged/unclear and the ambiguous-alert case), `InMemoryReplyDedupeStore`, and the `MESSENGER_MODE`/`ILLUSTRATOR_MODE` config switch in `src/config.ts`. Local types in `src/types.ts` mirror contract §5 until `@recyclone/contracts` exists — replace them with that import once E publishes it.
- **`PhotonMessenger` is implemented against the real `spectrum-ts` types** (installed as a dependency; typechecks clean against its actual `.d.ts`, see `src/messenger/photonApp.ts` and `photon.ts`). **Not yet run against a real Photon project** — no credentials exist to test with, so this is unverified, not working. `providerMessageId`/`sentAt` come straight off the real `Message.id`/`.timestamp`, no guessing needed there.
- **`apps/web/app/api/photon/webhook/route.ts` now delegates to `app.webhook(request, handler)`** instead of hand-rolled signature/payload parsing — the SDK does verification and normalization. Uses Next's `after()` to keep `handleReply` work alive past the response (the SDK's own handler is fire-and-forget on serverless; confirm `after()` is available once apps/web's Next version is chosen — needs Next 15+). Still unverified end-to-end since `apps/web` has no Next.js install yet. `_replySink.ts` is a placeholder that throws until I's `createCore(...)` wiring exists.
- **`GrokIllustrator` is still a stub that throws** — Grok Imagine's API hasn't been checked yet.
- No root `package.json` / `pnpm-workspace.yaml` exist yet (E's files), so this package is self-contained for now: its own `package.json`, `tsconfig.json`, deps (`spectrum-ts`) and devDependencies (`typescript`, `vitest`, `@types/node`). Run `npm install && npm test` inside `packages/integrations/` directly. Once E wires the pnpm workspace, re-verify these still resolve as `@recyclone/integrations`.

### Open questions (need a human to supply this; not decidable from the repo)

1. **Confirm the channel.** This code defaults to `imessage` because that's what the quickstart docs happened to show — the team needs to actually decide (`imessage` vs `whatsapp_business` vs another provider) and confirm iMessage really needs no extra per-channel config beyond the project credentials (as the quickstart's zero-arg `imessage.config()` implies).
2. **Credentials** — `PHOTON_PROJECT_ID`, `PHOTON_PROJECT_SECRET`, `PHOTON_WEBHOOK_SECRET`, and (if WhatsApp) `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` — or confirmation the demo stays mock-only.
3. **Grok Imagine API reference** — endpoint, auth, request/response shape — needed to replace the `GrokIllustrator` stub.
4. **Contact routing** — how `ContactRef.phone`/`handle` maps to a real recipient (phone number for iMessage/WhatsApp) for each restaurant/property manager; produced by the area manager's data entry (root `AGENTS.md`), not by S, but S's adapter needs the mapping confirmed.
5. **A webhook URL registered with Photon** once `apps/web` is deployed (or tunneled locally) — needed before any real inbound reply can reach `/api/photon/webhook`.
