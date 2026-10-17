# Contracts (v1 draft) — owned by E

## Using the package

```ts
import { DisposalEventSchema, type BinSummary, type Messenger } from "@recyclone/contracts"; // browser-safe
import { makeEventId } from "@recyclone/contracts/event-id";                         // Node only
```

Add `"@recyclone/contracts": "workspace:*"` to your package's dependencies (Next.js also needs `transpilePackages: ["@recyclone/contracts"]`). Relative imports inside the package end in `.js`, so it type-checks under both `bundler` (Next.js) and `NodeNext` (core) resolution; `pnpm typecheck` checks both. The package ships TypeScript source, with no build step. Zod schemas in `src/` are the source of truth; types come from `z.infer`.

| Command (from repo root) | What it does |
|---|---|
| `pnpm --filter @recyclone/contracts test` | Schemas, fixtures, and integrity tests |
| `pnpm --filter @recyclone/contracts gen:schema` | Regenerate `disposal-event.schema.json` after editing `src/event.ts` (a test fails if you forget) |
| `pnpm --filter @recyclone/contracts check:python` | Python validates the synthetic events against the JSON Schema and recomputes event IDs (needs `uv`) |

This folder is the only interface shared between the four areas. Everyone builds against it; nobody builds against another area's internals. **Status: draft.** It becomes frozen v1 once E, I, S, and J have each read it. After that, changes go through a contract-only PR (see root `AGENTS.md`).

Files:

| File | Purpose | Status |
|---|---|---|
| `README.md` | Payload shapes, endpoints, interfaces (this file) | draft |
| `src/` | Zod schemas and types: `event.ts`, `site.ts`, `api.ts`, `interfaces.ts`; `event-id.ts` (Node only) | written |
| `fixtures/demo-site.json` | Site, businesses, contacts, stations, cameras, bin regions, bins, catalog, normal/demo config profiles. Values listed under `provisional` are placeholders. | written |
| `fixtures/demo-events.jsonl` | Hand-labeled disposal events for the demo clip, in the exact `DisposalEvent` shape. Used for development by I/S/J, for evaluating the worker, and as a stage backup input. | to be written by E after footage exists |
| `fixtures/feed-sample.json` | Sample responses for `/api/feed`, `/api/bins`, `/api/items`, `/api/items/:id` (`item_detail`), `/api/alerts`, `/api/reviews`, `/api/catalog` telling the whole demo story, so J can build before the backend exists | written |
| `fixtures/synthetic-events.jsonl` | 11 synthetic `DisposalEvent`s (`mode: "labeled"`) covering correct, repeated-wrong, bin-filling (the first clamshell takes the trash bin past the demo threshold), uncertain-origin, and both unassessable cases. Tests check that these fixtures follow §6 and the fullness formula, so I can build before the worker exists. Not real footage. | written |
| `fixtures/event-id-vectors.json` | Known inputs → `event_id`, checked by both TypeScript and Python | written |
| `fixtures/parity-cases.json` | Valid and invalid events that Zod and the JSON Schema must judge the same way | written |
| `package.json` + `src/index.ts` | Workspace package `@recyclone/contracts`, imported by core, integrations, and web. Nobody copies these types. | written |
| `disposal-event.schema.json` | JSON Schema (draft 2020-12) for `DisposalEvent`, generated from Zod. The Python worker validates its output against it; it rejects unknown fields, while Zod strips them. | generated |

All timestamps are ISO-8601 UTC strings. All IDs are strings.

## 0. Catalog entry (in `demo-site.json`, maintained by the area manager)

Each catalog item has: a stable `catalog_item_id` and human-readable `name`; a source `business_id`; reference photos and visible branding/text; the correct destination under the site's rules (`trash` | `recycling` | `compost`); any explicitly configured condition-dependent rule; and an approximate `volume_ml` for fullness estimation, with `volume_source` recording where that number came from or that it is an assumption. Bins carry `bin_id`, `station_id`, `type`, `capacity_l`, `initial_volume_l` (estimated contents when monitoring starts; an onboarding assumption), the authoritative `camera_id`, and `emptying_contact_id`.

## 1. DisposalEvent (worker → core)

The worker sends one event per item that entered a bin. It never sends correctness; core decides that from the catalog rule.

```json
{
  "event_id": "evt_3f9a1c2b7d10e4a5",
  "source": {
    "camera_id": "cam_patio_1",
    "clip_id": "clip_demo_v1",
    "track_id": 17,
    "mode": "recorded"
  },
  "bin_id": "bin_patio_trash",
  "occurred_at": "2026-10-17T15:02:41.300Z",
  "clip_offset_s": 41.3,
  "destination_confidence": 0.92,
  "item": {
    "catalog_item_id": "item_beanco_cup",
    "label": "paper coffee cup",
    "confidence": 0.81,
    "candidates": [
      { "catalog_item_id": "item_beanco_cup", "score": 0.81 },
      { "catalog_item_id": "item_generic_cup", "score": 0.12 }
    ]
  },
  "business": {
    "business_id": "biz_beanco",
    "confidence": 0.74,
    "basis": ["logo_text", "reference_match"]
  },
  "evidence": [
    { "kind": "crop", "uri": "evidence/clip_demo_v1/17_entry.jpg", "frame": 1239 }
  ]
}
```

