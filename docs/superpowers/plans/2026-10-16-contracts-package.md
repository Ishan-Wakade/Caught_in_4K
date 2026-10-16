# Contracts Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `@recyclone/contracts` so I, S, and J can build against real types, a validated JSON Schema, and sample data before any other area exists.

**Architecture:** Zod schemas are the single source of truth. TypeScript types come from `z.infer`, and the JSON Schema the Python worker uses is generated from the same Zod schema. A drift test fails if the committed schema file falls out of date. The package ships TypeScript source with no build step: Next.js consumes it with `transpilePackages`, and Vitest runs it directly. Node-only code (the event ID hash) lives behind a subpath export so browser bundles never pull in `node:crypto`.

**Tech Stack:** pnpm 12 workspaces, TypeScript 7, Zod 4 (`z.toJSONSchema`), Vitest 5, tsx (scripts), Python 3 + `jsonschema` through `uv run --with` (cross-language check).

**Spec:** `contracts/README.md` (§0–§6) and the root `AGENTS.md` (ownership, demo scenarios).

## Global Constraints

- Work on branch `e/contracts`, created from `e/agents-md-split` (that branch holds the spec). **Do not commit without Eymen's explicit go-ahead.** Each "Commit" step below means: show the diff summary and ask.
- E owns only `contracts/` and the root workspace files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`). Touch nothing else.
- All timestamps are ISO-8601 UTC with an offset or `Z`; all IDs are strings except `track_id` (integer).
- `event_id` = `"evt_" + first 16 hex chars of sha256("{camera_id}|{clip_id}|{track_id}|{bin_id}")`, with `track_id` written as a base-10 integer.
- Destinations and bin types are exactly `trash | recycling | compost`. `source.mode` is exactly `recorded | live | labeled`.
- Values the user has not decided (thresholds, demo numbers) are listed in the profile's `provisional` array, never presented as decisions.

## Review Focus

1. **Web imports `@recyclone/contracts` in a client component.** It must not pull `node:crypto`. Test: `src/index.ts` and everything it imports contain no `node:` import (Task 1).
2. **Python and TS hash differently**, for example `track_id` 0 or a float-looking value. Test: shared vectors including `track_id: 0` checked in both languages (Tasks 1 and 4).
3. **A timestamp without a timezone** (`2026-10-17T15:02:41`) is accepted and silently read as local time. Test: the schema rejects it (Task 1).
4. **A confidence out of range or NaN** (`1.2`, `-0.1`, `NaN`). Test: the schema rejects each (Task 1).
5. **The committed JSON Schema drifts from Zod** after someone edits a type. Test: generated output equals the committed file (Task 4).

---

### Task 1: Workspace + DisposalEvent schema + event ID

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` (root)
- Create: `contracts/package.json`, `contracts/tsconfig.json`, `contracts/vitest.config.ts`
- Create: `contracts/src/event.ts`, `contracts/src/event-id.ts`, `contracts/src/index.ts`
- Create: `contracts/fixtures/event-id-vectors.json`
- Test: `contracts/test/event.test.ts`, `contracts/test/event-id.test.ts`, `contracts/test/browser-safe.test.ts`

**Interfaces:**
- Produces: `DisposalEventSchema` (Zod) and `type DisposalEvent`; `EventSourceSchema`, `ItemGuessSchema`, `BusinessGuessSchema`, `EvidenceSchema`; `Destination = "trash" | "recycling" | "compost"`; `makeEventId(cameraId: string, clipId: string, trackId: number, binId: string): string`, exported only from the subpath `@recyclone/contracts/event-id`.

