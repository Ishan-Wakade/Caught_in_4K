/**
 * "Hold the item up to the camera" mode for crowded rooms (18 Oct: with four people side by side the person-and-hand
 * model lost track of whose hand held the item; tomorrow's demo has 20-30 people moving behind). It does not ask whose
 * hand it is: an item held up close is large in the middle of the picture, so the model watches a ZONE there.
 *  - Each look, CLIP scores a few windows of the zone (the zone, its quadrants, its centre) against item words vs
 *    background words (people, faces, hands, walls...); the best window is where the item is.
 *  - An item is "in view" after CONFIRM of the last RECENT looks saw one (P >= HOLD_P); it ends after EMPTY_S without.
 *  - Then one Claude call on that window (faces blacked out, see zoneCrop), asked once more if Claude saw nothing usable.
 *  - Claude unsure: CLIP's catalog vote if it is sure (Jolie's fallback); else "not sure". One answer per item.
 * Uses Jolie's engine (pose for the skeleton and for faces, CLIP) unchanged.
 */
import type { GuideEngine } from "../guide/engine";
import { score, fromCatalog, type Box, type GuideMessage, type Keypoints } from "../guide/scoring";
import { headBox } from "../guide/approach";
import { fromCoco } from "../guide/assist";
import type { FaceFinder } from "../guide/redact";
import { autoLevels } from "./focus";

/** The zone, as shares of the frame (wide enough for an item held up anywhere in front of the person). */
export const ZONE = { x0: 0.15, y0: 0.08, x1: 0.85, y1: 0.98 };
export const LOOK_EVERY_S = 0.15;
export const HOLD_P = 0.5;
export const SEEN_P = 0.35;
export const RECENT = 5;
export const CONFIRM = 3;
export const EMPTY_S = 0.7;
export const MAX_ASKS = 2;
/** The same item: the best window's CLIP image embedding this close (cosine) to the item's. A different one for
 * CHANGE_LOOKS looks in a row is the next item (one held up after another; a crowd behind never empties the zone). */
export const SAME = 0.8;
export const CHANGE_LOOKS = 4;
export const ASK_AGAIN_S = 0.8;
/** The crop is the best window grown by this much (the window can cut the item's edge). */
export const GROW = 1.25;
const CROP_MAX_PX = 512;
const FACE_MARGIN = 0.25;
const MAX_BLACK = 0.7;

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
/** MediaPipe BlazeFace full range (Apache-2.0, served from this site): faces a few metres away, which the short-range
 * model (Jolie's) misses; 18 Oct crowd test: 26 of 166 crops showed a seated bystander's face. */
export const FAR_FACE_MODEL = "/models/blaze_face_full_range.tflite";

export async function loadFarFaceFinder(): Promise<FaceFinder | null> {
  try {
    const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks(WASM);
    return await FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: FAR_FACE_MODEL }, runningMode: "IMAGE", minDetectionConfidence: 0.3 });
  } catch (e) {
    console.warn("far-range face detector unavailable", e);
    return null;
  }
}

export type Asked = { message: GuideMessage | null; source: string; sig: string | null; item?: { name: string; confidence: number } };
export type ZoneFrame = {
  people: Array<{ kp: Keypoints; box: Box }>;
  zone: Box;
  /** The item's window while one is in view, else null. */
  item: Box | null;
  label: string | null;
  banner: { message: GuideMessage; source: string; fallback: boolean } | null;
  inView: boolean;
  checking: boolean;
  unsure: boolean;
  speak: Array<{ message: GuideMessage; source: string; body: object }>;
};

type Item = {
  start: number;
  lastSeen: number;
  votes: number[];
  nVotes: number;
  asks: number;
  asking: boolean;
  lastAsk: number;
  answer: Asked | null;
  shown: { message: GuideMessage; source: string; fallback: boolean } | null;
  spoken: boolean;
  nothing: number;
  ref: number[];
  differ: number;
};

export function zoneBox(w: number, h: number): Box {
  return [ZONE.x0 * w, ZONE.y0 * h, ZONE.x1 * w, ZONE.y1 * h];
}

