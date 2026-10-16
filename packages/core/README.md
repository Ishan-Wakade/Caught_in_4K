# Recyclone core backend — Agent I

Core implements disposal-event intake, classification, origin review, time-weighted
scoring, alert/reply state, estimated bin inventories, and API projections. I owns
`packages/core/**` and `apps/web/app/api/**` outside `photon/**`.

## Current status

Aligned to E's shared package from `e/contracts`, merged at `c67d66d`:

- Event validation uses the real `DisposalEventSchema`; unknown item/business
  confidences can be null. No temporary contract harness is needed.
- Site configuration and catalog entries use `DemoSite` and `CatalogItem` directly.
- API projections use E's `FeedResponse`, `BinSummary`, `ItemSummary`, `ItemDetail`,
  `AlertSummary`, `AlertMessage`, and `ReviewItem` types.
- Tests run E's entire synthetic-event fixture through core and assert exact
  schema-compatible dashboard response bodies.
- API runtime loads E's demo site and its config profiles, including initial bin
  volumes and nullable/unconfigured normal alert thresholds.
- Persistence has been exercised against both embedded PostgreSQL and an isolated
  network PostgreSQL 16 server, including concurrent duplicate intake, rollback,
  and reinitializing the API singleton without losing events.

S's integration implementation and J's runnable Next.js app are not yet present
on the main branch used for this change. Real adapter construction, webhook
wiring, Next.js build, and deployed/live demo verification remain pending. This
is backend/contract verification, not a claim of full application completion.

## Install and verify

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @recyclone/core test
pnpm --filter @recyclone/core typecheck
pnpm --filter @recyclone/core exec tsc -p tsconfig.api.json --noEmit
pnpm --filter @recyclone/contracts test
pnpm --filter @recyclone/contracts typecheck
```

The core tsconfig points test-time package resolution at the actual workspace
sources. It does not contain replacement types. J still needs to declare the core
and contracts workspace dependencies in the web package for Next.js builds.

Network database tests are optional in the ordinary suite. To exercise them,
point the following variable at a disposable PostgreSQL database:

```sh
CORE_TEST_DATABASE_URL='postgresql://user:password@localhost:5432/test_database' \
  pnpm --filter @recyclone/core test
