/**
 * The voice guide's fast path running in the visitor's browser (ONNX Runtime Web): webcam frame -> YOLO11n-pose ->
 * hand crops -> CLIP -> E's votes and bin table (scoring.ts). Video never leaves the device; the browser only
 * downloads the models (pose from this site, CLIP's image model from Hugging Face) and caches them.
 */
import type { InferenceSession, Tensor } from "onnxruntime-web";
import { PersonTracker, POSE_SIZE, decodePose, letterbox } from "./pose";
import { Watcher, defaultTrash, handBox, type Box, type GuideData, type GuideMessage, type Keypoints } from "./scoring";
import { headBox, type Box as AreaBox } from "./approach";
import { Assist, fromCoco, type Asked, type Speak } from "./assist";

type Ort = typeof import("onnxruntime-web");

const ORT_VERSION = "1.30.0"; // must match apps/web/package.json; the wasm files load from this CDN path
const MODEL_CACHE = "caught-in-4k-models-v1";
const CLIP_SIZE = 224;
const MEAN = [0.48145466, 0.4578275, 0.40821073]; // CLIP's preprocessing (Xenova preprocessor_config.json)
const STD = [0.26862954, 0.26130258, 0.27577711];
/** Hold-up demo (not in the worker): an empty hand this long starts a new item ... */
const NEW_ITEM_AFTER_S = 1.5;
/** ... and, without the demo key, an item held this long with no catalog answer is "trash" (team rule). With the key,
 * DeepSeek + Jev are asked first, as in the worker (assist.ts). */
const UNSURE_AFTER_S = 2.0;

export type Backend = "webgpu" | "wasm";
export type Progress = { loaded: number; total: number };

export type GuidePerson = { id: number; kp: Keypoints; hands: Box[]; holding: boolean };
/** source: "clip" (on this device), "llm" / "catalog" (DeepSeek + Jev on the server), "default" (trash fallback). */
export type Banner = { message: GuideMessage; fallback: boolean; source?: string };
export type GuideFrame = { people: GuidePerson[]; banner: Banner | null; poseMs: number; clipMs: number; speak: Speak[] };
/** The server path (needs the demo key): ask DeepSeek + Jev about each held item, from face-redacted crops only. */
export type AssistDeps = {
  identify: (crops: string[]) => Promise<Asked>;
  /** JPEG data URL of `box` with every head blacked out, or null if it must not leave the device. */
  capture: (video: HTMLVideoElement, box: AreaBox, heads: Array<{ box: AreaBox; reliable: boolean }>) => string | null;
};

/** Model bytes from the browser cache, else downloaded (with progress) and cached for the next visit. */
async function fetchModel(url: string, onBytes: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const hit = await cache?.match(url);
  if (hit) {
    const bytes = new Uint8Array(await hit.arrayBuffer());
    onBytes(bytes.length, bytes.length);
    return bytes;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`model download failed (${res.status}): ${url}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onBytes(loaded, total || loaded);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  await cache?.put(url, new Response(bytes)).catch(() => undefined); // a full disk only costs a re-download
  return bytes;
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  return Boolean(gpu && (await gpu.requestAdapter().catch(() => null)));
}

function canvas(size: number): CanvasRenderingContext2D {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  return c.getContext("2d", { willReadFrequently: true })!;
}

export class GuideEngine {
  private poseCtx = canvas(POSE_SIZE);
  private clipCtx = canvas(CLIP_SIZE);

  private constructor(
    private ort: Ort,
    private pose: InferenceSession,
    private clip: InferenceSession,
    readonly data: GuideData,
    readonly backend: Backend,
  ) {}

  static async load(onProgress: (p: Progress) => void): Promise<GuideEngine> {
    const ort = (await import("onnxruntime-web/webgpu")) as unknown as Ort;
    ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
    const data = (await (await fetch("/models/guide.json")).json()) as GuideData;
    const clipUrl = (file: string) => `https://huggingface.co/${data.clip.repo}/resolve/${data.clip.revision}/${file}`;

    const bytes = new Map<string, Progress>();
    const track = (url: string) => (loaded: number, total: number) => {
      bytes.set(url, { loaded, total });
      const all = [...bytes.values()];
      onProgress({ loaded: all.reduce((s, p) => s + p.loaded, 0), total: all.reduce((s, p) => s + p.total, 0) });
    };
    const open = (model: Uint8Array, backend: Backend) =>
      ort.InferenceSession.create(model, { executionProviders: [backend], graphOptimizationLevel: "all" });

    if (await hasWebGpu()) {
      try {
        const [poseBytes, clipBytes] = await Promise.all([
          fetchModel("/models/yolo11n-pose.onnx", track("pose")),
          fetchModel(clipUrl(data.clip.webgpu), track("clip")),
        ]);
        return new GuideEngine(ort, await open(poseBytes, "webgpu"), await open(clipBytes, "webgpu"), data, "webgpu");
      } catch (e) {
        console.warn("WebGPU unavailable for these models, using WebAssembly", e);
      }
    }
    const [poseBytes, clipBytes] = await Promise.all([
      fetchModel("/models/yolo11n-pose.onnx", track("pose")),
      fetchModel(clipUrl(data.clip.wasm), track("clip")),
    ]);
    return new GuideEngine(ort, await open(poseBytes, "wasm"), await open(clipBytes, "wasm"), data, "wasm");
  }

  /** People and their keypoints in this video frame (frame pixels). */
  async people(video: HTMLVideoElement) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    const lb = letterbox(w, h);
    const ctx = this.poseCtx;
    ctx.fillStyle = "rgb(114,114,114)";
    ctx.fillRect(0, 0, POSE_SIZE, POSE_SIZE);
    ctx.drawImage(video, lb.left, lb.top, lb.width, lb.height);
    const input = new this.ort.Tensor("float32", chw(ctx, POSE_SIZE, (v) => v / 255), [1, 3, POSE_SIZE, POSE_SIZE]);
    const out = (await this.pose.run({ images: input })).output0 as Tensor;
    return decodePose(out.data as Float32Array, lb);
  }

  /** L2-normalized CLIP embeddings of these crops of the video (one batch). */
  async embed(video: HTMLVideoElement, boxes: Box[]): Promise<Float32Array[]> {
    if (!boxes.length) return [];
    const per = 3 * CLIP_SIZE * CLIP_SIZE;
    const batch = new Float32Array(per * boxes.length);
    boxes.forEach(([x0, y0, x1, y1], i) => {
      // CLIP's resize-shortest-side-then-centre-crop, as one draw: the centred square of the crop, scaled to 224.
      const side = Math.min(x1 - x0, y1 - y0);
      const sx = x0 + (x1 - x0 - side) / 2;
      const sy = y0 + (y1 - y0 - side) / 2;
      this.clipCtx.imageSmoothingQuality = "high";
      this.clipCtx.drawImage(video, sx, sy, side, side, 0, 0, CLIP_SIZE, CLIP_SIZE);
      batch.set(chw(this.clipCtx, CLIP_SIZE, (v, c) => (v / 255 - MEAN[c]) / STD[c]), i * per);
    });
    const input = new this.ort.Tensor("float32", batch, [boxes.length, 3, CLIP_SIZE, CLIP_SIZE]);
    const out = (await this.clip.run({ pixel_values: input })).image_embeds as Tensor;
    const flat = out.data as Float32Array;
    const dim = flat.length / boxes.length;
    return boxes.map((_, i) => {
      const v = flat.slice(i * dim, (i + 1) * dim);
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    });
  }
}

