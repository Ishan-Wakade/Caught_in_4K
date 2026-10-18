# Caught in 4K

**The right bin, before the item gets there.**

Caught in 4K is being built to give customers spoken waste-sorting guidance as they approach a store's bins. It will use the store's existing surveillance camera to recognize what someone is carrying, apply local disposal rules, and announce the destination through a nearby speaker before they throw the item away.

> This README describes the intended finished product. The repository is a prototype in development; the capabilities below are the target, not a claim that deployment, real-time performance, authentication, or every integration is complete. The [voice-guidance roadmap](docs/superpowers/specs/2026-10-17-voice-guidance-roadmap-design.md) defines the build sequence, and [AGENTS.md](AGENTS.md) contains current implementation instructions.

## The customer experience

A customer walks toward the bins holding an aluminum can. The camera recognizes the item while they approach. Before they arrive, the speaker says:

> **Recycle. Aluminum can, placed in recycling.**

The customer will not need to scan a code, open an app, or hold each item in front of a dedicated scanner. The goal is to make the correct destination clear during the approach to the bins.

The destination will come first: **compost**, **trash**, or **recycle**, followed by a short explanation. Items that belong in none of those bins will receive a **None** announcement with the special-disposal instruction from the local rules—for example, directing a battery to an appropriate collection point.

## How it will work

1. **See the item early.** The camera locates a person carrying waste and evaluates the item in their hand while they are still approaching.
2. **Recognize its type.** Familiar products will match the store's approved catalog and reference images. An unfamiliar item will be described by a vision-language model and evaluated against local rules by Jev.
3. **Speak at the right moment.** A calibrated view of the floor will help estimate the person's approach to the bin area. The system will play the destination and explanation once per visit, with familiar-item audio prepared in advance.
4. **Keep a useful record.** The store will retain the recognized item type, category, time, and guidance given. A manager will be able to approve new item types so future visits can use the known-item path.

The current design uses one marked area for the entire group of bins. Its records will describe **items brought to the area and destinations announced**. They will not establish which individual bin the customer actually used or whether the customer followed the guidance.

Uncertainty and late answers will be recorded. The current policy defaults uncertain ordinary items to trash when confidence is below 50% or the answer is not ready on arrival; recognized special-disposal items retain their separate instruction. Cached suggestions will remain distinct from manager-approved catalog entries.

## A separate deployment for each store

Each store will run its own Docker container connected to its camera and speaker. Configuration will define the camera connection, bin area, floor calibration, product catalog, reference images, local disposal rules, and audio output. Production camera support will target RTSP/ONVIF connections.

The store's copy will adapt through approved product types, reference images captured by its own camera, and cached decisions. This does not require retraining a model for every store; optional retraining can follow when enough labeled examples exist.

Footage, reference images, crops, and detailed logs are intended to remain on the store's infrastructure. Cloud recognition calls would send item crops or descriptions to the selected providers. The deployment design must resolve store-controlled API credentials and provider data handling, or use local inference, before claiming fully local processing. Full video frames and faces are not intended inputs to those cloud calls.

## A dashboard for each company

The finished dashboard will show how many items were categorized over time, with breakdowns by destination, product type, site, and camera. Special-disposal results and fallback decisions will be distinguished as the reporting contract is finalized.

Companies will have their own branding, authenticated accounts, and server-enforced access controls. Roles such as company admin and site manager will determine which sites and actions a user can access. Managers will be able to review proposed item types and approve additions to their store's catalog.

The hosting location remains to be decided: the dashboard may run locally with the store deployment, or a central service may receive explicitly agreed aggregate counts. Categorization counts will not be presented as verified disposal outcomes or evidence of reduced contamination.

**Current state of the dashboard prototype.** A Postgres-backed catalog exists today: items the camera can't match against the approved catalog land in a New items review queue, and a manager's approve or reject decision writes back to the same database the Catalog page reads from. Bins and a Live-footage camera-wall page (recorded demo clips, not a live feed) are also live for internal monitoring. The Sites page still renders placeholder data, and the dashboard has no authentication or per-company access control yet—anyone who can reach it can see and approve everything.

## Technology

| Component | Role in the target product |
| --- | --- |
| Python, OpenCV, NumPy | Video input, image crops, geometry, and worker orchestration. |
| YOLO11n-pose | Locates people, hands, and floor positions for carrying and approach detection. |
| CLIP | Matches hand crops to product descriptions and store reference images. |
| DeepSeek and Claude (Haiku 5.5) | Swappable vision-language identification for unfamiliar items; the live guide defaults to DeepSeek, the recorded-demo pipeline defaults to Claude. |
| Jev | Selects a destination using the item description and local disposal rules. |
| Chalk Model Gateway (optional prerecorded path) | Routes unknown-item vision and Jev calls through configured provider connections; records gateway requests, latency, token usage and separate local cache counts. See [setup and verification](docs/chalk.md). |
| FastSAM and the item tracker | Supports the slower analysis path without blocking announcements. |
| Speech provider interface | Plays cached known-item guidance and synthesizes new explanations; starts with the operating system's voice. |
| Docker | Packages a separately configured deployment for each store. |
| Next.js, React, TypeScript, Tailwind CSS | Foundation for the customer dashboard and API. |
| Shared schemas and backend storage | Will define validated announcement records, category counts, approvals, and access boundaries; the existing backend includes PostgreSQL. |

Hardware performance will be measured on the deployment device. Native Mac model performance does not establish container performance or the time needed to recognize an unfamiliar item through cloud APIs.

## Delivery plan

1. Build and measure the live announcement path, including working voice output before filming.
2. Film fixed-camera scenarios and evaluate the model with annotated, voiced recordings. Keep development and unseen evaluation takes separate.
3. Once the team is satisfied with the model, package and validate the store container and camera connections.
4. Build the company dashboard, reporting contract, authentication, and authorization.
5. Prepare a separate webcam presentation demo with known props and one unfamiliar item. This simplified hold-up demo will illustrate recognition and speech, not the full surveillance-camera workflow.

Evaluation will measure announcement coverage, correct destinations, false announcements, recognition latency, and how much time the customer has between hearing the guidance and disposing of the item. Prerecorded footage, offline analysis, staged behavior, and live results will be identified explicitly.

## Try your own video

The public site's **Try your video** tab lets a visitor record or upload a short clip of themselves throwing something away. They get back the annotated video with the spoken guidance mixed in, which they can download. The clip is processed by the prerecorded-demo pipeline on a cloud GPU (Modal; see [deployment](docs/deployment.md)) and deleted after 24 hours. This is a demonstration of the recognition and speech on someone's own footage, not the store deployment. Results on footage the pipeline was not tuned on can be poor, and processing takes minutes, not real time.

## Repository guide

- `worker/` — Python perception, identification, tracking, and video tools; the starting point for voice guidance.
- `contracts/` — shared types and validation schemas; announcement/counting contracts will be introduced as their semantics are finalized.
- `packages/core/` — backend logic and persistence.
- `packages/integrations/` — integration adapters from the prototype.
- `apps/web/` — dashboard and API application. The dashboard's Catalog and New-items pages are backed by a real Postgres database; Bins and a Live-footage camera-wall page sit alongside them.
- `docs/superpowers/specs/2026-10-17-voice-guidance-roadmap-design.md` — source roadmap, including the later team decisions.

Some existing modules and documents describe earlier iterations. Use the root [AGENTS.md](AGENTS.md) and the voice-guidance roadmap to determine the active product direction.
