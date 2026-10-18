/**
 * One /model session in the browser: YOLO11n-pose and CLIP on this device (lib/guide/engine.ts, the same ONNX models as
 * /camera), the demo model's item logic (watch.ts), and the two server calls (Claude): identify a carried item from
 * face-redacted crops, and find the bin openings in a face-redacted frame.
 */
import type { GuideEngine } from "../guide/engine";
import { PersonTracker } from "../guide/pose";
import { score, type Box } from "../guide/scoring";
import { headBox } from "../guide/approach";
import { fromCoco } from "../guide/assist";
import type { FaceFinder } from "../guide/redact";
import type { GuideMessage } from "../guide/message";
import type { ItemAnswer, Opening } from "./claude";
import type { Caption, OverlayPerson } from "./overlay";
import { BAR_S, LiveWatcher, demoHandBox, sameOpenings, type Event, type Item } from "./watch";

export type LiveAnswer = ItemAnswer & { sig?: string | null; ms?: number };
export type LiveFrame = { people: OverlayPerson[]; caption: Caption | null; poseMs: number; clipMs: number };
export type Say = { message: GuideMessage; sig: string | null };

const BINS_LONG_SIDE = 1536; // bins.LONG_SIDE
/** Crops for Claude: at least this many px on the short side (a far hand is ~70 px), at most 512 on the long side
 * (namer.MAX_SIDE, JPEG quality 88 as namer._jpeg). */
const CROP_MIN_PX = 224;
const CROP_MAX_PX = 512;
/** A crop that is mostly blacked out (a head, or a face-detector false alarm on a small crop) is not sent at all. */
const MAX_BLACK = 0.35;

/**
 * redact.redactedCrop for /model: the same fail-closed redaction (every head box, then every face the detector finds,
 * filled black; an unsizable head touching the crop -> null), scaled up when small, and dropped when mostly black.
 */
