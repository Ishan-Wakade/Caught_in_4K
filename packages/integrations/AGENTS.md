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