Rules:

- `event_id` is deterministic: `"evt_"` + the first 16 hex characters of sha256(`"{camera_id}|{clip_id}|{track_id}|{bin_id}"`), with `track_id` as a base-10 integer (`makeEventId`; vectors in `fixtures/event-id-vectors.json`). Reprocessing the same clip produces the same IDs, and core treats a repeated `event_id` as the same event (idempotent upsert). For a future live camera, `clip_id` becomes a stream session ID.
- `source.mode` is `"recorded"` or `"live"`; `"labeled"` marks events from `demo-events.jsonl` so the dashboard can show that the backup input is in use.
- `item.catalog_item_id` and `business.business_id` may be `null` (unknown); their `confidence` is then `null` too, never a made-up `0`. `item.label` is the detector's free-text guess and is never used for scoring.
- `track_id` must be a JSON integer. Trackers often return floats (`17.0`); convert with `int()` before hashing, because `"17.0"` and `"17"` hash differently.
- Serialize with `json.dumps(..., allow_nan=False)`. `NaN`/`Infinity` are not JSON, so core rejects the whole request.
- Cross-field rules, enforced identically by Zod (`checkEventInvariants`) and the JSON Schema (`allOf`): `recorded` events need `clip_offset_s`, and `live` events must have `clip_offset_s: null`. `fixtures/parity-cases.json` checks that both validators agree. Candidate order and membership are not checked, so hand-labeled events may set `catalog_item_id` with empty `candidates`.
- `destination_confidence` is the confidence that the item actually entered `bin_id`. The worker does not send events for items only seen near a bin or in a hand.
- `evidence[].uri` is relative to the worker's evidence directory; the worker serves it (see §4).

## 2. HTTP API (owned by I, served from `apps/web/app/api/`)

| Method | Path | Caller | Purpose |
|---|---|---|---|
| POST | `/api/events` | worker | Ingest one `DisposalEvent` (or `{ "events": [...] }`). Returns `{ "event_id", "status": "created" \| "duplicate" }`. Auth: `Authorization: Bearer $WORKER_INGEST_TOKEN`. |
| GET | `/api/feed?after=<cursor>` | web | Ordered timeline for scene switching (§3). |
| GET | `/api/bins` | web | Every bin: estimated fullness, observed counts, unknown-content count, latest illustration, last confirmed emptying. |
| GET | `/api/items` and `/api/items/:id` | web | Correct-sorting percentage (or `insufficient_data`), assessed-event count, station breakdown, interventions with before/after periods. |
| GET/POST | `/api/catalog` | web | Catalog maintenance. |
| GET | `/api/reviews`, POST `/api/reviews/:event_id` | web | Review queue; assign a business or leave unresolved. |
| GET | `/api/alerts` | web | Alerts with message history and state. |
| POST | `/api/demo/reset` | web | Demo only: clear runtime state and reload `demo-site.json`. Disabled outside demo profile. |
| POST | `/api/photon/webhook` | Photon | Inbound replies (owned by S). |

Exact response bodies are the schemas in `src/api.ts`, with samples in `fixtures/feed-sample.json`; I implements them. `correct_sorting_pct` is `null` only when there are no assessed events, and an item with too little evidence to alert on has status `insufficient_data` but may still have a percentage. Responses that include messages or illustrations carry their `mocked` flag through to the web app.

## 3. Feed items (core → web)

```json
{
  "cursor": "000123",
  "at": "2026-10-17T15:02:41.300Z",
  "type": "disposal | alert_opened | message_sent | reply_received | intervention_recorded | bin_emptied | illustration_ready | review_queued | review_resolved",
  "ref": { "event_id": "...", "alert_id": "...", "bin_id": "...", "item_id": "..." },
  "summary": "Bean Co. cup → Trash (incorrect)",
  "demo": true
}
```

The web app switches scenes based on `type` (rules in `apps/web/AGENTS.md`). `demo: true` whenever the demo configuration profile is active.

## 4. Worker stream (worker → web Live scene)

- `GET http://localhost:$WORKER_PORT/stream.mjpg`: annotated footage (detections, track IDs, bin regions, "entered bin" flashes).
- `GET http://localhost:$WORKER_PORT/evidence/<path>`: evidence crops.
- The web app reads the base URL from `NEXT_PUBLIC_WORKER_URL`. The demo runs on the laptop that runs the worker.

## 5. Core ↔ integrations interfaces (TypeScript)

Core decides when to message and what state changes; integrations only move messages and images and interpret reply text.

