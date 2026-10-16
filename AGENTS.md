# AGENTS.md — Idea A: Camera-based waste sorting intelligence

## Read this first

This document is the standalone product brief and working contract for agents building Idea A. It contains the user's confirmed decisions, suggested implementation structure, and unresolved choices. It is intended to live at the repository root as `AGENTS.md`.

The project is a hackathon prototype of a product that connects to existing surveillance cameras, tracks waste sorting mistakes, and helps managers correct recurring problems. The demo uses staged recorded footage. The production ambition is broader than the demo.

This document specifies desired behavior; it does not assert that any code, model, dataset, API integration, or deployment already works. Inspect the repository before making implementation claims. Do not assume files or dependencies from the original brainstorming workspace exist in this repository.

## Agent working rules

- Do not commit, push, merge, reset, or otherwise mutate Git history without an explicit user instruction. Creating or editing files is permitted within the requested work.
- Preserve existing work. Inspect repository structure, applicable instructions, and implementation before editing.
- Treat confirmed requirements below as authoritative. Suggested structures are implementation guidance, not additional user decisions.
- Ask one focused question at a time when a material unresolved product decision blocks progress. Continue independent work where possible.
- Keep unknown business rules configurable. Document provisional defaults instead of presenting them as user-approved decisions.
- Do not invent credentials, data access, model accuracy, sponsor eligibility, or completed integrations.
- Clearly distinguish live API calls, recorded footage, seeded data, and mocked integrations.
- Keep secrets out of the repository. Supply variable names and setup instructions through `.env.example`.
- Test the consequential logic: disposal deduplication, attribution review, scoring, alert state, reply handling, and bin resets.
- Update this file as the user resolves open questions. Keep a clear distinction between confirmed decisions and implementation assumptions.

## Product goal

Companies should be able to use their existing surveillance cameras to determine what is entering trash, recycling, and compost bins; identify repeated sorting mistakes; and receive practical recommendations that reduce those mistakes.

Example: a restaurant's recyclable cup repeatedly enters trash at shared outdoor bins. The system identifies the cup, attributes it to that restaurant, records the wrong destination, and messages the restaurant manager through Photon 2.0 with a recommendation to place a sign near where customers receive the cup. The manager can confirm installation by text. The dashboard then compares sorting behavior before and after the intervention.

All wrong-bin events are in scope, including contamination of recycling and compost. The primary product and demo priority is recyclable or compostable material incorrectly placed in trash.

## Confirmed scope and integrations

- Demo input: staged recorded footage of an outdoor disposal area between multiple restaurants, with trash, recycling, and compost bins.
- Intended production input: companies' existing surveillance cameras.
- A camera must be able to observe multiple bins, with separate identities and contents estimates for each bin.
- Support centralized monitoring across multiple cameras and stations throughout a large building or managed site.
- Deploy the centralized dashboard on Vercel. Video processing does not have to run on Vercel.
- Use Grok Imagine to illustrate estimated bin contents.
- Use Photon 2.0 for manager recommendations, follow-ups, bin-emptying requests, and manager replies.
- Satellite data is not required. Do not add Idea B's wildfire planning features to this project.
- No additional sponsor integration or specific CV model has been selected.

## Users and responsibilities

### Area manager

- Builds and maintains the packaging reference catalog for all participating restaurants/stores.
- Supplies reference packaging photos and business associations.
- Specifies each catalog item's correct disposal destination according to local rules.
- Manually identifies the source business of items whose origin is uncertain.

### Recommendation recipients

- Within a store: send recommendations to the property manager.
- At shared outdoor bins between stores/restaurants: send item-specific recommendations to the store/restaurant identified as that item's source.
- When business attribution is uncertain, queue the event for the area manager before sending a restaurant-specific recommendation.
- The contact responsible for emptying each shared bin still needs to be defined; do not assume it is the source restaurant.

## Packaging catalog and item attribution

Use both visible logos/text and reference-image matching against the area manager's catalog to identify packaging and its source business. Do not rely on logos alone or assume generic packaging uniquely identifies a restaurant.

Each catalog entry should support:

- Stable item ID and human-readable name.
- Source restaurant/store association.
- Reference photos and relevant visible branding/text.
- Correct destination under the site's rules: trash, recycling, or compost.
- Any explicitly configured condition-dependent rule.
- Approximate item volume for fullness estimation, with its source or assumption recorded.

Item identity, source business, actual destination, and correct destination are separate facts. An event may have a known bin but an unknown item or business. Preserve those distinctions.

The manual review queue should provide available evidence, candidate matches, and an option to leave the origin unresolved. Corrections must update derived statistics without creating duplicate disposal events.

## Disposal-event processing

Suggested pipeline:

