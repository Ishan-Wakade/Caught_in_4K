# Caught in 4K — voice guidance at the bin: roadmap and design

Date: 17 Oct 2026. Author: Agent E (worker/contracts), from Eymen's direction in session.
Status: **draft for the team's approval**. Items marked *(E's call)* are implementation choices, not team decisions;
items marked **Decided** are the team's words.

## 1. Why this change

Until now the product watched what went into which bin and, afterwards, messaged managers about repeated mistakes.
The new direction adds a moment that helps *before* the mistake: when a person carrying waste walks up to the bins,
a speaker on the bins tells them which bin the item belongs in. A business needs only one extra piece of hardware,
a speaker at the bins; the camera is their existing surveillance camera.

Success looks like: the person hears the right bin *before* they reach the bins, every time someone brings waste,
with no setup beyond calibrating the camera once.

## 2. Decided by the team

- **Keep the stack:** YOLO11n-pose (skeleton), FastSAM, CLIP, DeepSeek, Jev, and the surveillance-camera tracking of
  what category each waste item is.
- **Trigger:** when a person carrying an item (YOLO skeleton + the item in their hand) gets close to the bins.
- **Message structure, forced as JSON:** the first thing heard is exactly one of three words: **compost**, **trash**,
  **recycle**; then a short explanation, e.g. "aluminum can, placed in recycling".