```ts
// Implemented by S in packages/integrations; called by I in packages/core.
export interface Messenger {
  send(msg: { to: ContactRef; body: string; alertId: string; kind: "recommendation" | "follow_up" | "emptying_request" | "clarification" }):
    Promise<{ providerMessageId: string; sentAt: string; mocked: boolean }>;
}

export interface Illustrator {
  illustrate(snapshot: BinInventorySnapshot):
    Promise<{ imageUrl: string; generatedAt: string; snapshotId: string; mocked: boolean }>;
}

export interface ReplyInterpreter {
  interpret(reply: InboundReply, openAlerts: OpenAlertSummary[]):
    Promise<{ alertId: string | null; intent: "action_confirmed" | "bin_emptied" | "acknowledged" | "unclear"; emptiedAt?: string }>;
}

// Implemented by I in packages/core; called by S's webhook route after de-duplicating by providerMessageId.
export interface ReplySink {
  handleReply(reply: InboundReply): Promise<{ status: "applied" | "duplicate" | "needs_clarification" }>;
}

export type ContactRef = { contactId: string; phone?: string; handle?: string };
export type InboundReply = { providerMessageId: string; from: ContactRef; body: string; receivedAt: string };
export type OpenAlertSummary = { alertId: string; kind: "recommendation" | "emptying"; itemName?: string; binName?: string; sentAt: string };
export type BinInventorySnapshot = {
  snapshotId: string; binId: string; binType: "trash" | "recycling" | "compost";
  takenAt: string; estimatedFullness: number;
  items: { name: string; count: number }[]; unknownCount: number;
};
```

Every implementation returns `mocked: true` when it is the mock, so the dashboard can label it. In `/api/alerts`, inbound manager messages have `kind: "reply"`.

## 6. Cross-area rules (E's calls, not user decisions)

These settle the places where two areas meet. Change them only through a contract PR.

**Business attribution.** The worker always sends raw candidates and confidences and never applies thresholds; it sends `null` only when it has no candidate at all. One exception, for choosing *which evidence* to report: when no registered product matches at or above the profile's `item_confidence_threshold`, the worker reports a **generic category** instead (catalog items with `business_id: null`, e.g. `item_generic_wrapper`). It sets `item.label` to the matched description and `item.confidence` to the classifier's probability, and keeps the weak product matches in `candidates`. Core then applies the same threshold and the category's bin rule as for any item. Core alone applies thresholds, in this order:
1. If the item is identified (`catalog_item_id` at or above core's item threshold) and that catalog item has a `business_id`, the catalog's business wins.
2. Otherwise, if the event's own `business` is at or above core's business threshold (e.g. from a logo on generic-looking packaging), use it.
3. Otherwise, if the event has a business guess below the threshold, the origin is uncertain → review queue (scenario 4). Example: an unbranded cup with a faint logo match.
4. Otherwise (no business evidence at all) the event is unattributed. It still counts toward the item's sorting score, but it is not queued for review and no restaurant gets a recommendation for it.
An item below the item threshold, or with no candidate at all, is unassessable (scenario 5). Generic catalog items (an unbranded can or cup) have `business_id: null`, so they reach rule 2, 3, or 4.

**Event time.** For recorded footage, `occurred_at` = the wall-clock time when the worker started the clip + `clip_offset_s`, so a live demo run produces timestamps in real time. Scoring, follow-ups, and before/after windows all use `occurred_at`.

**Switching to the backup input.** Hand-labeled events use their label row number as `track_id`, so their `event_id`s differ from the worker's. Switching to the backup therefore always starts with `POST /api/demo/reset`; the two inputs are never mixed in one run.

**Catalog source.** Core's database is the source of truth. The worker loads the catalog from `GET /api/catalog` at startup, which includes reference photo URLs, and falls back to `fixtures/demo-site.json` when the API is unreachable. Edits made in the dashboard reach the worker on its next start. Photo storage is I's choice.

**Reply flow.** S's webhook route verifies, de-duplicates by `providerMessageId`, normalizes, and calls `ReplySink.handleReply` (core). Inside `handleReply`, core calls `ReplyInterpreter.interpret` with its open alerts, applies the state change, and, when the result is `unclear`, sends the clarification itself through `Messenger`. Core is constructed with its adapters injected (`createCore({ messenger, illustrator, interpreter })`); I wires real or mock adapters in a module under `apps/web/app/api/` based on `MESSENGER_MODE` / `ILLUSTRATOR_MODE`.

**Mock manager replies.** `POST /api/photon/mock-reply` (owned by S) accepts `{ contactId, body }` and enters exactly the same path as the webhook. J shows a "reply as manager (mocked)" box in the Messages scene only when the messenger is mocked.

**Time-driven work (follow-ups, illustration refresh).** No cron is needed for the demo. Core evaluates due work lazily on every event ingest and every `/api/feed` request; the dashboard polls `/api/feed` about once per second while open. A production deployment would add a scheduled trigger that calls the same evaluation.
