# Agent I integration wiring handoff

## Implemented on i/integration-wiring-latest

- Core API runtime constructs S's actual public adapter factories per server
  instance. Mode typos and missing live credentials fail instead of silently mocking.
- Photon `_replySink.ts` forwards to the core sink. `_shared.ts` no longer marks a
  provider ID seen before core accepts it; failed configuration/contact lookups
  can be retried, while successful replies are deduplicated in core persistence.
- Provider identities resolve to local configured manager IDs by phone, handle,
  or `PHOTON_CONTACT_MAP`. `CONTACT_PHONES_JSON` configures recipient numbers
  outside fixtures. Local contact IDs are accepted directly only in mock mode.
- Actual `/api/photon/mock-reply` handler reaches core, respects the manager token,
  validates input, records interventions, and resets the identified bin only.
  Upstream's required manager token and `ENABLE_MOCK_REPLY=true` gate are retained.
- Explicit alert IDs and bin IDs/names can disambiguate a manager's pending work.
  Negatives, future promises, and work-in-progress messages cannot complete actions.
- S's upstream direct imports from `@recyclone/contracts` are retained; the old
  duplicated types file stays deleted.
- Root environment example now uses S's real Spectrum variable names and lists
  core runtime/contact mapping options, without credentials.
- Main's workspace manifests and lockfile already include the required dependencies.
  The explicit policy disabling the optional protobufjs advisory is preserved.
- PostgreSQL migration SQL is bundled as TypeScript data, avoiding webpack
  rewriting a filesystem URL into an asset URL. A parity test keeps it synchronized
  with the standalone SQL migration.

## Cross-area edits

The user explicitly authorized fixing what was needed after being asked about the
ownership restriction. Exceptions are limited to Photon reply wiring/mock handler,
S's integration documentation, the environment example, and a workspace build-policy
comment. Main's shared-contract imports and lockfile were retained. Worker, shared
contracts/fixtures, and J's dashboard implementation were not edited.

## Verification

Rebased on main at `8e8e016`, preserving J's dashboard and upstream integration
changes. All 49 core tests passed with zero skips, including isolated PostgreSQL
and E's Python HTTP client. Integrations: 23 tests; contracts: 55; dashboard: 34.
All package/API type checks, the integrations build, frozen install, and the
Next.js production build passed.

The built Next.js app was run against isolated PostgreSQL over HTTP. It accepted
11 synthetic events and deduplicated their replay, enforced manager auth, applied
J's reported "DONE, sign is up at the counter" confirmation, reset one named bin
while preserving other bins/history, and served the review queue and Live page.
Photon and image generation were mocked throughout. No external messages were
sent and no deployment was performed.

Core suite includes real isolated PostgreSQL tests and a Python HTTP-client test
that imports E's actual client, posts all 11 synthetic events through the API and
S's mock adapters, then replays them without duplicate disposal events. No model
accuracy claim follows from that client test.

Run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @recyclone/core test
pnpm --filter @recyclone/core typecheck
pnpm --filter @recyclone/core exec tsc -p tsconfig.api.json --noEmit
pnpm --filter @recyclone/contracts test
pnpm --filter @recyclone/contracts typecheck
pnpm --filter @recyclone/integrations test
pnpm --filter @recyclone/integrations typecheck
pnpm --filter @recyclone/web test
pnpm --filter @recyclone/web typecheck
pnpm --filter @recyclone/web build
```

Set `CORE_TEST_DATABASE_URL` to a disposable PostgreSQL instance and
`CORE_TEST_PYTHON` to a Python executable with `jsonschema` to enable all core checks.
Ordinary runs skip those optional external-runtime checks when unavailable.

## Remaining integration work

- S: `GrokIllustrator` is still a live-mode stub. Implement it and verify actual
  generation; do not call it working because its factory can construct the class.
- S: successful live Photon delivery still depends on configured credentials,
  channel/recipient access and contacts. Register the verified webhook once its
  public endpoint exists. No real messages were sent by this change.
- J's Next.js app, dependencies and workspace transpilation are now present.
- J/S: verify the signed Photon webhook and `after()` behavior using real provider
  deliveries. A passing Next build does not prove that external lifecycle.
- Team: configure the hosted database, film/enroll/calibrate the worker, and verify
  the footage-driven end-to-end demo and deployment.

The adapter/reply wiring blocker in I's area is resolved. Full application and
live-service verification remain distinct from these backend tests.
