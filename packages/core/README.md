# Recyclone core backend — Agent I

Implements event intake, classification, manual origin review, scoring, alert state,
manager replies, bin inventories, and API projections. Changes are restricted to
`packages/core/` and `apps/web/app/api/` outside `photon/`.

## Current integration status

The repository contained only the four-agent briefs when this work began. E's
`@recyclone/contracts` TypeScript package, JSON Schema, demo fixtures, and root
workspace manifest were not yet published. S's adapters and J's Next.js app were
also absent. This implementation follows the draft contract README. Do not call
it end-to-end integrated or deployed yet.

All shared event and adapter types are imported from `@recyclone/contracts`.
Private persistence/configuration records live in `src/model.ts`. Exact response
DTOs and the site fixture structure need a final alignment pass when E publishes
v1; see `HANDOFF.md`. No shared contract files were changed by I.

## Setup after E publishes the workspace

From the repository root:

```sh
pnpm install
pnpm --filter @recyclone/core test
pnpm --filter @recyclone/core typecheck
pnpm --filter @recyclone/core exec tsc -p tsconfig.api.json --noEmit
```

The API typecheck also expects J to declare `@recyclone/core` and
`@recyclone/contracts` as dependencies of the web workspace. No root package or
lockfile was edited by I.

For a deployed or multi-process backend, provide `DATABASE_URL` and use the default
`CORE_STORAGE=postgres`. Core runs its idempotent migration on initialization.
The provider's connection string must configure TLS as required by that provider.
The SQL schema is in `migrations/001_core_state.sql`.

Explicit `CONFIG_PROFILE=demo` plus `CORE_STORAGE=memory` allows a single-process
local demo without Postgres. Memory state is lost on restart and must not be used
for distributed/serverless persistence. Normal mode rejects memory storage.

Start Next.js from `apps/web`, or set `RECYCLONE_ROOT` to the absolute repository
root. The default seed/schema paths resolve under that root.

## Variables for E to collect in the root environment example

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres URL; required unless using explicit demo memory storage |
| `WORKER_INGEST_TOKEN` | Required bearer token for `POST /api/events`; unset disables ingest |
| `CONFIG_PROFILE` | `normal` (default) or `demo` |
| `CORE_STORAGE` | `postgres` (default) or `memory` (demo only) |
| `RECYCLONE_ROOT` | Optional absolute repo root, otherwise assumes cwd is `apps/web` |
| `CORE_SITE_CONFIG_PATH` | Optional absolute site JSON path |
| `CORE_EVENT_SCHEMA_PATH` | Optional absolute E-owned event JSON Schema path |
| `CORE_CONFIG_JSON` | Optional JSON overrides of numeric config fields below |
| `MANAGER_API_TOKEN` | Optional bearer token on catalog/review/reset mutations |
| `MESSENGER_MODE` | `mock` (default) or `live`; live requires S's registered adapters |
| `ILLUSTRATOR_MODE` | `mock` (default) or `live`; live requires S's registered adapters |

The shared-manager token is a minimal integration option, not complete role-based
production authentication. API reads follow the draft contract and are currently
unauthenticated. Access control is deployment work still to be completed.

## Provisional configurable parameters

Only the two-day half-life, roughly-five-event normal minimum, separate demo
settings, and 24-hour normal no-response interval reflect user guidance. Other
numbers below are explicit implementation assumptions awaiting confirmation.

| Field | Normal | Demo |
|---|---:|---:|
| `halfLifeMs` | 172800000 | 172800000 |
| `evidenceWindowMs` | 604800000 | 604800000 |
| `minAssessedEvents` | 5 | 2 |
| `correctSortingThreshold` | 80 | 80 |
| `itemConfidence` | 0.7 | 0.7 |
| `businessConfidence` | 0.7 | 0.7 |
| `destinationConfidence` | 0.7 | 0.7 |
| `fullnessThreshold` | 0.8 | 0.8 |
| `followUpMs` | 86400000 | 30000 |
| `illustrationRefreshMs` | 300000 | 5000 |
| `comparisonWindowMs` | 604800000 | 300000 |

The scoring percentage uses all assessed events with exponential time weights.
The minimum-evidence gate counts only assessed events within `evidenceWindowMs`.
An item's metric combines stations and is keyed by item plus attributed business;
unknown business origins cannot generate restaurant-specific alerts.

Exactly one recommendation per item/business is opened until demo reset. A reply
stops the no-response reminder for a matched conversation. Acknowledgement does
not record an intervention. One follow-up is allowed; there is no further reminder
or automatic post-intervention re-alert pending a user decision.

When a business has events across indoor and outdoor stations, the most recent
incorrect event determines the relevant contact role: property manager indoors,
restaurant manager outdoors. This is a documented routing assumption. Missing
role contacts cause the alert to be deferred, not sent to a guessed recipient.

## Seed/configuration shape

`SiteSeed` in `src/model.ts` is the private input format until E freezes the fixture:

- `site_id`.
- `businesses`: `business_id`, `name`, `manager_contact_id`, optional
  `property_manager_contact_id`.
- `contacts`: shared `ContactRef` values.
- `stations`: `station_id`, `name`, `location` (`shared_outdoor` or `in_store`).
- `cameras`: `camera_id`, `station_id`.
- `bins`: `bin_id`, `station_id`, `name`, `type`, `capacity_l`, authoritative
  `camera_id`, optional `emptying_contact_id`, optional `initial_contents_known`.