/** The windows CLIP looks at: the zone, its four overlapping quadrants (65% of it) and its centre. */
export function windows(z: Box): Box[] {
  const [x0, y0, x1, y1] = z, w = x1 - x0, h = y1 - y0, s = 0.65;
  const ws = s * w, hs = s * h;
  return [z, [x0, y0, x0 + ws, y0 + hs], [x1 - ws, y0, x1, y0 + hs], [x0, y1 - hs, x0 + ws, y1], [x1 - ws, y1 - hs, x1, y1],
    [x0 + (w - ws) / 2, y0 + (h - hs) / 2, x0 + (w + ws) / 2, y0 + (h + hs) / 2]];
}

/**
 * Faces to black out in a crop, from the pose: a person whose face points are seen gets a face-sized box around them
 * (an item held in front of a face hides those points, so it is not blacked out with it); a small (background) person
 * whose face points are not seen gets their whole pose head box (fail closed). The face detector runs on top.
 */
export function faceBoxes(people: Array<{ kp: Keypoints; box: Box }>, frameH: number, item?: Box): Box[] {
  const out: Box[] = [];
  const ix = item ? (item[0] + item[2]) / 2 : -1, iy = item ? (item[1] + item[3]) / 2 : -1;
  for (const p of people) {
    const pts = [0, 1, 2, 3, 4].filter((j) => p.kp[j][2] >= 0.3).map((j) => p.kp[j]);
    const holds = ix >= p.box[0] && ix <= p.box[2] && iy >= p.box[1] && iy <= p.box[3];
    // everyone but the person holding the item: the top of their box (a head, seen or not: profiles and backs of
    // heads slipped past the face detectors in the crowd test)
    if (!holds) out.push([p.box[0], p.box[1], p.box[2], p.box[1] + 0.35 * (p.box[3] - p.box[1])]);
    if (pts.length >= 2) {
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      const span = Math.max(...xs) - Math.min(...xs);
      const sh = p.kp[5][2] >= 0.5 && p.kp[6][2] >= 0.5 ? Math.abs(p.kp[5][0] - p.kp[6][0]) : 0;
      const r = Math.max(1.4 * span, 0.4 * sh, 22);
      const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
      out.push([cx - r, cy - 1.2 * r, cx + r, cy + 1.1 * r]);
    } else if (p.box[3] - p.box[1] < 0.4 * frameH) {
      const hd = headBox(fromCoco(p.kp));
      out.push(hd ? [hd.box.x0, hd.box.y0, hd.box.x1, hd.box.y1] : p.box);
    }
  }
  return out;
}

/** Faces the detectors find in a canvas, in its pixels: on the whole and on 2 x 2 overlapping tiles shown 2x larger
 * (small faces in a crowd). */
function detectAll(c: HTMLCanvasElement, finders: FaceFinder[]): Box[] {
  const out: Box[] = [];
  const add = (f: FaceFinder, src: HTMLCanvasElement, ox: number, oy: number, k: number) => {
    for (const d of f.detect(src).detections) {
      const bb = d.boundingBox;
      if (bb) out.push([ox + bb.originX / k, oy + bb.originY / k, ox + (bb.originX + bb.width) / k, oy + (bb.originY + bb.height) / k]);
    }
  };
  const t = document.createElement("canvas");
  const tg = t.getContext("2d")!;
  const tw = Math.round(c.width * 0.6), th = Math.round(c.height * 0.6);
  t.width = tw * 2;
  t.height = th * 2;
  for (const f of finders) {
    add(f, c, 0, 0, 1);
    for (const [ox, oy] of [[0, 0], [c.width - tw, 0], [0, c.height - th], [c.width - tw, c.height - th]]) {
      tg.drawImage(c, ox, oy, tw, th, 0, 0, t.width, t.height);
      add(f, t, ox, oy, 2);
    }
  }
  return out;
}