- [ ] **Step 1: Root workspace files.** Root `package.json`: `private: true`, `packageManager: "pnpm@12.4.2"`, script `"test": "pnpm -r test"`. `pnpm-workspace.yaml` packages: `contracts`, `packages/*`, `apps/*`. `tsconfig.base.json`: `strict`, `module`/`moduleResolution` `"bundler"`, `target` `ES2022`, `noUncheckedIndexedAccess`.
- [ ] **Step 2: Package manifest.** `contracts/package.json`: name `@recyclone/contracts`, `type: "module"`, `exports: { ".": "./src/index.ts", "./event-id": "./src/event-id.ts" }`, dependency `zod@^4.6`, devDependencies `vitest@^5`, `typescript@^7`, `tsx`, `@types/node`; scripts `test: "vitest run"`, `typecheck: "tsc --noEmit"`, `gen:schema: "tsx scripts/gen-schema.ts"`. Run `pnpm install` at the root. Expected: lockfile created, no errors.
- [ ] **Step 3: Write failing tests** in `test/event.test.ts`, using the README §1 example as the `valid` fixture:
  - `accepts the README example` → `DisposalEventSchema.parse(valid)` does not throw.
  - `accepts unknown item and business` → `catalog_item_id: null`, `business_id: null`, `confidence: null` parses.
  - `rejects timestamp without timezone` → `occurred_at: "2026-10-17T15:02:41"` throws.
  - `rejects out-of-range confidence` → each of `1.2`, `-0.1`, `NaN` in `destination_confidence` throws.
  - `rejects bad event_id` → `"evt_XYZ"` throws (pattern `^evt_[0-9a-f]{16}$`).
  - `rejects unknown mode` → `source.mode: "replay"` throws.
  - In `test/event-id.test.ts`: `matches vectors` → for each row in `fixtures/event-id-vectors.json`, `makeEventId(...) === row.event_id`; `is deterministic and order-sensitive` → swapping `camera_id` and `bin_id` changes the result.
  - In `test/browser-safe.test.ts`: `index has no node: imports` → read every file under `src/` except `event-id.ts` and assert none matches `/from ["']node:/`.
- [ ] **Step 4: Run** `pnpm --filter @recyclone/contracts test`. Expected: FAIL (modules missing).
- [ ] **Step 5: Implement `src/event.ts`.** Fields exactly as README §1. Confidences: `z.number().min(0).max(1)` (rejects NaN). Nullable where §1 says "may be null", plus `item.label`, `item.confidence`, and `business.confidence`. `clip_offset_s`: `number >= 0`, nullable (null for `live`). `track_id`: `int >= 0` (for `labeled` events it is the label row number). `business.basis`: array of `"logo_text" | "reference_match"`. `evidence[]`: `{ kind: "crop" | "frame", uri: string, frame: int >= 0 }`. `occurred_at`: `z.iso.datetime({ offset: true })`.
- [ ] **Step 6: Eymen writes the cross-field rules (see "Your contribution" below)** as a `.superRefine` on `DisposalEventSchema`, then adds one failing test per rule before implementing it.
- [ ] **Step 7: Implement `makeEventId`** in `src/event-id.ts` with `node:crypto` `createHash("sha256")`. Write `fixtures/event-id-vectors.json` with 3 rows (one using `track_id: 0`), computing the values once with the implementation and checking one by hand with `printf 'cam_patio_1|clip_demo_v1|17|bin_patio_trash' | shasum -a 256`. `src/index.ts` re-exports `event.ts` only.
- [ ] **Step 8: Run** `pnpm --filter @recyclone/contracts test && pnpm --filter @recyclone/contracts typecheck`. Expected: all PASS, no type errors.
- [ ] **Step 9: Commit (ask first):** `feat(contracts): workspace, DisposalEvent schema, event id`.

**Your contribution (Step 6):** which cross-field rules should the schema enforce? Candidates: `catalog_item_id` non-null ⇒ it appears in `candidates`; `candidates` sorted by `score` descending; `mode: "live"` ⇒ `clip_offset_s` null; `mode: "recorded"` ⇒ `clip_offset_s` non-null. The trade-off: every rule here catches worker bugs at the API boundary, but too strict a rule rejects a real event during the live demo, and that event is lost. About 5–10 lines.

---

### Task 2: Site/catalog types + `demo-site.json`

**Files:**
- Create: `contracts/src/site.ts`, `contracts/fixtures/demo-site.json`
- Modify: `contracts/src/index.ts` (re-export)
- Test: `contracts/test/site.test.ts`

