# apps/web/ — Dashboard (owner: Agent J)

Read the root `AGENTS.md` and `contracts/README.md` first. J owns everything under `apps/web/` **except** `app/api/**` (I) and `app/api/photon/**` (S). Next.js, deployed on Vercel.

## Job

The dashboard the judges see. Build against `contracts/fixtures/feed-sample.json` and mock responses until I's API is ready.

## Demo screen (confirmed: layout B, full-screen scenes switched by the presenter)

Three full-screen scenes with a visible tab bar:

- **Live**: the worker's annotated stream (`NEXT_PUBLIC_WORKER_URL/stream.mjpg`) at full width, with a ticker of recent disposals marked correct / incorrect / unassessable.
- **Bins**: one panel per bin with its Grok Imagine illustration (labeled "generated, illustrative" with snapshot time), estimated fullness as a number and bar (labeled "estimated"), observed counts, and unknown-content count.
- **Messages**: the manager ↔ agent conversation for the active alert, with what triggered it (e.g. "cup score 40% < 60%, 5 assessed events") and its state (sent, follow-up sent, acknowledged, action confirmed, emptied).

Switching (**user decision, 2026-10-16: no automatic switching**):

- The dashboard never changes scene by itself. Only the presenter switches, with the tabs or keys `1`/`2`/`3`.
- Feed items (`/api/feed` item `type`) update every scene live in the background (ticker, bin fullness and illustrations, conversations), even while hidden.
- `alert_opened`, `review_queued`, `bin_emptied` and `intervention_recorded` show a toast notification that does not move the screen.
- A tab with updates the presenter hasn't seen shows a dot until it is opened.
- Poll `/api/feed` about once per second while the dashboard is open; this polling also drives the backend's time-based work (contract §6).
- When the messenger is mocked, the Messages scene shows a "reply as manager (mocked)" box that posts to `/api/photon/mock-reply`.
- Import shared types from `@recyclone/contracts` (the UI renders its own view models; see Implementation status).

**One app (user-approved design, 2026-10-16):** the demo scenes and the management screens share one navigation (Demo: Live / Bins / Messages · Manage: Overview / Review queue / Catalog), each scene is its own page, and the visual design follows the user's Claude Design export "Recyclone dashboard" (cream paper, sage/forest greens, clay for wrong bins; Bricolage Grotesque / DM Sans / DM Mono). Honesty labels are written as captions in that style, not badges.

Toast duration and tab-dot behavior are J's call.

## Management screens

Site overview (all bins, fullness, recurring mistakes, pending reviews, active alerts); station/bin detail; item detail (business, correct destination, correct-sorting percentage or "insufficient data", assessed-event count, station breakdown, before/after periods with dates and counts); packaging catalog editor; review queue (evidence, candidate matches, assign or leave unresolved); recommendation history.

## Honesty in the UI

- A visible demo-mode banner when `demo: true`.
- Visible "mocked" labels for any mocked integration, and a "labeled backup input" label when events have `source.mode = "labeled"`.
- Uncertainty and insufficient-data states are shown, never hidden or turned into 0%.
- Before/after comparisons never claim causation.

## Verify

- No feed item ever changes the scene; tabs and `1`/`2`/`3` do.
- Illustrations show their bin and snapshot time.
- The demo banner and mocked labels appear when they should.

## Environment variables

- `NEXT_PUBLIC_WORKER_URL`: base URL of the CV worker (contract §4), e.g. `http://localhost:8000`. Unset → Live shows "stream not configured" and review evidence shows its path only.
- `NEXT_PUBLIC_DATA_SOURCE` (J-local, `mock` | `api`, default `mock`): `mock` runs a scripted in-browser backend; `api` calls I's `/api/*` routes.

## Implementation status (J, updated 2026-10-16)

What exists (branch `j/dashboard-scaffold`), and what is still provisional:

