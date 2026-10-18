# Caught in 4K — project instructions

## Read first

Build voice guidance at the bins: identify the waste item someone is carrying and tell them its correct destination before they dispose of it. The product uses a store's existing surveillance camera and a speaker at the bins, with one locally configured container per store.

The source design is [Voice guidance at the bin: roadmap and design](docs/superpowers/specs/2026-10-17-voice-guidance-roadmap-design.md), dated 17 October 2026. It is a design document, not evidence that features work. This file consolidates its current direction. In that document, the later **Team answers (§6)** override conflicting earlier statements; **Settled after the review pass (§7)** supplies implementation guidance. Builder proposals and open questions remain proposals and open questions.

The root README describes the intended finished product. Inspect implementation and current artifacts before claiming a capability is complete. Older code, plans, footage scripts, fixtures, and integrations may reflect the previous product; their presence does not make them current requirements.

## Current product scope

- Recognize a person carrying an item, identify its product type, and announce the correct destination early enough to affect their choice.
- Mark **one bin area for the entire set of bins**. Separate boxes for each bin are not required.
- Chalk integration, bin overlays and render changes are restricted to the prerecorded `--prepared` workflow. Keep live model providers, tracking, speech and rendering unchanged; use the separate `prepared_*` adapters. See `docs/chalk.md` and `docs/bin-overlays.md`.
- Record items brought to the bin area, their categories, and the guidance given. This design does not establish which individual bin an item actually entered.
- Keep transient person tracks for approach and cooldown logic; do not identify people.
- The old demo centered on manager messages, Grok bin illustrations, fullness alerts, and six disposal scenarios is superseded. Do not maintain or extend that demo as part of this roadmap unless the user requests it.

## Build order

1. **Model and working voice guidance.** Complete early identification, approach detection, local-rule selection, and spoken output. Voice must work before the team films the demonstration. Support live camera input as well as recorded files for testing.
2. **Filming and model review.** Use the team's fixed-camera footage to produce annotated videos with voice, measure results, and resolve model failures. Footage collection and model development can iterate together once voice works. Keep held-out takes separate. Obtain the team's satisfaction with Phase 1 before containerization.
3. **One container per store.** Package the worker, models and weights, configuration, and a local web endpoint. Add surveillance-camera input and validate deployment hardware performance.
4. **Customer dashboard.** Define the announcement/counting contract, add company-specific presentation, authentication, and authorization, and expose category/subcategory counts per site and camera over time.
5. **Separate live presentation demo.** Use a webcam and prepared reference images for the demo props. Include one unknown item to show the LLM and Jev path. This simplified hold-up demo is separate from the full approach-detection product.

## Model and timing

Retain YOLO11n-pose, FastSAM, CLIP, DeepSeek, and Jev, using each where it helps the current workflow:

- **Fast announcement path:** YOLO11n-pose locates people and hands; CLIP evaluates hand crops against text descriptions and store references. Start identification as soon as an item is visible, while its carrier is still approaching. Avoid running full-scene segmentation or waiting on a future frame before triggering speech.
- **Known item:** use the store's approved catalog name and destination, with no network call needed for the decision. Cache its spoken audio at startup.
- **Unknown item:** send item crops to a swappable vision-language interface: DeepSeek first, Claude next. Describe the generic type, then use Jev with the site's official local rules to select a destination. Start requests early and keep them off the frame-processing critical path. Cache answers by item type and relevant rule context. Cached suggestions are not manager approval; only approved types join the known catalog.
- **Approach:** estimate when a person holding waste will reach the bin area. The proposed method is a one-time floor homography from four known points, using ankle positions to estimate floor distance and speed. The initial 2.5-second trigger lead time is provisional. Depth Anything V2 small is a proposed fallback when the floor is unavailable; full room reconstruction is not required.
- **Slower recording:** FastSAM and the existing item tracker can support offline analysis. Do not make them block the spoken guidance or imply offline results demonstrate real-time operation.
- **Voice:** use one provider interface, initially the operating system's built-in voice. Pre-generate catalog speech; synthesize new explanations when needed. Announce once per person per visit, with a measured cooldown.

The announcement path must use only current and past frames. Measure throughput and end-to-end latency on the actual target device; earlier model timings and expected frame rates are not acceptance results for this path. On-device frame processing alone does not prove that unknown-item answers arrive in time.

## Destination and speech policy

Use structured JSON validated against an explicit destination enum before speaking. The normal message is (team, 17 Oct evening):

```json
{"bin": "recycle", "item": "aluminum can", "place": "recycling", "reason": "metal cans are recyclable in Cambridge"}
```

spoken as "Recycling. Aluminum can should be placed in recycling because metal cans are recyclable in Cambridge."

