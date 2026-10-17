# AGENTS.md — Recyclone: camera-based waste sorting intelligence

## Read this first

This is the shared root brief and working contract for every agent on this project. Four agents work in parallel, each owning one area of the repository. **Read this file, then the `AGENTS.md` inside the folder you own, then `contracts/README.md`.** Coding agents read nested `AGENTS.md` files automatically for files under that folder.

The project is a hackathon prototype of a product that connects to existing surveillance cameras, tracks waste sorting mistakes, and helps managers correct recurring problems. The demo uses staged recorded footage processed live by a CV model. The production ambition is broader than the demo.

This document specifies desired behavior; it does not assert that any code, model, dataset, API integration, or deployment already works. Inspect the repository before making implementation claims.

## Team and ownership

| Agent | Owns (only this agent edits these paths) | Area |
|---|---|---|
| **E** | `worker/`, `contracts/`, this root `AGENTS.md`, root workspace files (`package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.env.example`) | CV worker: footage → detection → tracking → item/business identification → "entered bin X" → one disposal event. Shared contract and demo site fixtures. |
| **I** | `packages/core/`, `apps/web/app/api/**` except `apps/web/app/api/photon/**` | Core backend: event intake and deduplication, sorting rules, review queue, scoring, alert state, fullness, emptying resets, database schema, scheduled jobs. |
| **S** | `packages/integrations/`, `apps/web/app/api/photon/**` | Integrations: Photon 2.0 messaging (outbound, inbound replies, reply interpretation) and Grok Imagine bin illustrations, each with an explicit mock. |
| **J** | `apps/web/` except `apps/web/app/api/**` | Dashboard on Vercel: the demo's Live / Bins / Messages scenes and the management screens. |

### Rules that prevent merge conflicts

- **Edit only paths you own.** If you need a change in someone else's area, write the request in your PR description or ask that owner; do not edit their files.
- **`contracts/` is the only shared interface.** It is owned by E. Version 1 is frozen once all four agents have read it. After that, a contract change is its own small PR that touches only `contracts/` and states which owners must update their code.
- **Develop against the contract, not against each other's code.** Each area must run on its own using `contracts/fixtures/` and mocks, so nobody waits for another area to finish.
- **Dependencies:** add packages only to your own `package.json` (or `worker/requirements.txt` for E). Never hand-edit the lockfile; if `pnpm-lock.yaml` conflicts, take `main`'s version and rerun `pnpm install`.
- **Database schema** lives in `packages/core/` and is owned by I. Other areas request tables or columns through I.
- **Environment variables:** each owner lists their variables in their folder's `AGENTS.md`; E collects them into the root `.env.example`.
- Work on a branch per agent (`e/...`, `i/...`, `s/...`, `j/...`), keep PRs small, and rebase on `main` before opening one.

## Agent working rules

- Do not commit, push, merge, reset, or otherwise mutate Git history without an explicit user instruction. Creating or editing files is permitted within the requested work.
- Preserve existing work. Inspect repository structure, applicable instructions, and implementation before editing.
- Treat confirmed requirements as authoritative. Suggested structures are implementation guidance, not additional user decisions.
- Ask one focused question at a time when a material unresolved product decision blocks progress. Continue independent work where possible.
- Keep unknown business rules configurable. Document provisional defaults instead of presenting them as user-approved decisions.
- Do not invent credentials, data access, model accuracy, sponsor eligibility, or completed integrations.
- Clearly distinguish live API calls, recorded footage, seeded data, and mocked integrations.
- Keep secrets out of the repository. Supply variable names and setup instructions through `.env.example`.
- Test the consequential logic in your own area (each folder's `AGENTS.md` lists what to verify).
- Update the relevant `AGENTS.md` as the user resolves open questions, keeping confirmed decisions separate from implementation assumptions. Root-level decisions are recorded below by E.

## Product goal

Companies should be able to use their existing surveillance cameras to determine what is entering trash, recycling, and compost bins; identify repeated sorting mistakes; and receive practical recommendations that reduce those mistakes.

Example: a restaurant's recyclable cup repeatedly enters trash at shared outdoor bins. The system identifies the cup, attributes it to that restaurant, records the wrong destination, and messages the restaurant manager through Photon 2.0 with a recommendation to place a sign near where customers receive the cup. The manager can confirm installation by text. The dashboard then compares sorting behavior before and after the intervention.

All wrong-bin events are in scope, including contamination of recycling and compost. The primary product and demo priority is recyclable or compostable material incorrectly placed in trash.

## Confirmed decisions

- Demo input: staged recorded footage of an outdoor disposal area between multiple restaurants, with trash, recycling, and compost bins.
- **The CV model detects and classifies drops live from that footage during the demo.** Drops are not hand-labeled into the pipeline. (Hand labels are still made for evaluation; see `worker/AGENTS.md`.)
- Intended production input: companies' existing surveillance cameras.
- A camera must be able to observe multiple bins, with separate identities and contents estimates for each bin.
- Support centralized monitoring across multiple cameras and stations throughout a large building or managed site.
- Deploy the centralized dashboard on Vercel. Video processing does not have to run on Vercel.
- Use Grok Imagine to illustrate estimated bin contents.
- Use Photon 2.0 for manager recommendations, follow-ups, bin-emptying requests, and manager replies.
- Satellite data is not required. Do not add Idea B's wildfire planning features.
- No additional sponsor integration has been selected.
- **Demo screen uses full-screen scenes that switch (layout B):** Live footage → Bins (Grok Imagine illustration plus estimated fullness per bin) after each drop → Messages (manager ↔ agent conversation) when an alert fires. Details in `apps/web/AGENTS.md`.
- **The demo starts from preset bin sizes and configuration** and demonstrates one instance of every scenario (list below).
- **Brand is not important (Eymen, 16 Oct).** The goal is the right bin category; identifying the exact product or its restaurant is a bonus, not a requirement. Items are recognized from text descriptions (no registration needed), and unbranded items are judged by their generic category's bin rule.
- **Recommendations for unbranded items go to the area manager (Eymen, 16 Oct).** When a recurring mistake involves items with no source business, the recommendation is site/station-level and goes to the area manager (e.g. "plastic cups went into trash 2 of the last 3 times at the Patio bins; a sign above the bins could help"). Branded items keep going to their restaurant's manager. Core implements the routing (Agent I).

## Implementation assumptions (E's calls, not user decisions)

- Monorepo with pnpm workspaces: `apps/web` (Next.js on Vercel, hosts the API routes and Photon webhook), `packages/core` (TypeScript domain logic + database), `packages/integrations` (TypeScript adapters), `worker/` (Python CV worker that runs on a laptop and posts events to the API).
- Postgres (Neon or local) for persistence; ORM is I's choice.
- The worker exposes an annotated video stream that the Live scene embeds; see `contracts/README.md`.
- Demo scenarios to show, one each (provisional list, extend as needed):
  1. Correct disposal: item enters its correct bin.
  2. Repeated wrong disposal: one item's correct-sorting percentage falls below the demo threshold → Photon recommendation (to the item's restaurant manager if it has a source business, otherwise to the area manager) → manager texts that the action was taken → intervention recorded.
  3. Bin fills: estimated fullness crosses the demo threshold → emptying request → manager confirms → only that bin's inventory resets.
  4. Uncertain origin: item enters a bin but its restaurant is unclear → area-manager review queue, no restaurant message is sent.
  5. Unknown item or unclear destination: event recorded as unassessable; it does not count as a mistake.
  6. No reply: the follow-up is sent after the (demo-shortened) no-response interval, and not before.