- Next.js 16 App Router + Tailwind v4 + Vitest, inside the root pnpm workspace. Next.js 16 differs from older versions: check `node_modules/next/dist/docs/` before using an unfamiliar API. From `apps/web/`: `pnpm dev`, `pnpm test`, `pnpm typecheck` (web code only), `pnpm build`.
- Every page shares one light header with the nav centred (user feedback: Live must not look like a different app). Live shows the footage as a rounded card, not full-bleed.
- Routes: `/live`, `/bins`, `/messages` (demo scenes; keys `1`/`2`/`3`), `/` overview, `/items/[id]`, `/reviews`, `/catalog`. Old `/demo`, `/items`, `/recommendations` redirect. "Reset demo" sits in the demo notice strip.
- `dev`/`build` run with `--webpack`: core and contracts import siblings as `./x.js` while the files are `.ts`; only webpack honours `experimental.extensionAlias` (Turbopack ignores it).
- `NEXT_PUBLIC_DATA_SOURCE=mock` (default) runs `lib/mock/` (a ~3-minute scripted run on E's demo site covering all six scenarios); `api` calls I's routes. Both produce the view models in `lib/view.ts`.
- `lib/adapters/core.ts` converts the contract DTOs (`contracts/src/api.ts`, which core returns) into those view models. Tested against responses captured from a running core on E's site file (`lib/adapters/__fixtures__/core-responses.json`). Gaps the contract leaves, and how the UI fills them: per-item bin counts (the Bins page counts this session's feed), interventions on the item list (`lib/api.ts` fetches item details), outcome / labeled input / mocked on feed items (parsed from core's summary text).
- The web package depends on `@recyclone/contracts`, `@recyclone/core` and `@recyclone/integrations` (for the API routes I and S own under `app/api/`), all in `transpilePackages`.
- Write routes (catalog, reviews, demo reset, mock reply) require `MANAGER_API_TOKEN`; the mock reply also needs `ENABLE_MOCK_REPLY=true` on the server (S's guard). The dashboard never bundles the token: on the first 401 it asks for it (`lib/managerToken.ts`) and keeps it in the tab's sessionStorage.
- `lib/site.ts` reads business names, contact names, and demo-profile settings from `contracts/fixtures/demo-site.json`, because core's API does not return them.
- Toast and unseen-tab logic: `lib/sceneDirector.ts` (pure, tested; never changes the page).
- One app-wide `/api/feed` poller (`hooks/useFeed.tsx`, ~1 s) runs on every page, driving the backend's lazy time-based work. The first load is backlog and raises no toasts or tab dots.
- The design's daily bar chart and restaurant-level percentage have no data source yet: the item page shows every drop seen this session instead, and the overview shows each restaurant's weakest item.

**Name (user decision, 2026-10-16):** the dashboard is called **Caught in 4K** on screen (`APP_NAME` in `lib/config.ts`). Code, packages and the repo keep "recyclone".

**Deployed (2026-10-16):** Vercel project `caught-in-4k` (user's account), production URL https://caught-in-4k-app.vercel.app (`caught-in-4k.vercel.app` belongs to someone else; https://recyclone.vercel.app still points at the same project), deployed from a laptop with the CLI (no Git integration: the account can't access the GitHub repo). Project settings: root directory `apps/web`, framework Next.js, source files outside the root directory included. It runs the mock data; I's API routes return 503 there (no database configured).

**Verified (2026-10-16, after rebasing on main @ 12ee98e):** `pnpm test` (34 tests), `pnpm typecheck`, `pnpm build` with full type checking, and an end-to-end run against core (demo memory mode, E's `demo-site.json`, all 11 synthetic events accepted) with headless-Chrome screenshots. Not verified: the real worker stream, Photon/Grok live, the API on Vercel.

**Requests to other owners (not edited by J):**

- **E (contract):** `BinSummary` has only `observed_count`; add per-item counts so the Bins page needn't rebuild them from the feed. `FeedItem` has no `outcome`, `source_mode` or `mocked`; core puts them in `summary` text ("(incorrect)", "[labeled backup input]", "(mocked)"), which J parses. `FeedResponse` has no `demo` flag. `AlertSummary` has no contact or business names (J reads them from the site file).
- **I:** outbound message bodies still carry an `[alert_id]` prefix (J hides it), and `trigger` is the whole message body (J shows its first sentence).
- **E:** clarify whether `evidence[].uri` includes the `evidence/` prefix (the §1 sample does; §4 serves `/evidence/<path>`). J accepts both.
- **E (decision needed):** a Vercel page over HTTPS cannot load an `http://localhost` stream (mixed content). Run the dashboard locally next to the worker for the demo, or expose the worker over HTTPS.
- **E:** the root `AGENTS.md` "Confirmed decisions" still says the scenes switch after each drop and when an alert fires; the user decided there is no automatic switching.