/** The crop Claude sees: the window grown by GROW (inside the zone), every face blacked out, light levels. */
export function zoneCrop(video: HTMLVideoElement, win: Box, zone: Box, faces: Box[], finders: FaceFinder[]): string | null {
  if (!finders.length) return null;
  const cx = (win[0] + win[2]) / 2, cy = (win[1] + win[3]) / 2;
  const hw = (GROW * (win[2] - win[0])) / 2, hh = (GROW * (win[3] - win[1])) / 2;
  const b: Box = [Math.max(zone[0], cx - hw), Math.max(zone[1], cy - hh), Math.min(zone[2], cx + hw), Math.min(zone[3], cy + hh)];
  const bw = b[2] - b[0], bh = b[3] - b[1];
  if (bw < 16 || bh < 16) return null;
  const s = Math.min(1, CROP_MAX_PX / Math.max(bw, bh));
  const c = document.createElement("canvas");
  c.width = Math.round(bw * s);
  c.height = Math.round(bh * s);
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingQuality = "high";
  g.drawImage(video, b[0], b[1], bw, bh, 0, 0, c.width, c.height);
  g.fillStyle = "#000";
  for (const f of faces) g.fillRect((f[0] - b[0]) * s, (f[1] - b[1]) * s, (f[2] - f[0]) * s, (f[3] - f[1]) * s);
  for (const [x0, y0, x1, y1] of detectAll(c, finders)) {
    const mx = FACE_MARGIN * (x1 - x0), my = FACE_MARGIN * (y1 - y0);
    g.fillRect(x0 - mx, y0 - my, x1 - x0 + 2 * mx, y1 - y0 + 2 * my);
  }
  const img = g.getImageData(0, 0, c.width, c.height);
  let black = 0;
  for (let i = 0; i < img.data.length; i += 4) if (img.data[i] === 0 && img.data[i + 1] === 0 && img.data[i + 2] === 0) black++;
  if (black / (img.data.length / 4) > MAX_BLACK) return null;
  autoLevels(img.data);
  g.putImageData(img, 0, 0);
  return c.toDataURL("image/jpeg", 0.88);
}

export class ZoneSession {
  private recent: boolean[] = [];
  private lastLook = -1e9;
  private best: { box: Box; p: number; pCat: number[]; emb: ArrayLike<number> } | null = null;
  private item: Item | null = null;

  constructor(private engine: GuideEngine, private finders: FaceFinder[], private identify: (crops: string[]) => Promise<Asked>) {}

  async step(video: HTMLVideoElement, t: number): Promise<ZoneFrame> {
    const w = video.videoWidth, h = video.videoHeight;
    const zone = zoneBox(w, h);
    const people = (await this.engine.people(video)).map((p) => ({ kp: p.kp, box: p.box }));
    if (t - this.lastLook >= LOOK_EVERY_S) {
      this.lastLook = t;
      const ws = windows(zone);
      const embs = await this.engine.embed(video, ws);
      const scored = embs.map((e) => score(e, this.engine.data));
      const k = scored.reduce((bi, s, i) => (s.pItem > scored[bi].pItem ? i : bi), 0);
      this.best = { box: ws[k], p: scored[k].pItem, pCat: scored[k].pCat, emb: embs[k] };
      this.recent = [...this.recent, scored[k].pItem >= HOLD_P].slice(-RECENT);
      this.observe(t, video, zone, people);
    }
    return this.frame(t, zone, people);
  }