export function itemCrop(source: CanvasImageSource, box: { x0: number; y0: number; x1: number; y1: number },
  heads: Array<{ box: { x0: number; y0: number; x1: number; y1: number }; reliable: boolean }>, face: FaceFinder | null): string | null {
  if (!face) return null;
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  const s = Math.min(Math.max(1, CROP_MIN_PX / Math.min(w, h)), CROP_MAX_PX / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingQuality = "high";
  g.drawImage(source, box.x0, box.y0, w, h, 0, 0, c.width, c.height);
  g.fillStyle = "#000";
  for (const hd of heads) {
    const b = hd.box;
    if (!(b.x1 > box.x0 && b.y1 > box.y0 && b.x0 < box.x1 && b.y0 < box.y1)) continue;
    if (!hd.reliable) return null;
    g.fillRect((b.x0 - box.x0) * s, (b.y0 - box.y0) * s, (b.x1 - b.x0) * s, (b.y1 - b.y0) * s);
  }
  for (const d of face.detect(c).detections) {
    const bb = d.boundingBox;
    if (bb) g.fillRect(bb.originX - 4, bb.originY - 4, bb.width + 8, bb.height + 8);
  }
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let black = 0;
  for (let i = 0; i < px.length; i += 4) if (px[i] === 0 && px[i + 1] === 0 && px[i + 2] === 0) black++;
  if (black / (px.length / 4) > MAX_BLACK) return null;
  return c.toDataURL("image/jpeg", 0.88);
}

const pretty = (s: string | undefined) => (s && s !== "unknown" ? s.replace(/_/g, " ") : "");

/** The words on the item box: Claude's name and material ("plastic cup · rigid plastic"). */
export function itemLabel(item: Item): string | null {
  const a = item.answer as LiveAnswer | null;
  if (!a) return item.asking ? "identifying…" : null;
  if (a.source === "error") return "no answer";
  if (!a.item || a.source === "unclear") return "not sure";
  const material = pretty(a.item.material);
  return material ? `${a.item.name} · ${material}` : a.item.name;
}

export class LiveSession {
  /** Ids kept through 2 s of missed detections (a far, small person): one id per person -> one item, one answer. */
  private tracker = new PersonTracker(0.2, 2.0);
  readonly watcher: LiveWatcher;
  readonly events: Event[] = [];
  private caption: (Caption & { at: number }) | null = null;
  private shown = new WeakSet<object>();
  private toSay: Say[] = [];
  /** The people found in the last step (binsFrame blacks them out; the pose model never runs twice at once). */
  private lastFound: Array<{ box: Box; kp: number[][] }> | null = null;

  /** Per person, the last frame their item was seen in (downscaled, with that frame's people): the drop frame. */
  private sightFrames = new Map<number, { t: number; canvas: HTMLCanvasElement; people: Array<{ box: Box; kp: number[][] }>; scale: number }>();

  /**
   * findBins(frame, width, height): the server's bin openings for a face-redacted frame (pixels of that frame).
   * With it, each drop is checked against the openings in the drop frame itself (bins.py, moving camera).
   */
  constructor(private engine: GuideEngine, private face: FaceFinder | null, identify: (crops: string[]) => Promise<LiveAnswer>,
    private onChange: () => void = () => {},
    findBins?: (frame: string, width: number, height: number) => Promise<Opening[]>) {
    const dropBins = findBins && (async (id: number) => {
      const snap = this.sightFrames.get(id);
      const pic = snap && this.redacted(snap.canvas, snap.people, snap.scale);
      if (!snap || !pic) return null;
      const ops = (await findBins(pic.frame, pic.width, pic.height)).map((o) => ({ ...o, box: o.box.map((v) => Math.round(v / snap.scale)) as Opening["box"] }));
      // The camera did not move: the first frame's openings (no arm over the bins) are the better boxes.
      if (sameOpenings(ops, this.openings, pic.width / snap.scale)) return this.openings;
      if (ops.length) {
        this.openings = ops;  // the picture shows the openings the drop was judged against
        this.onChange();
      }
      return ops;
    });
    this.watcher = new LiveWatcher(identify, (e, update) => {
      if (!update) this.events.push(e);
      if (e.outcome && e.answer?.message && (!update || this.caption?.outcome === e.outcome)) {
        this.caption = { message: e.answer.message, outcome: e.outcome, sure: e.answer.source !== "unclear", at: this.caption?.at ?? e.t };
      }
      this.onChange();
    }, dropBins);
  }

  get openings(): Opening[] {
    return this.watcher.openings;
  }

  set openings(o: Opening[]) {
    this.watcher.openings = o;
  }

  /** New answers to voice since the last call. */
  takeSay(): Say[] {
    const s = this.toSay;
    this.toSay = [];
    return s;
  }

  async step(video: HTMLVideoElement, t: number): Promise<LiveFrame> {
    const t0 = performance.now();
    const found = await this.engine.people(video);
    this.lastFound = found;
    const t1 = performance.now();
    const { ids } = this.tracker.update(found, t);
    const w = video.videoWidth, h = video.videoHeight;
    const heads = found.map((f) => headBox(fromCoco(f.kp))).filter((x) => x !== null);
    const hands = found.map((f) => (["L", "R"] as const).map((s) => demoHandBox(f.kp, s, w, h)).filter((b): b is Box => b !== null));

    const due = ids.map((id, i) => ({ id, i })).filter(({ id, i }) => hands[i].length && this.watcher.due(id, t));
    const embs = await this.engine.embed(video, due.flatMap(({ i }) => hands[i]));
    let at = 0;
    for (const { id, i } of due) {
      const boxes = hands[i];
      const pItem = embs.slice(at, at + boxes.length).map((e) => score(e, this.engine.data).pItem);
      at += boxes.length;
      this.watcher.observe(id, t, boxes, pItem, (k) => {
        const [x0, y0, x1, y1] = boxes[k];
        return itemCrop(video, { x0, y0, x1, y1 }, heads, this.face);
      });
    }
    const t2 = performance.now();
    for (const { id } of due) if (this.watcher.items.get(id)?.lastHeld === t) this.keepSight(id, t, video, found);
    this.watcher.tick(t, new Set(ids));
    for (const id of this.sightFrames.keys()) if (!this.watcher.items.has(id)) this.sightFrames.delete(id);

    const people: OverlayPerson[] = found.map((f, i) => {
      const item = this.watcher.items.get(ids[i]);
      if (item?.answer?.message && !this.shown.has(item.answer)) {
        // A new answer: the bottom bar says it, and the speaker says it (once per answer).
        this.shown.add(item.answer);
        this.caption = { message: item.answer.message, outcome: null, sure: item.answer.source !== "unclear", at: t };
        this.toSay.push({ message: item.answer.message, sig: (item.answer as LiveAnswer).sig ?? null });
        this.onChange();
      }
      const holding = item && this.watcher.holding(ids[i], t);
      return { kp: f.kp, item: holding && item.box ? item.box : null, label: holding && item ? itemLabel(item) : null };
    });
    if (this.caption && t - this.caption.at > BAR_S) this.caption = null;
    return { people, caption: this.caption, poseMs: t1 - t0, clipMs: t2 - t1 };
  }

  /** The item someone holds right now (the most recently seen one), for the page's "Holding now" card. */
  current(t: number): { label: string | null; answer: LiveAnswer | null; asking: boolean } | null {
    let best: Item | null = null;
    for (const [id, item] of this.watcher.items) {
      if (this.watcher.holding(id, t) && (!best || item.lastHeld > best.lastHeld)) best = item;
    }
    return best && { label: itemLabel(best), answer: best.answer as LiveAnswer | null, asking: best.asking };
  }

  /** End of a video file: every item still open is finished (its stretch evaluated). */
  flush(t: number): void {
    this.watcher.tick(t + 10, new Set());
  }

  /** Keep this frame (at most 1536 px) as person `id`'s latest sighting; one reused canvas per person. */
  private keepSight(id: number, t: number, video: HTMLVideoElement, found: Array<{ box: Box; kp: number[][] }>): void {
    const w = video.videoWidth, h = video.videoHeight;
    const scale = Math.min(1, BINS_LONG_SIDE / Math.max(w, h));
    let snap = this.sightFrames.get(id);
    if (!snap) {
      snap = { t, canvas: document.createElement("canvas"), people: found, scale };
      this.sightFrames.set(id, snap);
    }
    snap.canvas.width = Math.round(w * scale);
    snap.canvas.height = Math.round(h * scale);
    snap.canvas.getContext("2d")!.drawImage(video, 0, 0, snap.canvas.width, snap.canvas.height);
    Object.assign(snap, { t, people: found, scale });
  }

  /**
   * The current frame as it may leave the device for bin detection (at most 1536 px): see redacted(). No detector, or
   * no step yet (the people in view are not known) -> null.
   */
  binsFrame(video: HTMLVideoElement): { frame: string; width: number; height: number; scale: number } | null {
    if (!this.face || !this.lastFound) return null;
    const w = video.videoWidth, h = video.videoHeight;
    const s = Math.min(1, BINS_LONG_SIDE / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    c.getContext("2d")!.drawImage(video, 0, 0, c.width, c.height);
    const pic = this.redacted(c, this.lastFound, s);
    return pic && { ...pic, scale: s };
  }

  /**
   * A copy of a frame canvas (`s` = canvas px per video px) with every head blacked out (a person whose head cannot be
   * sized: their whole body), then any face the face detector still finds. No detector -> null.
   */
  private redacted(src: HTMLCanvasElement, people: Array<{ box: Box; kp: number[][] }>, s: number): { frame: string; width: number; height: number } | null {
    if (!this.face) return null;
    const c = document.createElement("canvas");
    c.width = src.width;
    c.height = src.height;
    const g = c.getContext("2d")!;
    g.drawImage(src, 0, 0);
    g.fillStyle = "#000";
    for (const p of people) {
      const head = headBox(fromCoco(p.kp));
      const b = head?.reliable ? [head.box.x0, head.box.y0, head.box.x1, head.box.y1] : p.box;
      g.fillRect(b[0] * s, b[1] * s, (b[2] - b[0]) * s, (b[3] - b[1]) * s);
    }
    for (const d of this.face.detect(c).detections) {
      const bb = d.boundingBox;
      if (bb) g.fillRect(bb.originX - 4, bb.originY - 4, bb.width + 8, bb.height + 8);
    }
    return { frame: c.toDataURL("image/jpeg", 0.85), width: c.width, height: c.height };
  }
}
