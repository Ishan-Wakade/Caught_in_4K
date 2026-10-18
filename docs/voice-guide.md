# Voice guide: how to run it (Phase 1)

Current state of `recyclone-worker guide` (worker/). The product direction is in the root `AGENTS.md` and the
roadmap (`docs/superpowers/specs/2026-10-17-voice-guidance-roadmap-design.md`); this page is only the how-to and
the measured results so far.

## Setup (each teammate, once)

Keys live in your home folder, never in the repo (`worker/` reads them from `~/.config/recyclone/`):

```bash
mkdir -p ~/.config/recyclone && chmod 700 ~/.config/recyclone
echo 'ANTHROPIC_API_KEY=...'  > ~/.config/recyclone/anthropic.env    # Claude: identifies new items (default)
echo 'TYPESAFE_API_KEY=...'   > ~/.config/recyclone/jev.env          # Jev: picks the bin under the local rules
printf 'ELEVENLABS_API_KEY=...\nVOICE_ID_EN=XZXyuzPdidXaSa10PmVA\n' > ~/.config/recyclone/elevenlabs.env  # the voice
echo 'DEEPSEEK_API_KEY=...'   > ~/.config/recyclone/deepseek.env     # only for --namer deepseek
chmod 600 ~/.config/recyclone/*.env
cd worker && uv sync            # models download on first run (YOLO11n-pose, CLIP ViT-B/32, YuNet)
```

Missing keys degrade, they do not crash: no Claude key -> items CLIP does not know are "Trash ... not sure"; no
ElevenLabs key -> the Mac's `say` voice. The worker needs `ffmpeg` (and `cloudflared` only for `--speaker-tunnel`).

## Demo video from a recorded clip (store-tuned)

```bash
worker/scripts/demo.sh ~/Downloads/clip1.MOV                       # draw the bin box, press Enter
worker/scripts/demo.sh ~/Downloads/clip2.MOV --item item_generic_can # the item is known: no identification call
DEMO_OUT=~/Desktop/renders worker/scripts/demo.sh clip3.mp4 --area 700,560,1080,1920
```

Two passes (`guide --prepared`, recyclone_worker/prepared.py): the whole clip through YOLO pose + CLIP first, then each
person's item is identified ONCE from their best face-redacted crops (CLIP's catalog when sure, else Claude Haiku 5.5 +
Jev); then the normal causal guide runs on the same skeletons with those answers ready, so the voice comes exactly at
the approach trigger. This shows a store whose items are already known; it is not a measure of live identification
speed. People with nothing identifiable (background passers-by) are not announced. Output: `<clip>_demo.mp4` (thin
green skeletons, black box + item name over the hand holding the item, black bottom bar "Item: ... / Bin: ...",
ElevenLabs voice in the audio track) and `<clip>_demo.json` (items, announcements with times and sources: what an
upload UI would show). Use a fixed camera and one item per person per walk-up: a person's first item is their label for
the whole clip. Claude costs about $0.0004 per item; answers are cached in `worker/state/vlm-cache`, so a re-render is
free; each run prints its call count and cost.

## Run live

```bash
cd worker
uv run recyclone-worker cameras                      # every camera, incl. the iPhone (Continuity Camera) as avf:N
uv run recyclone-worker guide --source avf:iphone --area pick --fullscreen --cctv   # voice on this laptop
```

- `--source`: camera index, `avf:iphone` / `avf:N` (Continuity Camera, read through ffmpeg: OpenCV does not list it),
  `rtsp://` / `http://` URL of an IP camera, or a video file (`--realtime` to speak aloud).
- `--area pick`: drag ONE box around all the bins (and the floor in front) on the still first frame, then Enter; an
  empty box is refused; the printed `--area x0,y0,x1,y1` can be reused to skip this step.
- `--show` (window) or `--fullscreen` (full resolution, e.g. a monitor behind the bins; f toggles, q stops);
  `--cctv`: camera name + clock; `--render`: annotated video with the voice mixed in (also written on q / Ctrl-C).
- `--homography file.json`: optional floor calibration (3x3, image pixels -> floor meters); without it, the person's
  own height is the ruler.
- `--namer claude` (default) | `deepseek` | `clip`: who identifies items CLIP is not sure of (Jev then picks the bin).
  Live, the LLM is asked on the first unsure crop and an answer on its way is waited for up to 4 s.

