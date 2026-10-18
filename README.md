# CAUGHT IN 4K
AI-powered waste sorting mechanism to improve eco footprint and assign responsibility to individual disposal. 📸 ♻️ 🚮 🌎

Caught in 4K was built to give customers waste-sorting guidance as they approach bins. It uses the store's existing surveillance camera to recognize what someone is carrying, apply local disposal rules, and announce the destination through a nearby speaker before they throw the item away.

## CUSTOMER EXPERIENCE

Person walks toward the bins holding a soda can. The camera recognizes the item while they approach. Before they arrive, the speaker says:
-  *"Recycle. Aluminum can, placed in recycling."*

The customer doesn't scan a code, open an app, or hold each item in front of a dedicated scanner. The goal is to make the correct destination clear during the approach to the bins.

The destination will come first: **compost**, **trash**, or **recycle**, followed by a short explanation. 

## HOW IT WORKS

1. **See the item early.** The camera locates a person carrying waste and evaluates the item in their hand while they are still approaching.
2. **Recognize its type.** Familiar products will match the store's approved catalog and reference images. An unfamiliar item will be described by a vision-language model and evaluated against local rules by Jev.
3. **Speak at the right moment.** A calibrated view of the floor will help estimate the person's approach to the bin area. The system will play the destination and explanation once per visit.
4. **Keep a useful record.** The store will retain the recognized item type, category, time, and guidance given. A manager will be able to approve new item types so future visits can use the known-item path.

Uncertainty and late answers will be recorded. The current policy defaults uncertain ordinary items to trash when confidence is below 50% or the answer is not ready on arrival; recognized special-disposal items retain their separate instruction. Cached suggestions will remain distinct from manager-approved catalog entries.

## DISCRETE DEPLOYMENT 4 EACH OWNER

Each store will run its own Docker container connected to its camera and speaker. Configuration will define the camera connection, bin area, floor calibration, product catalog, reference images, local disposal rules, and audio output. Production camera support will target RTSP/ONVIF connections.

The store's copy will adapt through approved product types, reference images captured by its own camera, and cached decisions. This does not require retraining a model for every store; optional retraining can follow when enough labeled examples exist.

Footage, reference images, crops, and detailed logs are intended to remain on the store's infrastructure. Cloud recognition calls would send item crops or descriptions to the selected providers. The deployment design must resolve store-controlled API credentials and provider data handling, or use local inference, before claiming fully local processing. Full video frames and faces are not intended inputs to those cloud calls.

## DASHBOARD

The finished dashboard will show how many items were categorized over time, with breakdowns by destination, product type, site, and camera. Special-disposal results and fallback decisions will be distinguished as the reporting contract is finalized.

- A Postgres-backed catalog: items the camera can't match against the approved catalog land in a New items review queue, and a manager's approve or reject decision writes back to the same database the Catalog page reads from. 

- Bins 
- Live-footage -> surveillance-camera-wall page for internal monitoring.
- Sites page -> shows sites that waste bins are present at


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


## TRY IT YOURSELF (MODAL)

The public site's **Try your video** tab lets a visitor record or upload a short clip of themselves throwing something away. They get back the annotated video with the spoken guidance mixed in, which they can download. The clip is processed by the prerecorded-demo pipeline on a cloud GPU (Modal; see [deployment](docs/deployment.md)) and deleted after 24 hours. This is a demonstration of the recognition and speech on someone's own footage.

We had a lot of fun collaborating on this project and hope that you enjoy it too!

Please look further on [Vercel](caught-in-4k-app.vercel.app) for the deployement and [devpost](https://devpost.com/software/caught-in-4k-9ci7fv) for the demo vid.