**Interfaces:**
- Consumes: `Destination` from Task 1.
- Produces: `DemoSiteSchema` / `type DemoSite` with keys `site, businesses, contacts, stations, cameras, bins, catalog, config_profiles`. Records:
  - `Contact { contact_id, name, role: "property_manager" | "restaurant_manager" | "area_manager", business_id | null, phone | null, handle | null }`
  - `Camera { camera_id, station_id, name, bin_regions: { bin_id, x, y, w, h }[] }`, with regions normalized to 0..1
  - `Bin { bin_id, station_id, name, type: Destination, capacity_l, camera_id, emptying_contact_id | null }`
  - `CatalogItem { catalog_item_id, name, business_id | null, reference_photos: string[], branding_text: string[], destination: Destination, condition_rule: string | null, volume_ml, volume_source: string }`
  - `ConfigProfile { half_life_hours, correct_threshold_pct | null, min_assessed_events, evidence_window_hours | null, follow_up_after_minutes, fullness_alert_threshold | null, item_confidence_threshold, business_confidence_threshold, provisional: string[] }`
  - `config_profiles: { normal: ConfigProfile, demo: ConfigProfile }`
- Also produces `checkSiteIntegrity(site: DemoSite): string[]`, which returns human-readable problems; an empty list means OK.

- [ ] **Step 1: Write failing tests:** `demo-site.json parses`; `integrity is clean` → `checkSiteIntegrity(site)` equals `[]`; `integrity catches dangling refs` → a copy with one bin's `camera_id` set to `"cam_missing"` returns a message containing `cam_missing`. Also check: duplicate IDs; each `bin_regions[].bin_id` exists; each catalog `business_id` exists or is null; each contact `business_id` exists or is null; and every bin is covered by a region on its own authoritative camera.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement `site.ts`** with the shapes above.
- [ ] **Step 4: Write `demo-site.json`.** One site, "Riverside Food Court (demo)"; 3 fictional restaurants (Bean Co., Taco Stop, Green Bowl); one station, "Patio", with one camera and three bins (trash, recycling, compost); `capacity_l` 120 each; contacts are one manager per restaurant plus one area manager, and `emptying_contact_id` is the area manager. Mark this as provisional, since the brief leaves it open. Catalog of about 6 items: one branded cup per restaurant, a generic can (`business_id: null`), a napkin (compost), and a chip bag (trash). `volume_source: "assumption"`. Bin regions are placeholders until footage exists. Profiles: `normal` = half-life 48 h, minimum 5 events, follow-up 1440 min, all undecided thresholds `null`; `demo` = small provisional values (minimum 3 events, follow-up 2 min, threshold 60%, fullness 0.8), every key listed in `provisional`.
- [ ] **Step 5: Run tests + typecheck.** Expected: PASS.
- [ ] **Step 6: Commit (ask first):** `feat(contracts): site and catalog schema with demo site fixture`.

---

### Task 3: API, feed, and integration types + `feed-sample.json`

**Files:**
- Create: `contracts/src/api.ts`, `contracts/src/interfaces.ts`, `contracts/fixtures/feed-sample.json`
- Modify: `contracts/src/index.ts`
- Test: `contracts/test/api.test.ts`

**Interfaces:**
- Consumes: `Destination`, `EvidenceSchema`, `ItemGuessSchema`, `BusinessGuessSchema` (Task 1); `CatalogItemSchema` and site IDs (Task 2).
- Produces (Zod + inferred types):
  - `FeedItem` (README §3; `type` enum exactly as listed) and `FeedResponse { items: FeedItem[], next_cursor: string }`.
  - `BinSummary { bin_id, name, type, station_id, capacity_l, estimated_fullness, estimated_volume_l, observed_count, unknown_count, last_emptied_at | null, illustration: { image_url, generated_at, snapshot_id, snapshot_taken_at, mocked } | null }`.
  - `ItemSummary { catalog_item_id, name, business_id | null, destination, correct_sorting_pct: number | null, status: "ok" | "below_threshold" | "insufficient_data", assessed_count, by_station: { station_id, assessed_count, correct_count }[] }`.
  - `ItemDetail` = `ItemSummary` plus `interventions: { intervention_id, action, confirmed_at, before: Period, after: Period }[]`, where `Period { from, to, assessed_count, correct_sorting_pct | null }`.
  - `AlertSummary { alert_id, kind: "recommendation" | "emptying", state: "open" | "sent" | "follow_up_sent" | "acknowledged" | "action_confirmed" | "emptied" | "closed", item_id | null, bin_id | null, contact_id, trigger, opened_at, messages: { message_id, direction: "outbound" | "inbound", kind, body, at, mocked }[] }`.
  - `ReviewItem { event_id, bin_id, occurred_at, item, business, evidence, status: "pending" | "resolved" | "left_unresolved", assigned_business_id | null }`.
  - `interfaces.ts`: the README §5 TypeScript interfaces verbatim (`Messenger`, `Illustrator`, `ReplyInterpreter`, `ReplySink`, `ContactRef`, `InboundReply`, `OpenAlertSummary`, `BinInventorySnapshot`), as plain TS types with no Zod.