1. Register site, stations, cameras, and bins.
2. Configure which image regions correspond to individual bin openings.
3. Process staged footage for the demo; preserve a path to a future live camera adapter.
4. Detect and track visible items across frames.
5. Identify catalog candidates using visual appearance, logos, and text.
6. Establish whether an item actually entered a specific bin.
7. Create one disposal event for the item, with confidence and supporting evidence.
8. Apply the catalog's local sorting rule to classify the event as correct, incorrect, or unassessable.
9. Route uncertain business attribution to manual review.
10. Update item-level sorting metrics and bin-level contents estimates.
11. Evaluate recommendation and emptying-alert eligibility.

Requirements:

- Seeing an item in someone's hand or near a bin is not enough to establish disposal.
- Count an item once, not once per frame. Replaying a clip must not duplicate events.
- For overlapping camera views, avoid double counting. A prototype may assign one authoritative camera per bin and document that limitation.
- Handle occlusion, mixed handfuls, and uncertain destinations as uncertainty rather than fabricated precision.
- Retain event timestamps, item/business attribution, bin/station IDs, confidence, evidence references, and review status.
- Focus on items and bin openings; personal identification is not needed.

## Correct-sorting metric and recommendations

For each catalog item, combine assessed disposal events across all stations serving its restaurant/store. Keep station information for dashboard drill-down and recommendation context, but do not use separate per-station alert rates.

At evaluation time `t`, for event `i` at time `t_i`:

```text
weight_i = 2 ^ (-(t - t_i) / half_life)
correct_sorting_percent = 100 * sum(weight_i * correct_i) / sum(weight_i)
```

Here `correct_i` is 1 for a correct disposal and 0 for an incorrect disposal. Include only assessable events in numerator and denominator. Unknown outcomes do not count as mistakes. A zero denominator means insufficient data, not 0% correct.

Confirmed parameters and behavior:

- Configurable half-life, with approximately two days as the proposed normal-use default.
- Configurable correct-sorting threshold; the numeric value has not been chosen.
- A recommendation becomes eligible when the correct-sorting percentage falls below that threshold and the minimum evidence requirement is met.
- Configurable minimum of five assessed disposals as the proposed normal-use default.
- Separate demo configuration with a lower minimum and independently configurable parameters to demonstrate the flow using fewer events.
- Exact demo values and the recency rule for the five-event minimum remain open. Do not silently allow old evidence to satisfy a supposedly recent evidence requirement.

Recommendations should name the item, explain the observed pattern, and suggest a specific action. Example: signage where customers collect a frequently misplaced cup, explaining its correct destination. Ground the suggestion in the catalog's local rule and observed data.

## Photon conversations and interventions

Confirmed flow:

1. Send an eligible item-specific recommendation to the appropriate manager.
2. If there is no response after 24 hours, a follow-up may be sent.
3. Do not send another reminder for that alert before the 24-hour interval.
4. Managers can text back that they implemented an action, such as installing signage.
5. Record the action and confirmation timestamp.
6. Show sorting rates before and after the intervention in the dashboard.

A response acknowledging a message is not automatically confirmation that the action was completed. Track those states separately. Further reminder cadence and post-response re-alert behavior are unresolved.

Compare periods using clearly shown dates and assessed-event counts. Do not claim that a before-and-after change proves the recommendation caused the improvement.

Suggested implementation safeguards:

- Persist alert/conversation state to avoid sending the same notification on every processing cycle.
- Associate replies with a specific alert, item, or bin; ask for clarification when the reply is ambiguous.
- Make incoming message handling idempotent so duplicate webhook delivery does not repeat actions.
- Use the configured Photon channel; no messaging channel has been selected yet.

## Estimated bin contents, Grok Imagine, and emptying

Estimate fullness from tracked disposal events, approximate item volumes, and known bin capacity. The numerical estimate drives emptying alerts. Grok Imagine illustrates that estimate; generated images do not determine physical fullness.

Suggested baseline calculation, subject to explicit calibration assumptions:

```text
estimated_volume = sum(estimated deposited item volumes since last confirmed emptying)
estimated_fullness = estimated_volume / bin_capacity
```

Packing, crushing, nesting, liquids, and missed items affect this approximation. Label fullness as estimated, retain unknown-content information, and keep observed counts distinct from estimated volume. Do not present it as a verified measurement.

For Grok Imagine:

- Generate an illustrative view of each bin's estimated contents from its tracked inventory.
- Label the output as generated and illustrative.
- Show counts and fullness numerically alongside the image.
- Do not infer exact counts by examining the generated image.
- Include a snapshot timestamp so users know which inventory the image represents.
- Decide and document refresh cadence; do not assume a new image is required for every frame or event.

Emptying workflow:

1. Estimated fullness crosses a configurable threshold; the numeric threshold is unresolved.
2. The agent asks the responsible manager through Photon to empty the identified bin.
3. The manager texts back confirming it has been emptied.
4. Reset that bin's current inventory estimate and associated visualization state.
5. Preserve historical disposal events, sorting statistics, recommendations, and interventions.

