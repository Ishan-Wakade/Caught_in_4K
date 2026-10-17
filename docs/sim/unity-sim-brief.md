# Unity simulation brief: realistic synthetic data for the Recyclone CV worker

You are building a Unity simulation that renders **realistic security-camera videos of people throwing
items into bins**, with **perfect ground truth**, so that the CV worker in this repo can be tested on
worst cases and a small detector can be fine-tuned. Work only inside `sim/unity/` (new folder) and
`docs/sim/`. Do not edit `worker/`, `contracts/`, `packages/`, `apps/` (other owners). Read first:
root `AGENTS.md`, `contracts/README.md` §1 (DisposalEvent), `worker/AGENTS.md`,
`worker/scripts/synth.py` (the current 2D generator: same output format, simpler scene),
`worker/recyclone_worker/evaluate.py`.

## 0. Non-negotiables (bias and honesty)

1. **Three disjoint splits by random seed.** `train` seeds 0–999 (detector fine-tuning only),
   `dev` seeds 1000–1199 (choosing settings only), `test` seeds 2000–2199 (reported only, **never
   looked at while tuning**). Every clip's config is a pure function of its seed (reproducible).
2. **Test includes the worst cases** at a fixed share (section 4), decided before any results exist.
3. **Simulation is not reality.** The final judge is real data: Eymen's real item photos and the real
   demo video. Always report sim numbers and real numbers separately, and never claim real-world
   accuracy from sim results.
4. **Report every failure honestly**, with per-scenario breakdowns, not just totals. Don't remove hard
   clips from test after seeing results.
5. **Build everything from code** (editor scripts + scene generator), so anyone can regenerate the
   exact dataset from the seeds. No hand-placed one-off scenes.

## 1. Environment

- Unity 6 LTS (6000.3.x or newer) with URP. Personal license is enough.
- Render headless: `Unity -batchmode -projectPath sim/unity -executeMethod Recyclone.SimRunner.Render
  -seedStart 0 -seedEnd 999 -split train -out <dir> -quit` (do NOT pass `-nographics`: it disables
  rendering). Use `Time.captureFramerate` for deterministic fixed-step capture and render to a
  RenderTexture → PNG per frame → `ffmpeg -c:v libx264 -crf 23 -pix_fmt yuv420p` per clip.
- Physics: fixed timestep 1/120 s, continuous collision detection on all thrown items (thin items
  tunnel through bin walls otherwise).
- Large outputs (videos, frames, weights) go **outside git** (cloud drive / GitHub release). Commit
  only code, configs, small samples, and reports.

## 2. Scene (randomized per seed within these ranges)

**Room.** Rectangular, 4 walls + floor + ceiling, 4–8 m × 4–7 m, height 2.6–3.2 m. A door, optionally a
window. Some clutter: a table, 1–4 chairs, a wall poster, a plant (simple meshes are fine).
Materials randomized from a pool of free **CC0** textures (Poly Haven / ambientCG): floor (tile,
concrete, wood, linoleum), walls (paint colors, brick, panels). Keep a `CREDITS.md` with sources.

**Camera (the security camera).** Mounted in a **top corner** of the room at 2.4–3.0 m, pointing down
toward the bins (pitch 25–55° down, yaw so both bins are in frame, not necessarily centered).
Horizontal FOV 80–110°, mild barrel distortion. Resolution 1280×720 by default. Variants: 854×480,
1920×1080. Frame rate 30 by default, variant 15. Bins should cover 5–25% of frame width each (security
cameras are far: small items are the norm).

**Bins: exactly two.** One **trash** bin (gray/black) and one **recycling** bin (blue, recycling
symbol). Height 0.6–1.0 m, open top (variant: hinged/swing lid that items push through), round or
square. Placed against a wall or side by side 0.3–1.5 m apart, randomized. **Physical colliders:** walls
+ bottom (hollow), so items can bounce off the rim, fall in, or fall out. Inside each bin, a **trigger
volume** just below the rim, used only for ground truth.

