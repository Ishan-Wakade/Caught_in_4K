# Voice guide: how to run it (Phase 1)

Current state of `recyclone-worker guide` (worker/). The product direction is in the root `AGENTS.md` and the
roadmap (`docs/superpowers/specs/2026-10-17-voice-guidance-roadmap-design.md`); this page is only the how-to and
the measured results so far.

## Run

```bash
cd worker
uv run recyclone-worker cameras                      # cameras this computer sees (iPhone via Continuity Camera too)
uv run recyclone-worker guide --source 1 --area pick --show --cctv --render ~/Downloads/take1.mp4
```

- `--source`: camera index, `rtsp://` / `http://` URL of an IP camera, or a video file (`--realtime` to speak aloud).
- `--area pick`: draw ONE box around all the bins on the first frame; the printed `--area x0,y0,x1,y1` can be reused.
- `--show`: live window (q stops); `--cctv`: camera name + clock on the video; `--render`: annotated video with the
  voice mixed in (also written on q / Ctrl-C).
- `--homography file.json`: optional floor calibration (3x3, image pixels -> floor meters); without it, the person's
  own height is the ruler.
- `--namer deepseek` (default): new items via DeepSeek + Jev. Keys: `~/.config/recyclone/deepseek.env`
  (`DEEPSEEK_API_KEY`), `~/.config/recyclone/jev.env` (`TYPESAFE_API_KEY`), never in the repo.

## Two phones: one camera, one speaker

The model stays on the Mac. Phone A is the camera, phone B plays the voice.

1. Put the Mac and both phones on the same network. Hackathon Wi-Fi often blocks devices from reaching each other,
   so a phone hotspot is the safe choice.
2. Camera: phone A through Continuity Camera (`cameras` shows its index), or an IP camera app (`--source http://...`).
3. `uv run recyclone-worker guide --source 1 --area pick --show --speaker phone` (`both` = Mac and phone).
4. On phone B, open the printed `http://<mac-ip>:8766/s/<token>/` URL and tap once (iOS only allows sound after a
   tap). Keep the page open with the screen on. Each sentence plays there and is shown big, colored by bin.

Only text and synthetic speech go to the phone: no camera frames, no crops. The token changes on every run;
`SPEAKER_PORT` changes the port.

## What it says

JSON-forced `{"bin": "compost" | "trash" | "recycle" | "none", "explanation": ...}`, spoken as
`"<Bin>. <explanation>"`, e.g. "Recycle. aluminum can, placed in recycling". Dangerous items (battery, electronics,
chemicals): "None. <item> is dangerous to place in any of these bins. Place it in <drop-off> instead". Trash when
below 50% confidence or no answer by arrival. Catalog bins: `worker/rules/cambridge-ma-2022.bins.json` (each row
cites the city's guide).

## Live camera page (/camera, hold-up demo)

Jolie's page runs YOLO11n-pose + CLIP in the browser. Opened with the demo key (`/camera#key=<GUIDE_TOKEN>`) it also
uses the full model: every held item's hand crops (every head blacked out, then any face MediaPipe still finds; no face
detector = nothing is sent) go to `/api/guide/identify` (DeepSeek + Jev). CLIP's catalog answer shows at once; the
server's answer replaces it (~1.2 s) and is what gets spoken; tap "Sound on" once for the ElevenLabs voice (the
browser's own voice if ElevenLabs fails). No server answer within 4 s -> CLIP's answer, else trash. Without the key the
page is unchanged (CLIP only). The label under the banner says who answered.

## Privacy

Only item crops leave the machine (DeepSeek), and only after every person's head region and every face found by the
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
