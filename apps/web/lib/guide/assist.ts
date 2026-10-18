/**
 * The live camera page's bridge to the full model: every held item is sent (face-redacted hand crops) to
 * /api/guide/identify, where DeepSeek names it and Jev picks the bin under the city's rules. One answer per item, shown
 * and spoken once decided (no switching between guesses): the server's if it answers within CLIP_WAIT_S, else CLIP's
 * catalog answer (on this device). No answer at all in time -> trash (the team's default) -- or, for the live demo
 * (SAY_TRASH_WHEN_UNSURE off), nothing: unsure answers and failures are not shown or spoken. Spoken once per item.
 */
import { defaultTrash, type GuideMessage } from "./message";
import type { Pose, Pt } from "./approach";

const CROP_EVERY_S = 0.3;
const ASK_WITH_CROPS = 1; // ask with the first crop: waiting for a second one cost 0.3 s (17 Oct)
const ASK_ALONE_AFTER_S = 0.8;
const MAX_CROPS = 3;
/** Server saw nothing held, or could not tell what (a blurry or blacked-out crop), while CLIP still sees an item: ask again
 * with fresh crops, this many times (17 Oct). */
const RETRIES = 1;
/** Live demo (17 Oct): an unsure item stays silent instead of "trash". The product's rule is trash; set true for it. */
export const SAY_TRASH_WHEN_UNSURE = false;
/** Held this long without the server's answer: decide with what we have. */
export const GIVE_UP_AFTER_S = 2.0; // 17 Oct: was 4 s; a server answer after this still shows
/** CLIP knows the item (catalog): wait this long for the server's answer before using CLIP's. Was 0 (17 Oct, a 2 s
 * wait felt slow), but CLIP can only pick a catalog item, so off-catalog items got the nearest one at once: a metal
 * water bottle was "plastic bottle" every time (17 Oct evening). 1.5 s lets DeepSeek + Jev answer first. */
export const CLIP_WAIT_S = 1.5;

export type Asked = { message: GuideMessage | null; source: string; sig: string | null };
export type Shown = { message: GuideMessage; fallback: boolean; source: string };
/** body: what /api/guide/speak accepts (a signed server message, a catalog id, or the fixed default). */
export type Speak = { message: GuideMessage; source: string; body: object };
export type Decision = { banner: Shown | null; speak: Speak | null };
export type ClipAnswer = { id: string; message: GuideMessage } | null;

type Item = {
  start: number;
  crops: string[];
  lastCrop: number;
  state: "collecting" | "asking" | "done";
  result: Asked | null;
  spoken: boolean;
  retries: number;
};

const TRASH: Asked = { message: defaultTrash(null), source: "default", sig: null };

export class Assist {
  private items = new Map<number, Item>();

  constructor(private identify: (crops: string[]) => Promise<Asked>, private sayTrash = SAY_TRASH_WHEN_UNSURE) {}

  /** One frame for a person holding something since `start`; `crop` returns the redacted hand crops it may send. */
  step(id: number, start: number, t: number, clip: ClipAnswer, crop: () => string[]): Decision {
    let item = this.items.get(id);
    if (!item || item.start !== start) {
      item = { start, crops: [], lastCrop: -1e9, state: "collecting", result: null, spoken: false, retries: 0 };
      this.items.set(id, item);
    }
    const held = t - start;
    if (item.state === "collecting" && t - item.lastCrop >= CROP_EVERY_S) {
      item.lastCrop = t;
      item.crops.push(...crop().slice(0, MAX_CROPS - item.crops.length));
      if (item.crops.length >= ASK_WITH_CROPS || (item.crops.length >= 1 && held >= ASK_ALONE_AFTER_S)) this.ask(item);
    }
    if (item.state !== "done" && ((clip && held >= CLIP_WAIT_S) || (held >= GIVE_UP_AFTER_S && this.sayTrash))) {
      // Server too slow (or no crop could be sent): decide with CLIP's catalog answer, or trash; a late server answer
      // is then ignored for this item. Without trash and without CLIP's answer, keep waiting for either.
      item.state = "done";
      item.result = clip ? { message: clip.message, source: "clip", sig: null } : TRASH;
    }

    let r = item.state === "done" ? item.result : null;
    if (r && (r.source === "default" || r.source === "unclear") && !this.sayTrash) {
      // Unsure or failed, and the demo stays silent then: CLIP's catalog answer if it has one, spoken once decided.
      r = clip ? { message: clip.message, source: "clip", sig: null } : null;
    }
    const unsure = r?.source === "default" || r?.source === "unclear";
    const banner: Shown | null = r?.message ? { message: r.message, fallback: unsure, source: r.source } : null;
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

  private ask(item: Item): void {
    item.state = "asking";
    const done = (r: Asked) => {
      if (item.state !== "asking") return;
      if ((r.source === "nothing_held" || r.source === "unclear") && item.retries < RETRIES) {
        // The engine only steps people CLIP sees holding something: one more look, with crops from a later moment.
        item.retries += 1;
        item.state = "collecting";
        item.crops = [];
        return;
      }
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
