# Agent I handoff / coordination requests

## Ownership

Only `packages/core/**` and `apps/web/app/api/**` outside `photon/**` changed.
Root manifests, lockfiles, `contracts/**`, worker, integrations, and dashboard files
were not edited. This branch started from `e/agents-md-split`; its tree matches
the brief subsequently merged into `main` at `5698a58`.

## E — shared contract / workspace

Read and implemented draft contract sections 0–6. No contract freeze is asserted
while its package, schema, DTOs, and fixtures are absent.

Please publish `@recyclone/contracts` exporting `DisposalEvent`, `Messenger`,
`Illustrator`, `ReplyInterpreter`, `InboundReply`, `OpenAlertSummary`, `ContactRef`,
`BinInventorySnapshot`, and `ReplySink`, plus the shared event JSON Schema.
Publish/freeze the response DTOs and seed shape so I can replace private draft
projections where necessary. See `README.md` for current responses and `SiteSeed`
in `src/model.ts` for the private seed format. No competing fixture was added
under `contracts/`.

Collect core's documented environment variables into your root `.env.example`.
Create the root pnpm workspace; resolve/generate the shared lockfile centrally.

## S — adapters and webhook

Please expose your actual adapter factories or register adapter instances through
`configureCoreAdapters` in `apps/web/app/api/_core/runtime.ts` before `getCore()`.
Then forward verified, normalized replies to `(await getCore()).handleReply()`.
All message/job state, clarification sending, and interpretation invocation stay
inside core. Local stubs are available while your package is absent; live mode
fails without registration.

Contract does not carry a mocked flag on `InboundReply`; do not add undocumented
fields silently. Outbound receipts and images do retain `mocked` as required.
Core now persists ambiguous inbound text as well as confirmations.

## J — dashboard

Declare `@recyclone/core` and `@recyclone/contracts` workspace dependencies in your
web package. Use `transpilePackages` if your Next.js configuration needs it for
workspace TypeScript sources. I did not edit your manifest/configuration.

Current response bodies are tabulated in core's README; align them with E's DTOs
when published. Poll `/api/feed` using its cursor to run lazy work and animate
scenes. `GET /api/alerts` includes messages and delivery state. `GET /api/bins`
includes numeric estimates and timestamped generated/mock illustrations.

After a successful demo reset, clear local scene state. Existing cursors continue
to advance. Demo memory storage is local-only; Vercel requires persistent storage.

## Before merge

1. Publish E's real shared package/schema/fixtures; align and rerun core/API tests.
2. Agree on S's construction exports and complete API singleton wiring.
3. Run J's actual Next.js build and integrated demo with mock adapters.
4. Validate a real Postgres connection, then live APIs where credentials exist.
5. Confirm no concurrent changes under I's paths; stage only the explicit I files.

The implementation intentionally does not commit, push, or merge itself.