- [ ] **Step 1: Write failing tests:** `feed-sample.json` has keys `feed, bins, items, item_detail, alerts, reviews, catalog`, and each parses with its schema (`catalog` with `CatalogItem[]`); `insufficient_data has null pct` → `status: "insufficient_data"` together with a number `correct_sorting_pct` is rejected (refine); `feed cursors increase` → the cursors in `feed.items` are strictly increasing as strings.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement `api.ts` and `interfaces.ts`.**
- [ ] **Step 4: Write `feed-sample.json`** that tells the demo story using `demo-site.json` IDs. It should include, in order: a correct disposal; three wrong cup disposals → `alert_opened` → `message_sent` → `reply_received` → `intervention_recorded`; a bin filling → emptying alert → `bin_emptied`; a `review_queued`. Mark mocked messages `mocked: true`. The bins in the sample include one bin with `illustration: null` and one item with `insufficient_data`.
- [ ] **Step 5: Run tests + typecheck.** Expected: PASS.
- [ ] **Step 6: Commit (ask first):** `feat(contracts): API, feed, and integration types with sample responses`.

---

### Task 4: JSON Schema, synthetic events, Python check, docs

**Files:**
- Create: `contracts/scripts/gen-schema.ts`, `contracts/disposal-event.schema.json`, `contracts/fixtures/synthetic-events.jsonl`, `contracts/scripts/check_python.py`, `.env.example` (root)
- Modify: `contracts/README.md` (file table statuses; §6 "Switching to the backup input" wording: labeled events use their label row number as `track_id`), `contracts/package.json` (script `check:python`)
- Test: `contracts/test/schema-drift.test.ts`, `contracts/test/synthetic-events.test.ts`

**Interfaces:**
- Consumes: `DisposalEventSchema`, `makeEventId`, `demo-site.json`.
- Produces: `disposal-event.schema.json` (draft 2020-12), the worker's validation target; `synthetic-events.jsonl`, development data for I.

- [ ] **Step 1: Write failing tests:** `schema file is up to date` → `JSON.stringify(z.toJSONSchema(DisposalEventSchema), null, 2) + "\n"` equals the file contents. `synthetic events are valid` → every line parses, `event_id === makeEventId(...)` for its source and bin, and every `bin_id` and non-null `catalog_item_id` exists in `demo-site.json`. Scenario coverage: at least one correct disposal, at least 3 wrong disposals of the same item, one event with `business_id: null` on a branded-looking guess, and one with `catalog_item_id: null`.
- [ ] **Step 2: Run tests.** Expected: FAIL.
- [ ] **Step 3: Implement `gen-schema.ts`** (writes the file in the format above); run `pnpm --filter @recyclone/contracts gen:schema`. If the `.superRefine` rules from Task 1 Step 6 can't be expressed in JSON Schema, add a `description` noting "cross-field rules enforced by core only".
- [ ] **Step 4: Write `synthetic-events.jsonl`** (about 10 lines, `source.mode: "labeled"`, `clip_id: "clip_synthetic_v1"`, `track_id` = row number) covering the coverage list.
- [ ] **Step 5: Write `check_python.py`.** It validates every line of `synthetic-events.jsonl` with `jsonschema.Draft202012Validator`, recomputes every row of `event-id-vectors.json` with `hashlib.sha256`, and exits non-zero on any mismatch. Script: `"check:python": "uv run --with jsonschema python scripts/check_python.py"`.
- [ ] **Step 6: Root `.env.example`** collecting the variables named in every area's `AGENTS.md`, each with an empty value and a comment naming its owner.
- [ ] **Step 7: Run** `pnpm --filter @recyclone/contracts test && pnpm --filter @recyclone/contracts typecheck && pnpm --filter @recyclone/contracts check:python`. Expected: all PASS; the Python script prints `ok`.
- [ ] **Step 8: Update `contracts/README.md`** file statuses: written (`demo-events.jsonl` stays "after footage exists"). Also update the §6 backup wording.
- [ ] **Step 9: Commit (ask first):** `feat(contracts): generated JSON Schema, synthetic events, python check`.