## Users and responsibilities

### Area manager

- Builds and maintains the packaging reference catalog for all participating restaurants/stores: reference photos, business associations, and each item's correct destination under local rules.
- Manually identifies the source business of items whose origin is uncertain.

### Recommendation recipients

- Within a store: recommendations go to the property manager.
- At shared outdoor bins: item-specific recommendations go to the store/restaurant identified as that item's source.
- When business attribution is uncertain, queue the event for the area manager before sending a restaurant-specific recommendation.
- The contact responsible for emptying each shared bin still needs to be defined; do not assume it is the source restaurant.

## How the areas connect

```text
footage ──► worker (E) ──POST /api/events──► core (I) ──► database
                │                              │   ▲
   annotated stream                  alerts/images  replies
                │                              ▼   │
                │                     integrations (S) ◄── Photon webhook
                ▼                              │
           web Live scene (J) ◄── GET /api/feed, /api/bins, /api/items … (I)
```

The exact payloads, endpoints, and TypeScript interfaces are in `contracts/README.md`. Item identity, source business, actual destination, and correct destination are separate facts throughout; an event may have a known bin but an unknown item or business.

## Demo delivery sequence

1. Configure a shared outdoor site, participating restaurants, bins, and a small catalog (`contracts/fixtures/demo-site.json`).
2. Stage and record visible correct and incorrect disposal events covering every scenario above, emphasizing recoverable items entering trash.
3. Manually label the clip for evaluation: item, destination, business where knowable, and event timestamp.
4. Run the worker on the footage live; events appear on the Live scene and update the Bins scene.
5. Demonstrate uncertain attribution entering the review queue.
6. Show combined item scoring and a threshold-triggered Photon recommendation under documented demo parameters.
7. Confirm an intervention by text and show the recorded action. A subsequent staged clip may illustrate a before/after comparison, clearly labeled as staged rather than a real-world impact result.
8. Show numerical fullness estimates and a Grok Imagine contents illustration.
9. Demonstrate an emptying request and manager reply resetting only the identified bin's inventory.

Do not imply that staged footage proves robust performance across arbitrary surveillance cameras. Report what was actually evaluated.

## End-to-end verification (whole team)

Each folder's `AGENTS.md` lists its own checks. Before calling the prototype complete, also verify end to end:

- Running the full demo clip twice produces the same set of events (no duplicates).
- Every scenario above is visible in the dashboard, driven by the live worker, with integrations either live or visibly marked as mocked.
- Repository setup instructions, configuration documentation, `.env.example`, footage/catalog preparation instructions, a runnable demo path, and an honest list of working versus mocked integrations exist. Confirm deployment separately from local execution.

## Remaining decisions

Ask about these only when needed, one question at a time:

- Deadline, available compute, and access to Photon/Grok credentials.
- Initial item catalog, footage, and condition-dependent sorting rules.
- CV model, camera calibration, and future camera protocols (E proposes; see `worker/AGENTS.md`).
- Correct-sorting threshold, exact demo values, and evidence-recency rule.
- Post-response alert behavior and reminders after the first 24-hour follow-up.
- Photon channel and manager/contact routing, especially shared-bin emptying responsibility.
- Bin capacities, source of item-volume estimates, and fullness-alert threshold.
- Initial inventory assumptions, delayed emptying confirmation, and image refresh cadence.
- Before-and-after comparison windows and evaluation acceptance targets.

Keep the build centered on the complete loop: observe disposal → identify recurring mistakes → recommend an action → record the manager's response → show subsequent sorting behavior.
