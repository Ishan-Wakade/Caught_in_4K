# Chalk in the prerecorded voice guide

The optional `--chalk` path sends unknown-item vision requests and Jev typed bin decisions through the
[Chalk Model Gateway](https://docs.chalk.ai/docs/model-gateway). YOLO pose, CLIP, face redaction, tracking,
voice and rendering stay on the worker. Known catalog answers still need no cloud request.

This integration is restricted to `guide --prepared`. `prepared_guide.py` owns that command path,
`prepared_providers.py` supplies its provider adapters, and `prepared_render.py` supplies its visualization
and audio export. The shared live-model providers, tracker, guide renderer and voice implementation are
unchanged. A normal live invocation never imports the Chalk adapters; setting Chalk environment variables
alone does not enable them.

The gateway was configured and verified on 17 October 2026 in the team's Chalk environment. A fresh
IMG_9121.MOV analysis made four successful DeepSeek vision requests through Chalk with zero local cache hits.
The clip matched a catalog item, so Jev was not called by that video run. Jev was verified separately through
Chalk's `/alpha/decisions` endpoint, using the same typed state/questions payload; `/v1/systemone` returned a
provider configuration error on the managed gateway. This does not deploy Chalk Evaluations.

## Configure your Chalk environment

1. In Chalk, select an environment. Under **Model Gateway → Routing → Connections**, add the providers you
   will use: Anthropic for Claude, `openai-compatible` with DeepSeek's API base URL for DeepSeek,
   and TypeSafe for Jev. Keep provider credentials in those connections.
2. Publish/select models or routes, and create a gateway API key authorized for those connections.
   Copy the exact model IDs exposed by your environment. Do not assume that example prefixes or model IDs
   already exist. A vision route must actually support images and the request schema.
3. Save this file **outside the repository** as `~/.config/recyclone/chalk.env` (restrict access with `chmod 600`),
   or export the same variables in the worker's environment:

```dotenv
CHALK_ROUTER_API_KEY=your-gateway-key
CHALK_ENVIRONMENT_ID=your-environment-id
CHALK_CLAUDE_MODEL=your-configured-claude-model-or-route
CHALK_DEEPSEEK_MODEL=your-configured-deepseek-model-or-route
CHALK_JEV_MODEL=your-configured-jev-model-or-route
```

Only the selected vision provider's model and the Jev model are required. The worker reads this file directly;
it does not load the root `.env` automatically. Environment variables override file values.
Direct Anthropic, DeepSeek and TypeSafe keys are unnecessary on the worker in Chalk mode.

## Render a video

```sh
cd worker
uv sync
uv run recyclone-worker guide --source /absolute/path/to/clip.MOV \
  --prepared --chalk --namer claude --area pick \
  --voice say --no-stream --render /absolute/path/to/result.mp4
```

Or use `bash scripts/demo.sh /absolute/path/to/clip.MOV --chalk --area pick --namer deepseek`.
Use pixel coordinates instead of `pick` for a headless run. Manually mark one area around the bins and floor.
`--area auto` is rejected in Chalk mode: the existing bin detector sends whole frames, which violates the
worker's item-crops-only cloud boundary. This adapter does not extend that behavior. No actual-bin verdict
is produced from the manually marked area.

Chalk mode is restricted to prepared video files. It rejects a forced `--item` answer or CLIP-only mode.
The existing privacy filter must load before item crops may leave the machine; all faces are blanked or
the crop is dropped. Jev receives text descriptions and local rules, never video.

## Verify what ran

The adjacent `result.json` includes:

- `prepared: true`: whole-clip analysis happens before playback; this does not measure live response time.
- `chalk.requests`, `successful_requests`, and per-call role, requested model, served model when supplied,
  transport status, latency and token usage. These measure gateway transport, not answer correctness.
- `provider_usage`: fresh identity/decision calls, disk cache hits and errors.
- Existing per-track messages, sources and announcements. Catalog answers and provider failures remain visible.

Traces omit API keys, image payloads, descriptions, prompts and provider error bodies. The normal local
report still contains messages and clip paths; it is not uploaded automatically. Caches are separated by
Chalk environment and route configuration, so old direct-provider answers cannot masquerade as a Chalk call.
Re-rendering may use cached answers and produce **zero** gateway requests. Never claim those are fresh calls.
Gateway errors retain the guide's ordinary fallback; the worker never bypasses Chalk with a direct provider call.

Before claiming recognition accuracy or early guidance, independently label the items, expected bins and
disposal times. Inferred bin outcomes and the model's own confidence are not ground truth. For a future
hosted evaluation, follow [Chalk Evaluations setup](https://docs.chalk.ai/docs/evaluations/quick-start);
this integration does not create/upload datasets or deploy evaluation functions.
