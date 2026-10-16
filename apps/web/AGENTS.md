# apps/web/ — Dashboard (owner: Agent J)

Read the root `AGENTS.md` and `contracts/README.md` first. J owns everything under `apps/web/` **except** `app/api/**` (I) and `app/api/photon/**` (S). Next.js, deployed on Vercel.

## Job

The dashboard the judges see. Build against `contracts/fixtures/feed-sample.json` and mock responses until I's API is ready.

## Demo screen (confirmed: layout B, full-screen scenes that switch)

Three full-screen scenes with a visible tab bar:

- **Live**: the worker's annotated stream (`NEXT_PUBLIC_WORKER_URL/stream.mjpg`) at full width, with a ticker of recent disposals marked correct / incorrect / unassessable.
- **Bins**: one panel per bin with its Grok Imagine illustration (labeled "generated, illustrative" with snapshot time), estimated fullness as a number and bar (labeled "estimated"), observed counts, and unknown-content count.
- **Messages**: the manager ↔ agent conversation for the active alert, with what triggered it (e.g. "cup score 40% < 60%, 5 assessed events") and its state (sent, follow-up sent, acknowledged, action confirmed, emptied).

Switching (driven by `/api/feed` item `type`):

- `disposal` → show it on Live, then switch to Bins briefly so the change is visible, then back to Live.
- `alert_opened` → show a notification, then switch to Messages.
- `reply_received`, `intervention_recorded`, `bin_emptied` → stay on or switch to Messages, then return to Live.
- The presenter can always override with the tabs or keyboard shortcuts; automatic switching can be paused.
- Poll `/api/feed` about once per second while the dashboard is open; this polling also drives the backend's time-based work (contract §6).
- When the messenger is mocked, the Messages scene shows a "reply as manager (mocked)" box that posts to `/api/photon/mock-reply`.
- Import shared types from `@recyclone/contracts`.

Exact timings and transitions are J's call.

## Management screens

Site overview (all bins, fullness, recurring mistakes, pending reviews, active alerts); station/bin detail; item detail (business, correct destination, correct-sorting percentage or "insufficient data", assessed-event count, station breakdown, before/after periods with dates and counts); packaging catalog editor; review queue (evidence, candidate matches, assign or leave unresolved); recommendation history.

## Honesty in the UI

- A visible demo-mode banner when `demo: true`.
- Visible "mocked" labels for any mocked integration, and a "labeled backup input" label when events have `source.mode = "labeled"`.
- Uncertainty and insufficient-data states are shown, never hidden or turned into 0%.
- Before/after comparisons never claim causation.

## Verify

- Scene switching follows the feed rules and can be overridden.
- Illustrations show their bin and snapshot time.
- The demo banner and mocked labels appear when they should.

## Environment variables

`NEXT_PUBLIC_WORKER_URL`.