/** RGBA canvas pixels -> planar RGB floats. */
function chw(ctx: CanvasRenderingContext2D, size: number, f: (v: number, channel: number) => number): Float32Array {
  const px = ctx.getImageData(0, 0, size, size).data;
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = f(px[4 * i], 0);
    out[n + i] = f(px[4 * i + 1], 1);
    out[2 * n + i] = f(px[4 * i + 2], 2);
  }
  return out;
}

/** One camera session: people tracked across frames, each person's votes, and what the banner says. */
export class GuideSession {
  private tracker = new PersonTracker();
  private watcher: Watcher;
  private assist: Assist | null;

  constructor(private engine: GuideEngine, private deps?: AssistDeps) {
    this.watcher = new Watcher(engine.data);
    this.assist = deps ? new Assist(deps.identify) : null;
  }

  async step(video: HTMLVideoElement, t: number): Promise<GuideFrame> {
    const t0 = performance.now();
    const found = await this.engine.people(video);
    const t1 = performance.now();
    const { ids, gone } = this.tracker.update(found, t);
    gone.forEach((id) => {
      this.watcher.forget(id);
      this.assist?.forget(id);
    });

    const people: GuidePerson[] = found.map((p, i) => ({
      id: ids[i],
      kp: p.kp,
      hands: (["L", "R"] as const).map((s) => handBox(p.kp, s, video.videoWidth, video.videoHeight)).filter((b): b is Box => b !== null),
      holding: false,
    }));
    // CLIP on the hands of everyone due for an observation (at most 10x/s each), in one batch.
    const due = people.filter((p) => p.hands.length && this.watcher.due(p.id, t));
    const embs = await this.engine.embed(video, due.flatMap((p) => p.hands));
    let at = 0;
    for (const p of due) {
      this.watcher.observe(p.id, t, embs.slice(at, at + p.hands.length));
      at += p.hands.length;
    }
    const t2 = performance.now();

    let banner: Banner | null = null;
    let longest = 0;
    const speak: Speak[] = [];
    // Every head in the frame (all people), blacked out of any crop that leaves the device.
    const heads = this.assist ? found.map((f) => headBox(fromCoco(f.kp))).filter((h) => h !== null) : [];
    for (const p of people) {
      this.watcher.resetIfIdle(p.id, t, NEW_ITEM_AFTER_S);
      p.holding = this.watcher.holding(p.id, t);
      if (!p.holding) continue;
      const held = this.watcher.heldFor(p.id, t);
      const answerId = this.watcher.answerId(p.id);
      const answer = answerId ? this.watcher.answer(p.id) : null;
      let shown: Banner | null;
      if (this.assist && this.deps) {
        const deps = this.deps;
        const crops = () => p.hands
          .map(([x0, y0, x1, y1]) => deps.capture(video, { x0, y0, x1, y1 }, heads))
          .filter((c): c is string => c !== null);
        const d = this.assist.step(p.id, this.watcher.itemStart(p.id) ?? t, t, answerId && answer ? { id: answerId, message: answer } : null, crops);
        shown = d.banner;
        if (d.speak) speak.push(d.speak);
      } else {
        shown = answer
          ? { message: answer, fallback: false, source: "clip" }
          : held >= UNSURE_AFTER_S
            ? { message: defaultTrash(this.engine.data), fallback: true, source: "default" }
            : null;
      }
      if (shown && held >= longest) [banner, longest] = [shown, held];
    }
    return { people, banner, poseMs: t1 - t0, clipMs: t2 - t1, speak };
  }
}