**Lighting.** Randomize: ceiling lights (1–4, warm/cool, 300–1200 lux equivalent), daylight through the
window (time of day), dim evening, one flickering light (variant), harsh shadows (variant).

**People.** A thrower and, in some clips, passers-by. Use a free rigged humanoid (e.g. Unity Starter
Assets or a Mixamo character) or, at minimum, a capsule body with an arm. The thrower walks in, holds
the item in hand (item parented to the hand bone), and releases it with a randomized velocity. Never
store or label identity. People are only occluders and distractors.

## 3. Products (thrown items)

At least these 15 kinds, each with 2+ visual variants (texture/color/size ±15%), realistic mass and
**convex mesh colliders**:

| Kind (catalog id it maps to) | Bin rule | Notes |
|---|---|---|
| clear plastic cup with lid + straw (`item_generic_cup`; one variant textured as Shake Shack → `item_shakeshack_cup`) | recycling | transparent material (hard case) |
| paper coffee cup (`item_generic_paper_cup`) | trash | |
| plastic bottle (`item_generic_bottle`) | recycling | |
| aluminum can (`item_generic_can`) | recycling | |
| glass bottle/jar (`item_generic_glass`) | recycling | |
| plastic takeout container (`item_generic_container`) | recycling | |
| kraft burger/takeout box (`item_generic_box`; Shake Shack variant → `item_shakeshack_box`) | compost* | |
| clean paper/cardboard (`item_generic_paper`) | recycling | |
| chip bag / snack wrapper (`item_generic_wrapper`; Goldfish/Biscoff/Quaker variants → their ids) | trash | thin, light: model as a slightly crumpled shell |
| plastic cutlery (`item_generic_utensil`) | trash | tiny |
| paper napkin (`item_napkin`) | compost* | |
| food scraps / banana peel (`item_generic_food`) | compost* | |
| small sauce cup (`item_sauce_cup`) | trash | |
| receipt / random paper ball (not in catalog, label `null`) | n/a | "unknown item" case |
| non-waste object carried past (phone, keys, bag) | never thrown | distractor |

*This scene has no compost bin: compost-rule items thrown into either bin are "incorrect"; that is fine
and intended. Catalog ids and rules are in `contracts/fixtures/demo-site.json`. Brand is optional for
this project, so most items should be generic.

Textures: Eymen will provide photos of the real items (local folder, not in git). Open Food Facts
product images (CC BY-SA, keep attribution) can be used for wrappers. Random solid colors and printed
labels are fine for generic variants.

## 4. Scenario mix (fixed BEFORE generating; same proportions in every split)

Each clip is 20–40 s with 1–5 throws and at least 2 s of empty scene at the start (the worker's
background model needs it).

| Scenario | Share | Ground truth |
|---|---|---|
| clean throw/drop into a bin | 25% | disposal, that bin |
| underhand toss from 1–2 m | 10% | disposal or miss, as physics decides |
| bounces off the rim **and falls in** | 8% | disposal |
| bounces off the rim **and lands on the floor** | 8% | **no disposal** |
| dropped on the floor next to a bin | 5% | **no disposal** |
| held over a bin, then carried away | 8% | **no disposal** |
| two people throw at the same moment (same bin and different bins) | 6% | two disposals |
| a passer-by walks between the camera and the bin during a throw | 8% | as physics decides |
| fast throw (item visible ≤ 6 frames before entering) | 6% | disposal |
| tiny item (cutlery, sauce cup) | 5% | disposal |
| swing-lid bin: item pushed through the lid | 4% | disposal |
| item already lying on the floor, kicked/moved | 3% | **no disposal** |
| distractor object carried past, never thrown | 4% | **no disposal** |

**Camera/image conditions** (applied on top, independently): clean 40%; dim + sensor noise 15%;
motion blur 10%; heavy compression (JPEG q 20–35) 10%; camera shake 5%; 15 fps 10%; 854×480 10%.
The **test** split also contains a fixed 20% of "worst" clips combining 3+ hard conditions.

## 5. Ground truth and outputs (exact formats)

Per clip, in `<out>/<split>/<clip_id>/`:

- `video.mp4`: H.264, the camera view.
- `labels.jsonl`: one line per **disposal**, in the contract's DisposalEvent shape with
  `source.mode = "labeled"` (use the same builder logic as `worker/recyclone_worker/evaluate.py:labeled_event`).
  `clip_offset_s` = the first moment the item's center enters a bin trigger **and stays ≥ 0.5 s**.
  `item.catalog_item_id` from the table above (`null` for the receipt). `bin_id` =
  `bin_room_trash` or `bin_room_recycling`.
- `non_disposals.jsonl`: one line per throw/carry that did NOT end in a bin (same shape, plus
  `"outcome": "floor" | "carried_away" | "never_thrown"`), for error analysis.
- `site.json`: a copy of `contracts/fixtures/demo-site.json` reduced to this scene. One camera
  `cam_room_1` and two bins `bin_room_trash` (type trash) and `bin_room_recycling` (type recycling), with
  `bin_regions` = the **screen-space bounding box of each bin's opening**, normalized 0..1, computed by
  projecting the 3D rim into this clip's camera. The worker reads regions from here, so it must be exact.
- `frames/` + `yolo/` (train and dev only, every 3rd frame): PNG frames and YOLO txt labels.
  Class 0 = `item` (any thrown item or distractor object, while at least 20% visible:
  check visibility with raycasts or a segmentation pass), class 1 = `person`. Boxes are the tight 2D
  bounds of the *visible* part.
- `config.json`: every randomized parameter of this clip (seed, scenario, conditions, room, camera pose).

Top level: `manifest.csv` (clip_id, split, scenario, conditions, n_disposals, n_non_disposals) and
`dataset.yaml` for ultralytics (train = train/*/frames, val = dev/*/frames).

**Volume target:** train ≥ 300 clips (≈ 25k frames sampled), dev 60 clips, test 100 clips.

## 6. Experiments to run (in this order)

1. **Baseline on test, before any tuning.** Run the worker with its current settings (motion tracker,
   no registration, text descriptions) on every test clip and score with `evaluate` (needs the clip's
   `site.json` as the site; add a `--site` option to a copy of `worker/scripts/stress.py` under
   `sim/eval/`, don't edit `worker/`). Save the numbers: this is the reference point.
2. **Fine-tune a 2-class detector** (`item`, `person`) from `yolo11n.pt` on train:
   `yolo detect train data=dataset.yaml model=yolo11n.pt imgsz=960 epochs=60 patience=15`. Pick the
   epoch on **dev** mAP only.
3. **Real-world check of the detector (the most important number):** evaluate it on Eymen's real item
   photos and frames of the real demo video, with hand-drawn boxes (provided separately). Report
   mAP/recall there next to the sim mAP. If real recall is much lower than sim, say so: that is the
   sim2real gap, and more randomization is the fix, not more epochs.
4. **Tune worker settings on dev only:** detector confidence, `gone_after_frames`, `throw_score`'s
   rim margin, `item_confidence_threshold`. Grid or simple search; log every trial.
5. **Final run on test, once:** baseline vs (fine-tuned detector + tuned settings). Same clips, same
   scoring.

## 7. Report back (`docs/sim/results.md` + artifacts link)

- A table per split and **per scenario**: drops, counted, missed, extra, wrong bin, bin rule right,
  above core threshold, and **false disposals** (non-disposals that produced an event, the most
  dangerous error).
- Detector: sim dev mAP, sim test mAP, **real-photo recall/mAP**.
- 5 annotated sample videos (worker boxes + ground truth) including the worst failures.
- The fine-tuned weights (`item_person_yolo11n.pt`) and the exact training command and commit.
- A "limitations" section: what the sim does not model (cloth deformation, real lighting, real camera
  noise, real people).

## 8. Definition of done

- `sim/unity` regenerates any clip bit-for-bit from its seed.
- All three splits rendered, `manifest.csv` correct, test never used for tuning (state it in the report).
- Baseline and final numbers on test, per scenario, plus the real-photo detector check.
- Nothing large committed to git. Code and reports go in a PR to `main`; ask the repo owner before merging.