- `catalog`: `catalog_item_id`, `name`, `business_id` or null,
  `correct_destination`, `reference_photos` URLs, optional `branding_text`,
  `volume_ml` or null, `volume_source`, optional `condition_rule`.

Private examples are in `test/fixtures.ts`; they are synthetic unit-test inputs,
not shared demo data. If E's final site fixture differs, adapt it inside core or
coordinate a contract change with E. Do not silently assume it is compatible.

Reference photos are URL metadata. File upload/storage is not implemented by
these routes. A URL served by the worker or externally hosted image can be used.
Nonempty condition rules remain unassessable until the contract can convey the
necessary observation (such as residue); the model does not guess the condition.

## API surface

All handlers use Node.js runtime and return uncached JSON. Request failures use
`{ "error": "..." }` with 400/401/403/404/409/413/422 as appropriate. Configuration
and unavailable infrastructure failures return 503. Unexpected implementation
errors are not presented as successful empty data.

| Route | Current body/response |
|---|---|
| `POST /api/events` | Shared `DisposalEvent`, or `{events: [...]}`; single receipt or `{events: receipts}`. Each receipt has `event_id`, `status: created/duplicate`. Batch max 100; atomic validation. Worker bearer auth. |
| `GET /api/feed?after=cursor` | `{items, cursor, demo}`. At most 200 entries; cursor advances only through returned entries. Also runs due work. |
| `GET /api/bins` | Array of inventory projections, including illustration snapshot/result and job states. |
| `GET /api/items` | Array of catalog entries with `metrics` (by attributed business) and `interventions` with comparisons. |
| `GET /api/items/:id` | One item projection; 404 for unknown ID. |
| `GET /api/catalog` | Array of catalog entries; reference photos included for worker startup. |
| `POST /api/catalog` | One catalog entry; inserts/replaces by item ID and recomputes events. |
| `GET /api/reviews` | Pending or explicitly unresolved event records, including evidence and candidates in `raw`. |
| `POST /api/reviews/:event_id` | `{business_id: string or null}`; returns updated event record. |
| `GET /api/alerts` | Array of alerts with persisted message history, delivery states and mocked flags. |
| `POST /api/demo/reset` | Clears runtime and restores startup seed; normal mode returns 403. |

I did not create or modify `/api/photon/**`; those routes belong to S.
Feed records and adapter types follow the draft README. Response projection shapes
are provisional until E supplies the promised DTOs and response fixtures.

## Integrations handoff to S

`createCore({seed, config, repository, validateEvent, messenger, illustrator,
interpreter})` injects the three contract adapters. It returns `handleReply` for
S's `ReplySink`, plus the HTTP-facing methods and `tick()`.

The API singleton lives at `apps/web/app/api/_core/runtime.ts`. It exports:

- `configureCoreAdapters({messenger, illustrator, interpreter})`: register S's
  adapters before singleton initialization.
- `getCore()`: obtain the initialized core. The webhook calls
  `(await getCore()).handleReply(normalizedReply)` after verification.

Until S exposes adapter factories, the singleton uses local contract-shaped stubs
only when both modes are `mock`. These stubs explicitly mark outputs mocked.
Setting either mode to `live` without registering adapters fails visibly; it never
silently substitutes a mock. Final automatic mode-based construction of S's real
adapters is pending S's actual exports.

Ambiguous replies are persisted, can produce clarification messages, and cannot
confirm actions. A reply can only modify an open alert belonging to its contact.
Duplicate provider IDs are deduplicated again in core. S must supply the canonical
configured contact ID after verifying the sender; core does not trust a model to
choose the recipient identity.

## Reliability and limits

- Postgres uses a row-locked JSONB aggregate per site. This is deliberately a
  hackathon persistence model, not a high-volume normalized event warehouse.
- External calls run outside DB transactions. Jobs are persisted and claimed
  before sending. Concurrent polls do not claim the same job twice.
- Failed or crash-interrupted sends are not automatically retried; their status
  remains visible for manual reconciliation to avoid duplicate messages. This is
  not an exactly-once delivery guarantee across a provider/network failure.
- Due work is evaluated on intake and feed polling; no cron was added.
- Dispatch is synchronous within the request and bounded to 100 queued jobs.
  Slow live image generation may exceed a serverless request budget. Before
  deploying live mode, move dispatch to a durable external runner or validate
  the hosting budget. `tick()` is the reusable entry point.
- Emptying uses actual `emptiedAt` when provided. Otherwise confirmation receipt
  time is the provisional reset boundary. History is preserved; deposits strictly
  after the boundary remain in inventory. An exact-boundary deposit is treated
  as belonging to the emptied inventory.
- Initial contents are unknown unless declared known or emptying is confirmed.
  Unknown item volumes are counted rather than fabricated.
- Bin illustrations are timestamped inventory snapshots, never measurement input.
  Mismatched or stale generation results are discarded.
- Demo reset refuses in-flight work, restores startup config/catalog, and keeps
  feed cursors monotonic so ongoing polls resume. J should clear its scenes after
  its own successful reset response.

## Verified locally

Behavior tests, direct HTTP-handler tests, strict TypeScript checks, and a real
PostgreSQL SQL engine test using PGlite. No remote database, Photon/Grok live call,
Next.js build, or deployment has been verified.

Because E's package was absent, local checks used a temporary, uncommitted type
harness outside the repository based on the draft README. Schema-injection tests
use a minimal private test schema; they do not certify E's unpublished schema.
Rerun against the real shared package and fixtures before merging or deployment.