- **Known item types** (in the store's catalog): the message is immediate.
- **Unknown item types:** an LLM identifies what it is (DeepSeek for now, the Claude API soon) and Jev decides the bin
  under the local rules, then the message is spoken.
- **No separate box per bin is needed for the trigger.** A person with waste moving close to the bin area is enough.
  False positives (thinking someone is going to the bins when they are not) are acceptable.
- **The model must be fast**, so the message reaches the person before they reach the bin.
- **Use a 2D-to-3D understanding of the room** to judge better when a skeleton with waste is getting close to a bin.
- **One container per store**, connected to that store's surveillance camera, so each copy adapts to the products
  consistent at that store, and we never hold companies' data.
- **Customer UI (last):** shows how many items were categorized, split into categories and subcategories; looks
  different per company; has authentication and authorization.
- **Live presentation demo (last):** a laptop webcam with a separate tuned copy that identifies items held up to it,
  standing in for one store's tuned copy. Not the full product.
- **Order (Decided):** this document → the team films the demo video while E builds the model → the team sends the
  videos and E shows the model's results → container once the team is satisfied → customer UI and live webcam demo.

## 3. Phases and steps

### Phase 0 — this document (E)
1. Write the roadmap (this file); reviewer pass; team approves via the PR.

### Phase 1 — the voice-guidance model (E builds; the team films in parallel)

Goal: from the corner camera's footage, announce the right bin before the person reaches it.

**1a. Fast path, frame by frame** *(E's call, to meet "must be fast")*
- Run only what the announcement needs on every frame: **YOLO11n-pose** (about 25 ms/frame measured on this Mac)
  and **CLIP on the two hand crops** (2 crops, not ~50 regions). Expected well above 15 fps on an M-series Mac.
- FastSAM, the full item tracker and DeepSeek/Jev stay in the slower path that records what went where (Phase 1e).
  They no longer block the announcement.

**1b. "Close to the bins" from the floor (the 3D part)** *(E's call on how)*
- The camera is fixed, so the room's floor is a flat plane seen in perspective. A one-time calibration (four floor
  points with known spacing, e.g. a 1 m square of tape) maps image pixels on the floor to meters (a homography).
- The skeleton's **ankles** are on the floor, so each person gets a real floor position and walking speed. The bin
  area is one marked floor region. Trigger = holding an item AND within *D* meters of the bin area AND moving toward
  it (or already inside it).
- Lead time is set in seconds, not meters: announce when the predicted arrival is ≤ *T* s away (starting value
  2.5 s; the floor distance gives the prediction).
- Fallback when the floor is not visible: a monocular depth model (Depth Anything V2 small) to estimate distance.
- Not chosen: a full 3D reconstruction of the room from one image. It costs far more and adds nothing the
  trigger needs.

**1c. Identify early, speak on arrival**
- Identification starts as soon as an item is seen in a hand, while the person is still walking, so the answer is
  ready before the trigger fires.
- **Known catalog item:** CLIP zero-shot plus the store's reference photos (gallery). Message comes from the catalog
  (its bin and name). No network call.
- **Unknown item:** LLM on item crops only (never whole frames) → generic type → **Jev** → bin; spoken immediately and
  cached per type so repeats are fast. It becomes a catalog ("known") item only when the manager approves it (§7).
- **LLM provider is swappable:** one interface; DeepSeek now (`deepseek-flash`, vision, thinking off), the Claude API
  next. Same JSON output either way.
- Measured today: DeepSeek 1–2 s per call, Jev about 0.1–0.5 s; so identification must start ≥ 3 s before the
  announcement. Where it cannot finish in time, the rule below applies.

**1d. The spoken message (JSON-forced)**
```json
{"bin": "recycle", "explanation": "aluminum can, placed in recycling"}
```
- `bin` ∈ {"compost", "trash", "recycle"}: a JSON-schema enum, validated before speaking. Spoken as `"<bin>. <explanation>"`.
- `explanation` ≤ 8 words; built from a template for catalog items, from the LLM/Jev result for new items.
- If no answer is ready when the trigger fires *(E's call)*: speak nothing rather than guess, and log it. (Jev's
  "special drop-off" answer has no fourth word; *open question 5*.)
- **Voice:** the three bin words and every catalog item's explanation are generated once at startup and played from
  memory (no delay); only new items' explanations are synthesized at run time. Provider: *open question 2*.
- One announcement per person per visit to the bins (cooldown), so a person standing at the bin is not repeated.
- Output: the speaker on the laptop running the container (the store's speaker at the bin).

**1e. Keep recording what went where**
- The existing item tracker, events, dashboard data and manager messages keep running on the same footage
  (Decided: keep tracking categories). Each announcement is logged with time, person track, item and bin said.
- *Open question 1:* whether to keep one-time per-bin boxes for this recording side (see §6).

**1f. Measure**
- On the team's demo videos: announcements made / people who brought waste; the right bin said; **lead time**
  (seconds between the announcement and the item entering a bin); false announcements; time from "item first seen"
  to "answer ready". Report dev and held-out clips separately, as before.
- Output for review: the processed video with the voice mixed into its audio track and the trigger shown on screen.

**What the team films (Phase 1, team)**
- One phone, fixed in a corner, high enough to see the bins and the floor in front of them (like a surveillance
  camera). Do not move it during or between takes.
- A one-time calibration shot: a 1 m × 1 m square of tape on the floor in front of the bins, visible in the frame.
- Takes: people walking up with known catalog items, with items not in the catalog, someone passing by without
  waste, two people at once, people walking up fast.
- Keep a few takes aside, unseen by E until the end, for an honest held-out score.

### Phase 2 — container per store (after the team approves Phase 1)
- One Docker image: the worker, its models and weights, a local web endpoint; configured by one file per store
  (camera address, floor calibration, catalog, local rules, speaker output).
- **Camera input:** a live source for RTSP / ONVIF IP cameras (the standard for surveillance cameras), in addition to
  recorded files.
- **Data stays on site:** footage, crops and logs stay in the store's container. *Open question 3:* cloud LLM/Jev calls
  send item crops/text out of the store; either each store uses its own API keys, or new-item identification runs on
  a local model.
- **Per-store adaptation ("tuned copy"):** every new item type the store's manager approves, and every reference
  photo, is stored locally, so that store's copy recognizes its own products faster and better over time. Optional
  later: retrain a small classifier head on the store's own approved crops. *(Wording: "adapts to each store"; true
  retraining only once enough labeled crops exist.)*
- Hardware: Docker on a Mac cannot use the Mac GPU; a store box needs Linux with an NVIDIA GPU, or must be shown fast
  enough on CPU. To be measured before promising frame rates.

### Phase 3 — customer UI (last)
- Per company: number of items categorized, split into categories (compost / trash / recycle) and subcategories
  (item types), over time; per site/camera.
- Authentication (login) and authorization (each company sees only its own sites; roles such as company admin,
  site manager). Different look per company (branding).
- *Open question 4:* where it runs (in the store's container vs our cloud with only counts uploaded).
- Ownership: web (J) and core (I) per the root AGENTS.md; E supplies the data contract.

### Phase 4 — live presentation demo (last)
- Laptop webcam; a person holds an item up; the laptop speaks "<bin>. <explanation>" with the same JSON message.
- A separate copy tuned to the demo's props: reference photos of each prop taken with the same webcam (the existing
  `enroll` path) plus their catalog entries, so the props are "known" and answered immediately; one unknown prop
  shows the LLM + Jev path.
- Not the full product: no floor calibration, no tracking; the trigger is "an item is held up close to the camera".

## 4. Non-goals and anti-goals
- Non-goal: identifying people. Skeletons and crops of items only; faces never leave the device.
- Anti-goal: telling someone the wrong bin with confidence. When unsure, say nothing (and log it) rather than guess.
- Anti-goal: an announcement that arrives after the item is already in a bin. Measured as lead time.
- Non-goal: a full 3D model of the room.

## 5. Constraints
- Footage and company data must not be held by us (container per store).
- The model must answer before the person reaches the bin (seconds, not minutes).
- API keys live outside the repo (as today: `~/.config/recyclone/*.env` locally; per-store config in the container).
- Local disposal rules come from the city's own text and are approved by a person before they count.

## 6. Team answers (17 Oct)
1. **This is the project now.** The voice guidance replaces the earlier demo plan (manager messages, Grok images, the
   six scenarios are no longer the target). The worker keeps recording what it sees, but nothing else is maintained
   for the old demo.
2. **One box for the entire set of bins** (the "bin area"), not one per bin. So the system records that an item was
   brought to the bins and what it was told, not which bin it actually went into.
3. **Default to trash only when very uncertain:** if the best answer is below 50% confidence (or no answer is ready
   when the person arrives), say "trash". Otherwise say the answer.
4. **One standard for the right bin:** E picks the most sensible source and standardizes it. *(E's call:)* the site's
   official local rules (for the demo, Cambridge's own guide in `worker/rules/cambridge-ma-2022.md`) are the single
   source; every catalog item's bin is checked against them, and where the rules do not decide, the catalog note says
   so and a person decides.
5. **Items that go in none of the three bins** (batteries, electronics, chemicals; the city says never in the trash):
   the fourth first word is **None**, followed by "<item> is dangerous to place in any of these bins. Place it in
   <drop-off> instead" (team, 17 Oct), e.g. "None. Battery is dangerous to place in any of these bins. Place it in
   the Recycle Center instead." The drop-off place comes from the local rules text.
6. **Voice before the video (new):** the voice must work before the team films, so the demo video shows it speaking.
   *(E's call)* The model therefore runs on a **live camera** too: a webcam, the iPhone as a Mac camera (Continuity
   Camera), or a store's IP camera; recorded files still work for testing.

7. **Demo video setup (team, 17 Oct):** one phone acts as the surveillance camera and the laptop runs the model
   and acts as the speaker, all locally. *(E's call)* The iPhone feeds the Mac live through Continuity Camera
   (or an RTSP camera app as a fallback); `recyclone-worker guide --source <index> --area pick --show --cctv
   --render demo.mp4` speaks through the laptop (or a Bluetooth speaker placed on the bins) and records the
   annotated video with the voice.

## 7. Settled after the review pass *(E's calls)*
- **Speed, honestly:** the announcement path (skeleton, hand-crop CLIP, floor distance, trigger) is built causal —
  it only uses past frames, as on a live camera — and must run at or above the camera's frame rate on the demo
  laptop; that rate is measured and reported. The Phase 1 deliverable for review is the processed video with the
  voice mixed in. The slower recording side (FastSAM item tracker, events) may still run offline ("analyzed
  beforehand") and is described that way.
- **New items:** spoken immediately (Decided, §2). The LLM + Jev answer is cached per item type so repeats are fast,
  but a cached answer is **not** an approval: the type joins the catalog only when the manager approves it (as in the
  existing proposed-type flow, contracts §1.1).
- **Announcement logs** stay local in Phase 1; a contract change for them comes with Phase 3, once the UI's counts are
  defined.
- **Voice:** behind one interface; the operating system's built-in voice until the team picks a provider.
- **Filming addition:** a short reference take with the same fixed phone — each demo item held up for ~3 s — so
  known items are recognized from the store's own camera (the existing `enroll` path; phone or web photos were
  shown not to match reliably).
- **Lead time without bin boxes:** if open question 1 drops bin boxes, E hand-labels the moment each item enters a
  bin on the team's takes to measure lead time.

## 8. Left to the builder (E)
Frame-skip and resolution settings, cooldown lengths, the exact trigger distance and lead time after measuring on
the team's videos (dev clips only), caching, retries and timeouts, logging format, and test strategy.
