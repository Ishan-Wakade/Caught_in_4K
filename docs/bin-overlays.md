# Bin overlays for prerecorded clips

Use `guide --prepared --bin-layout FILE --area x0,y0,x1,y1` to draw tight opening outlines instead of the large
approach-area rectangle. Recycling is blue, trash is orange, compost is purple, and person skeletons stay green.
The labels use the three destination names even when the printed label says WASTE or ORGANICS.

The layout is a local manual annotation, not automatic bin recognition. It changes only the visualization;
the single approach area and voice guidance logic remain separate, and it supplies no actual-disposal verdict.
It is compatible with `--chalk` and sends no frames to a cloud model. Use explicit area coordinates or `pick`;
`auto` is rejected with a manual layout.

`worker/examples/IMG_9121.bin-layout.json` marks the three openings in IMG_9121.MOV. Coordinates are in native
1080×1920 pixels. Keyframes at video times track the camera pan; positions interpolate between them, and
offscreen openings are clipped/hidden. The JSON report includes the annotation source and keyframes.

```sh
cd worker
uv run recyclone-worker guide --source /absolute/path/to/IMG_9121.MOV \
  --prepared --namer deepseek --area 300,740,1080,1490 \
  --bin-layout examples/IMG_9121.bin-layout.json --voice say --no-stream \
  --render /absolute/path/to/IMG_9121_three_bins.mp4
```

Other videos need their own local annotations: `source_size: [width, height]` and a `keyframes` array with
`t` (seconds) and `boxes` containing `recycle`, `trash`, and `compost` rectangles `[x0,y0,x1,y1]` at each time.
Coordinates may extend offscreen during a pan. Scaling to the rendered frame is automatic.