  private observe(t: number, video: HTMLVideoElement, zone: Box, people: Array<{ kp: Keypoints; box: Box }>): void {
    const b = this.best!;
    if (this.item && b.p >= SEEN_P) {
      let d = 0;
      for (let i = 0; i < b.emb.length; i++) d += b.emb[i] * this.item.ref[i];
      this.item.lastSeen = t;  // something is in view (the best window moves while an item sways: not a new item)
      if (d >= SAME) this.item.differ = 0;
      else if (b.p >= HOLD_P && ++this.item.differ >= CHANGE_LOOKS) this.item = null;  // another item is held up now
    }
    if (this.item && t - this.item.lastSeen > EMPTY_S) this.item = null;  // the item left: the next one is new
    if (!this.item && this.recent.filter(Boolean).length >= CONFIRM && b.p >= HOLD_P) {
      this.item = { start: t, lastSeen: t, votes: new Array(b.pCat.length).fill(0), nVotes: 0, asks: 0, asking: false, lastAsk: -1e9,
        answer: null, shown: null, spoken: false, nothing: 0, ref: Array.from(b.emb), differ: 0 };
    }
    const it = this.item;
    if (!it) return;
    if (b.p >= HOLD_P) {
      it.votes = it.votes.map((v, i) => v + b.pCat[i] * b.p);
      it.nVotes += 1;
    }
    const usable = it.answer?.message && it.answer.source !== "unclear";
    if (usable || it.asking || it.asks >= MAX_ASKS || b.p < HOLD_P || (it.asks > 0 && t - it.lastAsk < ASK_AGAIN_S)) return;
    const crop = zoneCrop(video, b.box, zone, faceBoxes(people, video.videoHeight, b.box), this.finders);
    if (!crop) return;
    it.asking = true;
    it.asks += 1;
    it.lastAsk = t;
    this.identify([crop]).then((a) => {
      if (a.source === "nothing_held") it.nothing += 1;
      if (!it.answer || !it.answer.message || it.answer.source === "unclear" || a.message) it.answer = a;
    }, () => undefined).finally(() => {
      it.asking = false;
    });
  }

  /** CLIP's catalog answer for the item, when its votes settle on one catalog item (Jolie's known_p / min_votes). */
  private clipAnswer(it: Item): { id: string; message: GuideMessage } | null {
    const c = this.engine.data.constants;
    if (it.nVotes < c.min_votes) return null;
    const total = it.votes.reduce((a, v) => a + v, 0);
    if (total <= 0) return null;
    const k = it.votes.reduce((bi, v, i) => (v > it.votes[bi] ? i : bi), 0);
    const id = this.engine.data.cats[k];
    return it.votes[k] / total >= c.known_p && id in this.engine.data.table ? { id, message: fromCatalog(id, this.engine.data) } : null;
  }

  private frame(t: number, zone: Box, people: Array<{ kp: Keypoints; box: Box }>): ZoneFrame {
    const it = this.item;
    const inView = !!it && t - it.lastSeen <= 0.3;
    const speak: ZoneFrame["speak"] = [];
    let banner: ZoneFrame["banner"] = null;
    let label: string | null = null;
    let unsure = false;
    if (it) {
      if (!it.shown) {
        const a = it.answer;
        const done = !it.asking && (it.asks >= MAX_ASKS || it.nothing >= MAX_ASKS);
        if (a?.message && a.source !== "unclear") it.shown = { message: a.message, source: a.source, fallback: false };
        else if (done || (a && !it.asking)) {
          const clip = this.clipAnswer(it);
          if (clip && (done || a?.source === "unclear")) it.shown = { message: clip.message, source: "clip", fallback: false };
        }
        if (!it.shown && done && it.nothing < MAX_ASKS) unsure = true;
      }
      if (it.shown && !it.spoken) {
        it.spoken = true;
        const a = it.answer;
        const body = it.shown.source !== "clip" && a?.sig ? { message: it.shown.message, sig: a.sig }
          : { kind: "catalog", id: this.clipAnswer(it)?.id ?? "" };
        speak.push({ message: it.shown.message, source: it.shown.source, body });
      }
      banner = it.shown;
      const hidden = it.nothing >= MAX_ASKS && !it.shown;  // Claude saw no item twice: not an item (a face, a sleeve)
      label = hidden ? null : it.shown ? (it.answer?.item?.name ?? null) : unsure ? "not sure" : "identifying…";
      if (hidden) return { people, zone, item: null, label: null, banner: null, inView: false, checking: false, unsure: false, speak };
    }
    return { people, zone, item: it && inView ? this.best!.box : null, label, banner, inView, checking: !!it && inView && !banner && !unsure, unsure, speak };
  }
}