- The first word is `Recycling`, `Compost`, or `Trash` (`None` for dangerous items); the item is at most six words and the reason at most fourteen. Catalog reasons are fixed per item in the bin table (written from each item's rule basis); for a new item the vision LLM (Claude Haiku 5.5 by default; DeepSeek optional) writes a reason for each destination and the reason of the destination Jev chooses is spoken.
- Per the later team decision, when the best answer is below 50% confidence or no answer is ready on arrival, announce `trash`. This supersedes the draft's earlier silence fallback. Log that fallback; do not present its confidence as calibrated accuracy.
- For recognized items that local rules exclude from all three bins, the first word is `None`, the place is the disposal location from the local rules, and the reason is that the item is dangerous in any of these bins. Preserve an already known special-disposal determination when handling uncertainty or delays elsewhere in the pipeline.
- The site's official local rules are the common standard for catalog entries and Jev suggestions. The demo source is `worker/rules/cambridge-ma-2022.md`; its age and applicability must be checked for the intended deployment. If the rules do not decide a case, record that ambiguity and obtain a human decision.

## Data and deployment

- Target one Docker container per store, configured with its camera, floor calibration, catalog/reference images, local rules, and speaker output.
- Support recorded inputs for evaluation and live webcam/phone-camera inputs for development; production camera connectivity targets RTSP/ONVIF.
- Store footage, evidence crops, reference images, announcement logs, approved item types, and company data locally. Do not centrally collect them by default.
- Cloud vision/Jev use is an unresolved boundary: crops or descriptions leave the store for those calls. Resolve per-store credentials/provider data handling or a local-model path before claiming fully local processing. Send item crops only, never full frames; keep faces out of outbound crops.
- Per-store adaptation initially means approved catalog entries, same-camera reference images, and caches. Describe actual model retraining only after implementing and evaluating it on enough labeled crops.
- Keep secrets outside Git and out of browser bundles. Use configuration/environment variables without committing real keys.
- Validate container runtime and GPU access separately from native Mac development. The design calls for Linux/NVIDIA hardware or measured CPU performance for store deployment; do not assume Mac MPS behavior carries into Docker.

- **Public "Try your video" tab (user decision, 17 Oct):** visitors upload their own clip from `/upload`. `worker/modal_app.py` runs `recyclone_worker/job.py` (the prerecorded `guide --prepared --headless --render` pipeline) on Modal and returns the annotated video for viewing and download. This is a deliberate cloud exception for visitor-supplied videos, not store footage. Keep its limits (size, length, per-IP and daily caps, 24 h retention) and provider keys in Modal, never in the browser. Label it as a demo of offline processing, not real-time store operation.

## Dashboard requirements

- Report how many items were categorized, grouped into trash/recycle/compost and item-type subcategories, over time and by site/camera. Define how `None`, fallbacks, and repeat visits appear before finalizing counts.
- Track what was recognized and announced. Do not label those counts as verified disposals, sorting accuracy, contamination reduction, or actual-bin outcomes.
- Provide authentication and enforce company/site access on the server. Authorization must cover data reads and writes, with roles such as company admin and site manager; frontend filtering is insufficient.
- Support company branding and manager approval of proposed item types.
- Dashboard hosting remains open: in the store's container or a cloud service receiving only explicitly agreed aggregates. Existing Vercel code is not a hosting decision for this product.
- Keep Phase 1 announcement logs local. Introduce shared announcement/count contracts when the dashboard's metrics are defined; do not force the old disposal-event schema to mean an announcement.

## Filming and verification

- Film with a fixed camera overlooking the bin area and approach floor. Capture a 1 m square for calibration and a same-camera reference take holding each known item for about three seconds.
- Cover known and unknown items, a person passing without waste, two people together, and fast approaches. Keep unseen takes for final evaluation; do not tune on them.
- Report announcement coverage, correct destinations, false announcements, identification latency, and lead time before actual disposal, with dev and held-out results separate. Hand-label disposal times for lead-time evaluation even though the production system need not determine the actual destination bin.
- Deliver a processed video with voice mixed into its audio and the trigger visible. Identify prerecorded inputs, offline analysis, mocks, shortened timing, and the separate webcam presentation honestly.
- Verify one announcement per visit, deadline fallback, special disposal, cached versus unapproved types, and provider failures. For the dashboard, test cross-company/site access isolation. Never treat generated data or staged behavior as proof of real-world impact.

## Working rules

- Preserve existing and uncommitted work. Inspect relevant code and contracts before editing.
- Do not commit, push, merge, reset, or otherwise mutate Git history without explicit user authorization. Authorization for this documentation cleanup is not blanket authorization for future work.
- Keep changes focused on the active phase. Do not revive historical workflows merely to satisfy old documentation.
- Keep provisional thresholds, hardware assumptions, provider choices, UI hosting, and numerical targets explicit and configurable. Ask a focused question only when a material unresolved choice blocks progress; continue independent work.
- Run verification appropriate to consequential changes and report what was actually checked. Do not invent accuracy, completed integrations, deployments, or privacy guarantees.
- Update this file when confirmed decisions change, and keep the README aligned with the intended product without presenting planned features as implemented.
