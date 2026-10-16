# packages/core/ — Core backend (owner: Agent I)

Read the root `AGENTS.md` and `contracts/README.md` first. Only I edits this folder and `apps/web/app/api/**` (except `apps/web/app/api/photon/**`, which belongs to S).

## Job

Everything between "an item entered a bin" and "the dashboard and managers see the right thing": persistence, rules, scoring, alert state, fullness, and resets. The database schema lives here.

Until the worker is ready, develop against `contracts/fixtures/demo-events.jsonl`. Until integrations are ready, use the mock `Messenger`, `Illustrator`, and `ReplyInterpreter` from `packages/integrations`, or a local stub with the same interface.

## Records

Site, business, manager/contact, station, camera, bin; catalog item and reference image; disposal event and review decision; bin-emptying event/inventory epoch; alert, message, reply, and intervention; generated inventory image with source snapshot; configuration profile (normal or demo). Use stable IDs and keep enough source data to recompute metrics after manual corrections.

## Event intake and classification

- `POST /api/events` upserts by `event_id`; a repeat returns `"duplicate"` and changes nothing.
- Apply the catalog's local rule to classify each event as correct, incorrect, or unassessable (unknown item, or unclear destination).
- Item identity, source business, actual destination, and correct destination are stored separately.
- If business attribution is uncertain, queue the event for the area manager. Never send a restaurant-specific message for it until resolved.
- Review decisions (assign a business, or leave unresolved) recompute derived statistics without creating duplicate events.
- Business attribution and thresholds follow contract §6; core is the only place thresholds are applied.
- Import all shared types from `@recyclone/contracts`; never redefine them.

## Correct-sorting metric

For each catalog item, combine assessed events across all stations serving its restaurant/store. Keep station information for drill-down, but do not use per-station alert rates.

```text
weight_i = 2 ^ (-(t - t_i) / half_life)
correct_sorting_percent = 100 * sum(weight_i * correct_i) / sum(weight_i)
```

- Only assessable events count. Unknown outcomes are not mistakes. A zero denominator means `insufficient_data`, not 0%.
- Configurable half-life (about 2 days proposed for normal use) and a configurable threshold (value not chosen).
- A recommendation is eligible when the percentage is below the threshold and the minimum evidence is met (5 assessed events proposed for normal use). Old evidence must not silently satisfy a recent-evidence requirement; the recency rule is still open.
- Separate demo profile with lower minimums and independently configurable values.

## Alerts and conversations

- Persist alert state so the same notification is not sent on every processing cycle.
- After 24 hours (shorter in the demo profile) without a reply, one follow-up may be sent; never before that interval.
- Track "acknowledged" separately from "action confirmed". Record the action and its confirmation time as an intervention.
- `handleReply` calls `ReplyInterpreter`, applies the state change, and sends clarifications itself (contract §6). Adapters are injected via `createCore({ messenger, illustrator, interpreter })`, wired by I under `apps/web/app/api/`.
- Follow-ups and illustration refreshes are evaluated lazily on every ingest and `/api/feed` request; no cron for the demo (contract §6).
- Recommendations name the item, explain the observed pattern, and suggest a specific action grounded in the catalog rule and the data.
- Before/after comparisons show clear dates and assessed-event counts and never claim causation.

## Fullness and emptying

```text
estimated_volume = sum(item volumes since last confirmed emptying)
estimated_fullness = estimated_volume / bin_capacity
```

- Label as estimated, keep unknown-content counts, and keep observed counts separate from estimated volume.
- Above a configurable threshold (value open), open an emptying alert and send a request via `Messenger`.
- A manager's confirmation resets only that bin's current inventory and illustration state. History (events, scores, recommendations, interventions) is kept. If the actual emptying time is known, deposits after it stay in the new inventory.
- Decide when to request a new illustration (refresh cadence; not every event) and store each image with its `BinInventorySnapshot`.

## Feed

Produce the `/api/feed` items in contract §3 for every state change the dashboard must show.

## Verify (tests required)

- Duplicate `event_id` produces no second event.
- Correct/incorrect/unassessable classification follows the configured rules.
- Uncertain origins are queued and trigger no restaurant message.
- Review corrections recompute statistics without duplicates.
- Time weighting, cross-station aggregation, zero-data handling, and minimum-evidence gating.
- Demo and normal parameters are independent.
- Alerts are not re-sent on every update; the no-response follow-up timing works.
- A duplicate reply delivery does not repeat an action.
- Emptying resets one bin only and deletes no history.

## Environment variables

`DATABASE_URL`, `WORKER_INGEST_TOKEN`, `CONFIG_PROFILE` (`normal` | `demo`).
