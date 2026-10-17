/**
 * The live camera page's bridge to the full model: CLIP in the browser answers catalog items at once, and every held
 * item is also sent (face-redacted hand crops) to /api/guide/identify, where DeepSeek names it and Jev picks the bin
 * under the city's rules. The server's answer is the better one, so it replaces CLIP's and is what gets spoken.
 * No answer in time -> CLIP's catalog answer, else trash (the team's default). Spoken once per item.
 */
import { defaultTrash, type GuideMessage } from "./message";
import type { Pose, Pt } from "./approach";

const CROP_EVERY_S = 0.3;
const ASK_WITH_CROPS = 2;
const ASK_ALONE_AFTER_S = 0.8;
const MAX_CROPS = 3;
/** Held this long without the server's answer: decide with what we have. */
export const GIVE_UP_AFTER_S = 4.0;

export type Asked = { message: GuideMessage | null; source: string; sig: string | null };
export type Shown = { message: GuideMessage; fallback: boolean; source: string };
/** body: what /api/guide/speak accepts (a signed server message, a catalog id, or the fixed default). */
export type Speak = { message: GuideMessage; source: string; body: object };
export type Decision = { banner: Shown | null; speak: Speak | null };
export type ClipAnswer = { id: string; message: GuideMessage } | null;

type Item = {
  start: number; crops: string[]; lastCrop: number; state: "collecting" | "asking" | "done"; result: Asked | null; spoken: boolean;
  askedMs: number | null; latencyMs: number | null; gaveUp: boolean;
};
/** Where one person's current item is in the server path (the /camera debug view). */
export type AssistInfo = {
  state: Item["state"]; crops: number; asked: boolean; latencyMs: number | null; gaveUp: boolean;
  result: { source: string; message: GuideMessage | null } | null;
};

const TRASH: Asked = { message: defaultTrash(null), source: "default", sig: null };

export class Assist {
  private items = new Map<number, Item>();

  constructor(private identify: (crops: string[]) => Promise<Asked>) {}

  /** One frame for a person holding something since `start`; `crop` returns the redacted hand crops it may send. */
  step(id: number, start: number, t: number, clip: ClipAnswer, crop: () => string[]): Decision {
    let item = this.items.get(id);
    if (!item || item.start !== start) {
      item = { start, crops: [], lastCrop: -1e9, state: "collecting", result: null, spoken: false, askedMs: null, latencyMs: null, gaveUp: false };
      this.items.set(id, item);
    }
    const held = t - start;
    if (item.state === "collecting" && t - item.lastCrop >= CROP_EVERY_S) {
      item.lastCrop = t;
      item.crops.push(...crop().slice(0, MAX_CROPS - item.crops.length));
      if (item.crops.length >= ASK_WITH_CROPS || (item.crops.length >= 1 && held >= ASK_ALONE_AFTER_S)) this.ask(item);
    }
    if (item.state !== "done" && held >= GIVE_UP_AFTER_S) {
      // Too slow (or no crop could be sent): decide now; a late server answer is ignored for this item.
      item.state = "done";
      item.gaveUp = true;
      item.result = clip ?{ message: clip.message, source: "clip", sig: null } : TRASH;
    }

    const r = item.state === "done" ? item.result : null;
    const banner: Shown | null = r
      ? r.message && { message: r.message, fallback: r.source === "default", source: r.source }
      : clip && { message: clip.message, fallback: false, source: "clip" };
    let speak: Speak | null = null;
    if (r && !item.spoken) {
      item.spoken = true;
      if (r.message) {
        const body = r.sig ? { message: r.message, sig: r.sig } : r.source === "clip" && clip ? { kind: "catalog", id: clip.id } : { kind: "default" };
        speak = { message: r.message, source: r.source, body };
      }
    }
    return { banner, speak };
  }

  forget(id: number): void {
    this.items.delete(id);
  }

  info(id: number): AssistInfo | null {
    const item = this.items.get(id);
    if (!item) return null;
    return {
      state: item.state, crops: item.crops.length, asked: item.askedMs !== null, latencyMs: item.latencyMs, gaveUp: item.gaveUp,
      result: item.result ? { source: item.result.source, message: item.result.message } : null,
    };
  }

  private ask(item: Item): void {
    item.state = "asking";
    const asked = performance.now();
    item.askedMs = asked;
    const done = (r: Asked) => {
      item.latencyMs = performance.now() - asked;
      if (item.state !== "asking") return;
      item.state = "done";
      item.result = r;
    };
    this.identify(item.crops).then(done, () => done(TRASH));
  }
}

const COCO = ["nose", "leftEye", "rightEye", "leftEar", "rightEar", "leftShoulder", "rightShoulder", "leftElbow",
  "rightElbow", "leftWrist", "rightWrist", "leftHip", "rightHip", "leftKnee", "rightKnee", "leftAnkle", "rightAnkle"];

/** YOLO's 17 COCO keypoints [x, y, conf] -> the named points approach.headBox uses (to black out every head). */
export function fromCoco(kp: number[][]): Pose {
  const p: Record<string, Pt> = {};
  COCO.forEach((name, i) => {
    if (kp[i]) p[name] = { x: kp[i][0], y: kp[i][1], v: kp[i][2] };
  });
  return p as Pose;
}