```

Network tests create unique site IDs and delete only their own state rows. Do not
point test commands at a database where the test user should not run migrations.

## Runtime configuration

The API singleton is `apps/web/app/api/_core/runtime.ts`. It finds the repository
by walking up from cwd to `contracts/fixtures/demo-site.json`, or uses an explicit
`RECYCLONE_ROOT`. A custom site file must satisfy E's `DemoSiteSchema` and integrity
checks.

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Persistent PostgreSQL URL; configure provider-required TLS in the URL |
| `WORKER_INGEST_TOKEN` | Required worker bearer token; missing token disables intake |
| `CONFIG_PROFILE` | `normal` (default) or `demo` |
| `CORE_STORAGE` | `postgres` (default); `memory` is permitted only in explicit demo mode |
| `RECYCLONE_ROOT` | Optional absolute repository root |
| `CORE_SITE_CONFIG_PATH` | Optional absolute shared-format site JSON path |
| `CORE_CONFIG_JSON` | Optional JSON overrides using internal `CoreConfig` field names |
| `MANAGER_API_TOKEN` | Optional bearer token protecting catalog/review/reset writes; set before deploying |
| `MESSENGER_MODE` | `mock` (default) or `live`; live requires S's configured adapters |
| `ILLUSTRATOR_MODE` | `mock` (default) or `live`; live requires S's configured adapters |
| `CORE_TEST_DATABASE_URL` | Tests only: isolated PostgreSQL connection |

`CORE_EVENT_SCHEMA_PATH` is retired. Intake imports E's Zod schema directly;
E's generated draft-2020-12 JSON Schema remains the Python worker's validator.
Core tests also run E's published cross-language parity cases.

Memory storage is single-process and nonpersistent. It is not suitable for a
multi-instance Vercel deployment. Persistent state uses an idempotent SQL migration
in `migrations/001_core_state.sql`.

The manager token is not a complete role/authentication system. API reads currently
follow the draft contract without authentication; deployment access control remains
an integration concern. Never expose secrets via `NEXT_PUBLIC_` variables.

## Profile semantics

The API converts the selected shared `config_profiles` entry into runtime units.
E's fixture values marked `provisional` remain assumptions, not user decisions.

Current demo fixture values: 1-hour half-life, 60% correct-sorting threshold, three
recent assessed events within one hour, two-minute follow-up, 80% fullness alert,
item confidence 0.5, and business confidence 0.6.

Current normal fixture values: 48-hour half-life, minimum five events, 24-hour
follow-up, item confidence 0.5, business confidence 0.6. Correct-sorting and fullness
thresholds are null, so those normal-use alerts are disabled until configured.
A null evidence window explicitly means no recency cutoff; it is not silently
replaced with a demo window.

`CORE_CONFIG_JSON` may override those values. `destinationConfidence` (default 0.7),
`illustrationRefreshMs` (demo 5000 / normal 300000), and `comparisonWindowMs` (demo
300000 / normal 604800000) are core-only provisional assumptions because E's profile
schema does not define them. `configFor()` supplies standalone development defaults;
API initialization always overlays E's selected profile through `configFromSite()`.

An item's displayed score combines assessed events across stations. Generic items
include unattributed assessed events in their item-wide score. Restaurant-specific
alert eligibility uses only that business's attributed events. An unknown source
is never treated as evidence for a particular restaurant.

Exactly one recommendation per item/business is opened until demo reset. A matched
reply stops the no-response reminder. An acknowledgement does not record an
intervention. Only one follow-up is allowed. Re-alerting after an intervention and
further reminders remain user decisions.

## Contacts and review

Contacts come from shared `contacts` records, mapped to `ContactRef` for adapters.
Restaurant managers are selected by role and business ID. Bin-emptying requests
use the bin's explicit `emptying_contact_id`. Ambiguous or missing recipients are
not guessed.

The shared station schema does not yet encode indoor/outdoor routing. Until E adds
that field, core's `stationLocations` override maps station IDs to `in_store` or
`shared_outdoor`. Unspecified stations use the outdoor demo setting. In-store
recommendations require a matching property manager, or one unambiguous global
property manager. Example override:

```json
{"stationLocations":{"station_inside":"in_store"}}
```

Following contract section 6:

1. A confidently identified catalog item's source business wins.
2. Otherwise, a sufficiently confident known business guess may establish origin.
3. A non-null but insufficient business guess goes to manual review.
4. No business evidence leaves the event unattributed; it still contributes to an
   identifiable item's score, but is not put in the review queue or sent to a restaurant.

Catalog item rules use `destination`, not the old private `correct_destination`.
Reference photos are URLs; uploading/storing image files is not implemented here.
A nonempty `condition_rule` remains unassessable until the event contract supplies
observations needed to evaluate it (such as residue).

## HTTP surface

All I-owned routes use the Node.js runtime. JSON responses are uncached.

| Route | Body / response |
|---|---|
| `POST /api/events` | Shared event or `{events: [...]}` (1–100); receipt or `{events: receipts}` with `event_id` and `created`/`duplicate`. Worker bearer auth. |
| `GET /api/feed?after=cursor` | E's `FeedResponse`: `{items, next_cursor}`; max 200 items, strictly advancing string cursor. Also evaluates due work. |
| `GET /api/bins` | `BinSummary[]`: volume in litres, numeric fullness, observed/unknown counts, last emptying, flattened illustration metadata. |
| `GET /api/items` | `ItemSummary[]`: `correct_sorting_pct`, `status`, `assessed_count`, `by_station`. |
| `GET /api/items/:id` | `ItemDetail` with before/after periods on interventions. |
| `GET /api/catalog` | Shared `CatalogItem[]`, including reference photos for worker startup. |
| `POST /api/catalog` | One shared `CatalogItem`; insert/replace and recompute classifications. |
| `GET /api/reviews` | Pending or left-unresolved `ReviewItem[]`, with raw guesses and evidence. |
| `POST /api/reviews/:event_id` | `{business_id: string or null}`; updated shared `ReviewItem`. |
| `GET /api/alerts` | Shared `AlertSummary[]`, including contact ID, trigger, state and typed message history. |
| `POST /api/demo/reset` | `{status: "reset"}`; disabled in normal mode. |

An item with observations but too little recent evidence has status
`insufficient_data` while retaining its percentage. No assessed observations means
a null percentage. Sent messages, acknowledgements, interventions, and emptied
states map to E's state vocabulary. Inbound messages have `kind: "reply"`.
Failed/uncertain deliveries remain open and append a reconciliation note to the
trigger; they are not represented as successfully sent messages.

Labeled backup events identify themselves in disposal feed summaries. Mocked
outbound messages/images preserve their flags; mocked feed activity is identified
in its summary because E's FeedItem has no mocked field. UI copy must label images
illustrative and before/after changes observational.

## Integration handoff to S

`createCore({ seed, config, repository, messenger, illustrator, interpreter })`
returns `handleReply` (the shared ReplySink), API methods, `tick()`, and `close()`.
The optional clock supports deterministic timing checks. Input validation defaults
to E's real schema.

The API runtime exports `configureCoreAdapters({messenger, illustrator,
interpreter})` and `getCore()`. Adapter construction still needs to be wired when
S's module lands on main. Call `configureCoreAdapters` before singleton creation,
then forward verified replies to `(await getCore()).handleReply(reply)`. Final
wiring must construct adapters within each server instance; it cannot rely on a
webhook initializing a different serverless process first.

For now, both modes must be `mock` to use local contract-shaped stubs. A live mode
without adapters fails visibly. Core controls when to send, calls the injected
interpreter, and sends clarifications. Duplicate provider reply IDs are deduplicated
again in core.

`inboundRepliesMocked` is an explicit core construction option because the shared
InboundReply has no source-mode flag. Runtime derives it from messenger mode.
Do not silently add fields to the shared reply payload.

## Persistence and operational limits

- PostgreSQL stores a row-locked JSONB aggregate per site. This is a hackathon
  implementation, not a high-volume normalized event store.
- Configuration comparison is structural; JSONB key reordering does not break
  initialization. Changed/legacy configuration still requires an explicit migration
  or separate site/database. No existing state is silently overwritten.
- Jobs are persisted and claimed before external calls. Concurrent polls cannot
  claim the same job. Failed/crash-interrupted sends are not automatically retried,
  avoiding unintentional duplicate messages; reconcile them manually.
- Due work runs lazily on ingest and feed polling. Dispatch currently runs within
  requests, capped at 100 jobs. Slow live generation needs a durable runner or a
  validated serverless runtime budget before deployment.
- Bin inventory includes `initial_volume_l` until the first confirmed emptying.
  It is an onboarding estimate, with no invented item count. Unknown deposits add
  to `unknown_count` without invented volume.
- Emptying resets only that bin. An explicit actual emptying time preserves later
  deposits; otherwise receipt time is the provisional boundary. An exact-boundary
  deposit belongs to the emptied inventory. All historical scores/events remain.
- Images are timestamped inventory snapshots, never inputs to the fullness formula.
  Mismatched or obsolete results are discarded.
- Reset reloads startup configuration/catalog and initial volumes, preserves monotonic
  cursor numbering, and refuses in-flight work. J should clear scenes on success.
