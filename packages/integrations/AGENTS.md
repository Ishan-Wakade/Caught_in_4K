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

## Environment variables

`PHOTON_API_KEY`, `PHOTON_WEBHOOK_SECRET`, `PHOTON_CHANNEL`, `GROK_API_KEY`, `MESSENGER_MODE` (`mock` | `live`), `ILLUSTRATOR_MODE` (`mock` | `live`). Exact Photon/Grok variable names may change once their documentation is checked; update them here.

## Build log

Status as of this scaffold, so nobody mistakes a stub for a working integration:

- **Built and unit-tested (`npm test` in this folder, 16 passing):** `MockMessenger`, `MockIllustrator` (placeholder SVG rendered from the real `BinInventorySnapshot`, linked to its `snapshotId`/`binId`), `RuleBasedReplyInterpreter` (keyword-based; covers confirmed/emptied/acknowledged/unclear and the ambiguous-alert case), `InMemoryReplyDedupeStore`, and the `MESSENGER_MODE`/`ILLUSTRATOR_MODE` config switch in `src/config.ts`. Local types in `src/types.ts` mirror contract §5 until `@recyclone/contracts` exists — replace them with that import once E publishes it.
- **Not implemented — `PhotonMessenger` and `GrokIllustrator` throw by design.** Neither Photon 2.0's send/auth/signature scheme nor Grok Imagine's request shape has been confirmed against real docs. `MESSENGER_MODE=live` / `ILLUSTRATOR_MODE=live` will fail loudly rather than fake a real call. See "Open questions" below for what's needed to finish them.
- **`apps/web/app/api/photon/webhook/route.ts` and `.../mock-reply/route.ts` are written but unverified** — `apps/web` has no `package.json`/Next.js install yet, so these haven't been built or run. `_replySink.ts` is a placeholder that throws until I's `createCore(...)` wiring exists; swap it in per the comment there.
- No root `package.json` / `pnpm-workspace.yaml` exist yet (E's files), so this package is self-contained for now: its own `package.json`, `tsconfig.json`, devDependencies (`typescript`, `vitest`, `@types/node`). Run `npm install && npm test` inside `packages/integrations/` directly. Once E wires the pnpm workspace, re-verify these still resolve as `@recyclone/integrations`.

### Open questions (need a human to supply this; not decidable from the repo)

1. **Photon 2.0 channel and API reference** — which channel (SMS/WhatsApp/Slack/etc.), the actual `send` endpoint, auth header format, and whether it signs webhooks (and how) — needed to replace the `PhotonMessenger` stub and `verifyPhotonSignature` in `apps/web/app/api/photon/_shared.ts`.
2. **Photon's inbound webhook payload shape** — `normalizePhotonWebhookPayload` in `_shared.ts` currently guesses common field names (`message_id`/`id`, `from.contact_id`, `text`/`body`, `received_at`/`timestamp`). Needs checking against Photon's real webhook payload.
3. **Grok Imagine API reference** — endpoint, auth, request/response shape — needed to replace the `GrokIllustrator` stub.
4. **Credentials** — `PHOTON_API_KEY`, `PHOTON_WEBHOOK_SECRET`, `PHOTON_CHANNEL`, `GROK_API_KEY` for whichever accounts the team is using, or confirmation that the demo will run mock-only.
5. **Contact routing** — how `ContactRef.contactId` maps to a real Photon recipient (phone number, handle, etc.) for each restaurant/property manager; this is produced by the area manager's data entry (root `AGENTS.md`), not by S, but S's adapter needs the mapping's shape confirmed.
