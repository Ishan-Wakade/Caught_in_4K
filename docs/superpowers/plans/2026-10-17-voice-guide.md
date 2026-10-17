# Voice Guide (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `recyclone-worker guide` watches a camera (live or a file) and, when a person carrying an item comes close to the bin area, speaks "<bin>. <explanation>" early enough that they throw it in the right bin.

**Architecture:** A causal per-frame fast path (YOLO11n-pose tracking + CLIP on the two hand crops + one bin-area box + a distance estimate) decides *when* to speak. Identification starts as soon as an item is seen in a hand: catalog items from CLIP immediately; otherwise DeepSeek (catalog prompt, then describe) and Jev in a background thread. A JSON-validated message goes to a swappable voice (macOS `say`, pre-rendered). The existing item tracker, events and namer are reused, not changed.

**Tech Stack:** Python 3.13 worker (`worker/`), ultralytics (YOLO11n-pose), OpenAI CLIP ViT-B/32, OpenCV, jsonschema, macOS `say`/`afplay`, ffmpeg, existing `namer.py` (DeepSeek) and `generic.py` (Jev).

**Spec:** `docs/superpowers/specs/2026-10-17-voice-guidance-roadmap-design.md` (Phase 1, §6 team answers, §7 E's calls).

## Global Constraints

- First spoken word: exactly one of `compost`, `trash`, `recycle`, or `none` for dangerous items (team, 17 Oct): `"None. <item> is dangerous to place in any of these bins. Place it in <drop-off> instead"`.
- Message is JSON `{"bin": ..., "explanation": ...}`, validated against a schema before speaking; spoken as `"<Bin>. <explanation>"`; explanation ≤ 8 words, except the `none` sentence.
- Default `trash` when the best answer's confidence < 0.5 (`DEFAULT_TRASH_BELOW = 0.5`) or no answer is ready when the person reaches the bin area.
- One bin-area box for all bins; no per-bin boxes.
- Only item crops leave the machine (DeepSeek); never whole frames. Keys from env or `~/.config/recyclone/*.env`, never the repo.
- Bin for catalog items comes from the standardized table `worker/rules/cambridge-ma-2022.bins.json` (checked against the city text), not from the model.
- The fast path is causal (past frames only) and must report its measured fps; nothing is called "real-time" unless measured at or above the camera's fps.
- One announcement per person per visit (cooldown 8 s after they leave the area).

## Review Focus

1. Two people approaching together: each gets their own announcement for their own item (tracks are per person; test in Task 5).
2. A person standing still inside the bin area: announced once, not every frame (cooldown; test in Task 5).
3. DeepSeek/Jev slow or failing (no key, timeout): the person still hears "trash" by arrival, never silence forever and never a crash (test in Task 4).
4. Camera without a usable skeleton (only an arm, person cut off): no announcement and no crash (test in Task 3).
5. Hazardous answer ("battery") never spoken as "trash"/"recycle", always as `none` with a drop-off place (test in Task 1).

---

### Task 1: Message and standardized bin table

**Files:**
- Create: `worker/recyclone_worker/guide_message.py`, `worker/rules/cambridge-ma-2022.bins.json`
- Test: `worker/tests/test_guide_message.py`

**Interfaces:**
- Produces: `MESSAGE_SCHEMA: dict`; `make_message(bin: str, what: str) -> dict`; `validate_message(m: dict) -> None` (raises ValueError); `spoken(m: dict) -> str`; `load_bin_table(path) -> dict[str, dict]` (`{catalog_item_id: {"bin": "recycle"|"compost"|"trash", "name": str, "basis": str}}`); `from_catalog(item_id, table) -> dict`; `from_suggestion(proposed_type: dict) -> dict` (maps Jev `recycling→recycle`, `special`+hazardous→`none` with `"<item> is dangerous to place in any of these bins. Place it in <drop-off> instead"`, the drop-off from the rules text: batteries/small electronics/bulbs → `the Recycle Center`, chemicals/paint/propane → `a hazardous waste drop-off`; `special` non-hazardous→`trash`); `default_trash(what: str | None) -> dict`.
- The table: one row per catalog item in `contracts/fixtures/demo-site.json`, bin per the Cambridge text (fiber/kraft takeout boxes and bowls → trash; napkins, food → compost; clean plastic cups/containers/bottles, cans, glass, clean paper → recycle; wrappers, chip bags, utensils, paper cups, sauce cups → trash), `basis` quoting the rule line, `"undecided"` where the text does not decide.

- [ ] Step 1: tests — `test_message_schema_enforces_three_words` (`make_message("landfill", "x")` raises; `"recycle"` ok); `test_spoken_format` (`spoken({"bin":"recycle","explanation":"aluminum can, placed in recycling"}) == "Recycle. aluminum can, placed in recycling"`); `test_explanation_capped_at_8_words`; `test_hazardous_special_says_none_and_where` (`from_suggestion({...,"suggested_destination":"special","hazardous":True,"name":"battery","form":"battery"})` == `{"bin": "none", "explanation": "battery is dangerous to place in any of these bins. Place it in the Recycle Center instead"}`); `test_low_confidence_suggestion_defaults_to_trash` (confidence 0.4 → `trash`); `test_every_catalog_item_has_a_table_row`.
- [ ] Step 2: run `cd worker && uv run pytest tests/test_guide_message.py -v` → FAIL (module missing).
- [ ] Step 3: implement; the schema enum is `["compost","trash","recycle","none"]`; `none` only comes from `from_suggestion` with `hazardous` true.
- [ ] Step 4: run → PASS. Step 5: commit.

### Task 2: Voice

**Files:**
- Create: `worker/recyclone_worker/voice.py`
- Test: `worker/tests/test_voice.py`

**Interfaces:**
- Produces: `class Voice(Protocol): speak(text: str, at_s: float) -> None; prepare(texts: list[str]) -> None`; `class SayVoice(Voice)` (macOS `say -o <cache>/<sha>.aiff`, then `afplay` in a background process; `prepare` pre-renders); `class SilentVoice(Voice)` (records only); every Voice keeps `self.spoken: list[tuple[float, str, Path | None]]` for the video mix; `mix_audio(video_in: Path, video_out: Path, spoken) -> None` (ffmpeg `adelay` per clip + `amix`).
- [ ] Step 1: tests — `test_silent_voice_records_time_and_text`; `test_say_voice_prepares_files_once` (monkeypatch `subprocess.run`; second `prepare` of same text makes no call); `test_mix_audio_builds_one_ffmpeg_call` (monkeypatch; assert `adelay=2500|2500` for a clip at 2.5 s).
- [ ] Step 2–4: fail, implement, pass. Step 5: commit.

### Task 3: Live sources and the approach detector

**Files:**
- Modify: `worker/recyclone_worker/sources.py` (add `LiveCameraSource(source: int | str)`: webcam index, Continuity Camera index, or RTSP URL; yields `(idx, seconds_since_start, frame)`; `fps` from the device or 30)
- Create: `worker/recyclone_worker/approach.py`
- Test: `worker/tests/test_approach.py`

**Interfaces:**
- Produces: `BinArea(x0, y0, x1, y1)` in pixels; `person_meters_per_px(kp) -> float | None` (person height ruler: `1.7 m / (ankle_y − nose_y) * 0.87` when nose and an ankle are visible, else shoulder–hip length vs 0.5 m); `distance_m(kp, area, homography=None) -> float | None` (feet point = mean visible ankle; with a homography, floor meters; else pixel gap to the area box × meters_per_px; 0 inside the box); `class Approach` with `update(track_id, t, kp) -> bool` (True once when distance ≤ `NEAR_M = 1.5` or predicted arrival ≤ `LEAD_S = 2.5` from speed over the last 0.5 s, and the person is moving toward the area or inside it); `left(track_id, t)` resets after `COOLDOWN_S = 8` outside.
- [ ] Step 1: tests — `test_walking_toward_area_triggers_once_before_arrival` (synthetic ankles moving 1 m/s toward box, trigger at ≥ 1.5 s before entering); `test_walking_away_never_triggers`; `test_standing_inside_triggers_once`; `test_no_ankles_returns_none_no_trigger`; `test_homography_overrides_ruler`.
- [ ] Step 2–4: fail, implement, pass. Step 5: commit.

### Task 4: Early identification

**Files:**
- Create: `worker/recyclone_worker/guide_identify.py`
- Test: `worker/tests/test_guide_identify.py`

**Interfaces:**
- Consumes: `items.hand_box`, `items.Scorer`, `namer.DeepSeekNamer` (`name`, `describe`), `generic.generic_type`, `generic.BinAdvisor.suggest`, Task 1 (`from_catalog`, `from_suggestion`, `default_trash`).
- Produces: `class ItemWatcher(scorer, table, namer=None, advisor=None, executor=None)` with `observe(track_id, frame, kp) -> None` (hand crops; keeps the 3 best crops ≥ 0.5 s apart; accumulates CLIP category votes for crops with p_item ≥ 0.5) and `answer(track_id, now) -> dict | None` (a validated message: catalog item if top catalog vote share ≥ `KNOWN_P = 0.6` over ≥ 3 crops; otherwise, once 3 crops exist, submits one background job: `namer.name` → catalog id → `from_catalog`, else `describe` → `generic_type` → `advisor.suggest` → `from_suggestion`; returns its result when done, `None` before); `holding(track_id) -> bool` (an item seen in a hand in the last 1 s).
- [ ] Step 1: tests (fake scorer, fake namer, fake advisor; no network) — `test_catalog_item_answered_without_network`; `test_unknown_item_goes_to_llm_then_jev_once` (two `answer` calls → one job); `test_llm_failure_gives_none_then_guide_defaults_trash`; `test_empty_hand_is_not_holding`.
- [ ] Step 2–4: fail, implement, pass. Step 5: commit.

### Task 5: The guide loop, CLI, video

**Files:**
- Create: `worker/recyclone_worker/guide.py`
- Modify: `worker/recyclone_worker/cli.py` (subcommand `guide`)
- Test: `worker/tests/test_guide.py`

**Interfaces:**
- Consumes: Tasks 1–4; `stream.StreamServer`.
- Produces: `class Guide(pose_tracker, watcher, approach, voice, log_path, area)`, `step(idx, t, frame) -> list[dict]` (announcements made this frame: `{"t", "track_id", "message", "source": "catalog"|"llm"|"default", "fps"}`); `run(source, on_frame=None) -> list[dict]`; per frame: pose track (ultralytics `track(persist=True)` on `yolo11n-pose`, IDs per person) → `watcher.observe` for persons holding → `approach.update` → on trigger: `watcher.answer` or, if none and the person is inside the area, `default_trash` → `voice.speak` → JSONL log line; overlay (area box, per-person distance, holding, message on screen).
- CLI: `recyclone-worker guide --source 0|path|rtsp://… --area x0,y0,x1,y1 [--homography file.json] [--namer deepseek] [--voice say|silent] [--render out.mp4] [--realtime] [--no-stream] [--log state/guide-log.jsonl]`; prints measured fps at the end.
- [ ] Step 1: tests (fake pose tracker yielding scripted keypoints, fake watcher) — `test_two_people_each_get_their_own_announcement`; `test_person_standing_in_area_announced_once`; `test_no_answer_by_arrival_says_trash`; `test_cli_guide_dry_run_on_a_file` (tiny generated clip, `--voice silent`, exits 0, log has 1 line).
- [ ] Step 2–4: fail, implement, pass. Step 5: commit.

### Task 6: Measure on real footage and document

**Files:**
- Create: `worker/scripts/eval_guide.py`; modify `worker/AGENTS.md`, `worker/README.md`
- Test: the run itself (no unit test)

- [ ] Step 1: `eval_guide.py CONFIG:VIDEO_DIR` runs `Guide` on each clip of an item-tracker config (bin area = union of the clip's bin boxes), reports per drop truth: announced? lead time (truth frame − announcement), bin said vs the standardized table's bin for `ok_items[0]`, false announcements (no truth within 3 s after), fast-path fps.
- [ ] Step 2: run on dev clips (`state/real/bins.json`, `state/dev/street_2958_2960.json`, `state/heldout/youtube.json`); report numbers; render the voice-mixed video for 2–3 clips into `~/Downloads/recyclone-guide/`.
- [ ] Step 3: live check on the MacBook webcam (`--source 0`): fps and one spoken announcement.
- [ ] Step 4: document the command, the numbers (dev only), and the filming checklist additions; commit; PR.