## Two phones: one camera, one speaker

The model stays on the Mac. Phone A is the camera, phone B plays the voice.

1. Network: with `--speaker-tunnel` the speaker page also gets a public `https://….trycloudflare.com` URL (needs
   `cloudflared`), which works on any network — eduroam, venue Wi-Fi that isolates devices, IPv6-only phone hotspots
   (T-Mobile's are). Without it, the Mac and phone B must reach each other on the same network.
2. Camera: phone A through Continuity Camera. OpenCV does not list it, so use `--source avf:iphone` (read through
   ffmpeg's avfoundation input; `cameras` lists every option). An IP camera app also works (`--source http://...`).
3. `uv run recyclone-worker guide --source avf:iphone --area pick --show --speaker phone --speaker-tunnel`
   (`--speaker both` = Mac and phone).
4. On phone B, open the printed URL (the `https://…trycloudflare.com/s/<token>/` one with `--speaker-tunnel`) and tap once (iOS only allows sound after a
   tap). Keep the page open with the screen on. Each sentence plays there with a live waveform (voice-memo style),
   the bin shown big and colored by bin.

Voice: `--voice auto` (default) uses ElevenLabs when `~/.config/recyclone/elevenlabs.env` has `ELEVENLABS_API_KEY`
and `VOICE_ID_EN` (or the env vars `ELEVENLABS_API_KEY` / `ELEVENLABS_VOICE_ID`), else macOS `say`. Catalog sentences
are synthesized once at startup and cached as mp3 (23 in ~2 s); a new sentence takes ~0.4 s; any ElevenLabs failure
falls back to `say` for that sentence. Only the sentence's text goes to ElevenLabs. `--voice say` forces the offline voice.

Only text and synthetic speech go to the phone: no camera frames, no crops. The token changes on every run;
`SPEAKER_PORT` changes the port.

## What it says

Fixed JSON `{"bin": "recycle" | "compost" | "trash" | "none", "item", "place", "reason"}`, spoken as
"Recycling. Aluminum can should be placed in recycling because metal cans are recyclable in Cambridge." Catalog
reasons are fixed in `worker/rules/cambridge-ma-2022.bins.json`; a new item's reason is Claude's argument for the bin
Jev chose. Dangerous items: "None. Battery should be placed in the Recycle Center because it is dangerous in any of
these bins." Not sure: "Trash. This item should be placed in trash because we are not sure what it is."

## Live camera page (/camera, hold-up demo)

Jolie's page runs YOLO11n-pose + CLIP in the browser. Opened with the demo key (`/camera#key=<GUIDE_TOKEN>`) it also
uses the full model: every held item's hand crops (every head blacked out, then any face MediaPipe still finds; no face
detector = nothing is sent) go to `/api/guide/identify` (DeepSeek + Jev). CLIP's catalog answer shows at once; the
server's answer replaces it (~1.2 s) and is what gets spoken; tap "Sound on" once for the ElevenLabs voice (the
browser's own voice if ElevenLabs fails). No server answer within 4 s -> CLIP's answer, else trash. Without the key the
page is unchanged (CLIP only). The label under the banner says who answered.

## Privacy

Only item crops leave the machine (to Claude, or DeepSeek with `--namer deepseek`; only the item's description
and the rules go to Jev, only the sentence text to ElevenLabs), and only after every person's head region and every face found by the
YuNet detector are blacked out. If the detector is missing or a head cannot be sized, no crop is sent (the item is
then announced as trash).

## Filming checklist

Phone fixed high in a corner, landscape, plugged in, not moved between takes; bins AND the floor in front of them AND
people's feet in view; a 1 m tape square on the floor for calibration; a reference take holding each known item ~3 s;
takes with known items, unknown items, a passer-by, two people, a fast approach; keep a few takes unseen for the final
score.

## Measured so far (dev only)

10 hand-held phone clips, tuned while looking at them, not the fixed demo camera: told before the drop 7/10, right
bin 5/7, median lead time 6.1 s (min 1.8 s), fast path 24-32 fps (camera 30). Close-ups with no feet in view are not
announced, by design (an announcement as the item goes in would be too late). Wrong answers so far: a white paper
bag called a napkin by DeepSeek, a paper card not identified in time. `uv run python scripts/eval_guide.py CONFIG.json
--namer deepseek --render-dir DIR` reproduces the scoring.
