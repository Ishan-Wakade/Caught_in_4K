# Agent I handoff — after E's contracts landed

## Completed against E's real package

- Shared Zod event/site/catalog validation; nullable unknown confidences supported.
- Direct shared `DemoSite`, `CatalogItem`, feed, bin, item, alert/message and review types.
- API response field names and shapes match E's actual schemas, with exact-schema tests.
- All 11 synthetic events replay through core, including one uncertain-origin review,
  unattributed generic items, two unassessable cases, correct/incorrect sorting,
  recommendation and fullness alerts, follow-up, confirmation, and bin reset.
- E's preset initial bin volumes and selected config profile are applied.
- Normal null thresholds remain disabled; no silent demo defaults.
- Real PostgreSQL concurrency, duplicate handling, rollback and API restart persistence
  tested in an isolated PostgreSQL 16 container. Fixed JSONB key-order comparison.
- No temporary types or fixture copies under `contracts/`. No E/S/J files edited.

## Verification

Core tests (with CORE_TEST_DATABASE_URL): 34 passed, none skipped. Core and I-owned
API TypeScript checks passed. E's contract suite: 55 passed, and both contract
TypeScript modes passed. See README for repeatable commands.

The network test database was disposable. These results do not verify the eventual
hosted database, live Photon/Grok, a Next.js build, deployment, or footage-driven CV.

## S — remaining integration

The S implementation is not present on main as of base `c67d66d`. Please expose
actual adapter constructors/factories and replace the webhook ReplySink placeholder
with `(await getCore()).handleReply(normalizedReply)` using I's runtime module.
I will wire mode-based construction once your package is available. Construction
must happen within each server instance, not depend on the webhook running first.

The current runtime can accept injected adapters and has explicitly mocked local
stubs. Live modes fail until configured. A shared InboundReply has no mocked flag;
core uses an explicit construction option to label inbound mock conversations.

## J — remaining web integration

Declare `@recyclone/core` and `@recyclone/contracts` workspace dependencies in the
web package. Configure workspace TypeScript transpilation as needed. Run the actual
Next.js build when the app lands; core does not edit your manifest/configuration.

Use the real shared response fields (`next_cursor`, `estimated_volume_l`,
`correct_sorting_pct`, `assessed_count`, etc.). The backend now returns those shapes.
`GET /api/feed` polling drives lazy work. Clear local scenes after demo reset.
Use persistent storage on Vercel; memory mode is single-process only.

Keep the illustrative/estimated labels and observational before/after copy. Labeled
backup input is named in disposal feed summaries. FeedItem has no mocked flag;
message/image projections do, and mocked feed summaries are labeled in text.

## E — small remaining coordination requests

- I read and built against the published shared package; no contract edits requested
  for current outdoor demo behavior. Contract freeze still needs other owners.
- The shared station shape has no indoor/outdoor scope. Until a contract change adds
  it, core supports `CORE_CONFIG_JSON.stationLocations` overrides for indoor routing.
- Collect `CORE_STORAGE`, `RECYCLONE_ROOT`, `CORE_SITE_CONFIG_PATH`, and
  `CORE_CONFIG_JSON` into the root environment example when convenient. The old
  `CORE_EVENT_SCHEMA_PATH` is retired because intake imports the shared Zod schema.
- The shared alert DTO has no delivery-error or pending-job fields; core keeps those
  internally and signals failed/uncertain delivery in an open alert's trigger text.
  Add structured delivery status later through a contract change if the UI needs it.

## Ownership / merge safety

Changes are only in `packages/core/**` and I-owned API routes; no root manifest,
lockfile, contract, worker, integrations or dashboard changes. No commit, push or
merge is performed by this implementation turn.