Automatic visual detection of bin emptying is not required. The manager's confirmation is the required reset mechanism. Handle delayed confirmations carefully: retain deposits occurring after the actual emptying time where that time is known. Initial contents at onboarding and ambiguous emptying times remain open decisions.

## Dashboard

Required product capabilities, organized into suggested screens:

- Site overview: all stations/bins, estimated fullness, recurring item mistakes, pending reviews, and active alerts.
- Station/bin detail: camera association, disposal history, current inventory estimate, generated contents illustration, and last confirmed emptying.
- Item detail: business association, correct destination, combined time-weighted correct-sorting percentage, assessed-event count, and station breakdown.
- Packaging catalog: area-manager maintenance of reference photos, business associations, and disposal rules.
- Review queue: unresolved item origins with evidence and manual assignment.
- Recommendation history: messages, response status, implementation confirmations, and before-and-after comparisons.

Expose insufficient-data and uncertainty states. Make demo mode visible. Exact layout and visual design are implementation choices.

## Suggested architecture and data boundaries

No language, framework, database, CV model, or hosting target for inference has been confirmed. Choose tools based on repository contents, hardware, available credentials, and demo constraints. Do not treat the following component split as a mandated stack:

- Dashboard frontend on Vercel.
- Video-processing worker for decoding, detection, tracking, and evidence extraction.
- Application API and persistent store for configuration, events, review, metrics, and message state.
- Scheduled/background jobs for alert eligibility, 24-hour follow-ups, and image generation.
- Photon adapter for outbound messages and inbound replies.
- Grok Imagine adapter for inventory illustrations.

Keep long-running video processing outside ordinary short-lived frontend request handlers. Isolate integrations behind interfaces so demo mocks are explicit and replaceable.

Suggested core records:

- Site, business, manager/contact, station, camera, bin.
- Catalog item and reference image.
- Disposal event and review decision.
- Bin-emptying event/inventory epoch.
- Alert, message, reply, and intervention.
- Generated inventory image with source snapshot.
- Configuration profile for normal use or demo.

Use stable IDs and preserve enough source data to recompute metrics after manual corrections. Resetting inventory must not delete historical events.

## Demo delivery sequence

1. Configure a shared outdoor site, participating restaurants, bins, and a small catalog.
2. Stage and record visible correct and incorrect disposal events, emphasizing recoverable items entering trash.
3. Manually label the clip for evaluation: item, destination, business where knowable, and event timestamp.
4. Process the footage and show events in the dashboard.
5. Demonstrate uncertain attribution entering the area-manager review queue.
6. Show combined item scoring and a threshold-triggered Photon recommendation under documented demo parameters.
7. Confirm an intervention by text and show the recorded action. A subsequent staged clip may illustrate the comparison, clearly labeled as staged rather than a real-world impact result.
8. Show numerical fullness estimates and a Grok Imagine contents illustration.
9. Demonstrate an emptying request and manager reply resetting only the identified bin's inventory.

Do not imply that staged footage proves robust performance across arbitrary surveillance cameras. Report what was actually evaluated.

## Verification and completion expectations

Verify at least:

- One disposal produces one event despite repeated frames or reprocessing.
- Correct/incorrect/unknown classification follows configured rules.
- Uncertain origins are queued and do not trigger misattributed restaurant messages.
- Review corrections recompute relevant statistics without duplication.
- Time weighting, combined aggregation, zero-data handling, and minimum-evidence gating work.
- Demo parameters are separate from normal-use parameters.
- Alerts are not repeatedly sent on every metric update; the 24-hour no-response rule works.
- Manager replies link to the correct action/bin, including duplicate-delivery handling.
- Emptying confirmation resets one bin's current contents without deleting history.
- Generated illustrations are linked to the correct bin and inventory snapshot.

Compare CV outputs against manually labeled staged footage. Report event-counting and destination errors, identification errors, and the fraction of events the system could assess. Numerical acceptance targets remain to be agreed.

Before calling the prototype complete, provide repository setup instructions, configuration documentation, example environment variables, footage/catalog preparation instructions, a runnable demo path, and an honest list of working versus mocked integrations. Confirm deployment separately from local execution.

## Remaining decisions

Ask about these only when needed, one question at a time:

- Team, deadline, available compute, and access to Photon/Grok credentials.
- Initial item catalog, footage, and condition-dependent sorting rules.
- CV model, inference approach, camera calibration, and future camera protocols.
- Correct-sorting threshold, exact demo values, and evidence-recency rule.
- Post-response alert behavior and reminders after the first 24-hour follow-up.
- Photon channel and manager/contact routing, especially shared-bin emptying responsibility.
- Bin capacities, source of item-volume estimates, and fullness-alert threshold.
- Initial inventory assumptions, delayed emptying confirmation, and image refresh cadence.
- Before-and-after comparison windows and evaluation acceptance targets.

Keep the build centered on the complete loop: observe disposal -> identify recurring mistakes -> recommend an action -> record the manager's response -> show subsequent sorting behavior.
