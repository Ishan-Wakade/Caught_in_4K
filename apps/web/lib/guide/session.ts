/**
 * The phone's voice guide, without React or models: given each frame's people (id + pose), decide when to capture
 * hand crops, when to ask the server what they hold, and when to speak. Same timing rules as the worker's guide.py:
 * identification starts while the person walks up; the answer is spoken on the approach trigger (or as soon as it is
 * ready after it); still no answer once they reach the bins -> "trash"; one announcement per person per visit.
 */
import { Approach, distanceM, handBox, headBox, LEAD_S, type Box, type Pose } from "./approach";
import { defaultTrash, type GuideMessage } from "./message";

export const IDENTIFY_M = 4.5;       // start capturing hand crops this far from the bins ...
export const IDENTIFY_ETA_S = 5.0;   // ... or this long before arrival
const CROP_GAP_S = 0.4;              // crops of the same person at least this far apart
const MAX_CROPS = 3;
const ARRIVAL_GRACE_S = 0.6;
const FORGET_S = 10;

export type Deps = {
  identify: (crops: string[]) => Promise<{ message: GuideMessage | null; source: string; sig?: string | null }>;
  /** sig: the server's signature for the message (null for the fixed default, which is requested by name). */
  speak: (message: GuideMessage, t: number, personId: number, source: string, sig: string | null) => void;
  /** JPEG data URL of `box`, with every head in `heads` blacked out; null if it must not leave the phone. */
  capture: (box: Box, heads: Array<{ box: Box; reliable: boolean }>) => string | null;
};

type PersonState = {
  crops: string[];
  lastCrop: number;
  request: "none" | "sent" | "done";
  result: { message: GuideMessage | null; source: string; sig?: string | null } | null;
  triggeredAt: number | null;
  told: boolean;
  lastSeen: number;
};

export class GuideSession {
  readonly approach: Approach;
  readonly people = new Map<number, PersonState>();
  readonly said: Array<{ t: number; id: number; message: GuideMessage; source: string }> = [];

  constructor(public area: Box, private deps: Deps) {
    this.approach = new Approach(area);
  }

  step(t: number, frame: Array<{ id: number; pose: Pose }>, size = { w: 1e5, h: 1e5 }): void {
    const heads = frame.map((f) => headBox(f.pose)).filter((h): h is { box: Box; reliable: boolean } => h !== null);
    for (const { id, pose } of frame) {
      const s = this.state(id, t);
      s.lastSeen = t;
      const d = distanceM(pose, this.area);
      if (this.approach.update(id, t, pose)) {
        if (s.told) this.reset(s);  // a new visit after the cooldown
        s.triggeredAt = t;
      }
      const close = d != null && (d <= IDENTIFY_M || this.approach.eta(id) <= IDENTIFY_ETA_S);
      if (s.request === "none" && close && t - s.lastCrop >= CROP_GAP_S) this.capture(s, pose, heads, t, size);
      if (s.triggeredAt != null && !s.told) this.decide(id, s, t, d);
    }
    for (const [id, s] of this.people) {
      if (t - s.lastSeen > FORGET_S) {
        this.people.delete(id);
        this.approach.forget(id);
      }
    }
  }

  private state(id: number, t: number): PersonState {
    let s = this.people.get(id);
    if (!s) {
      s = { crops: [], lastCrop: -1e9, request: "none", result: null, triggeredAt: null, told: false, lastSeen: t };
      this.people.set(id, s);
    }
    return s;
  }

  private reset(s: PersonState): void {
    Object.assign(s, { crops: [], lastCrop: -1e9, request: "none", result: null, triggeredAt: null, told: false });
  }

  private capture(s: PersonState, pose: Pose, heads: Array<{ box: Box; reliable: boolean }>, t: number, size: { w: number; h: number }): void {
    s.lastCrop = t;
    for (const [elbow, wrist] of [[pose.leftElbow, pose.leftWrist], [pose.rightElbow, pose.rightWrist]] as const) {
      const b = handBox(elbow, wrist, size.w, size.h);
      if (!b || s.crops.length >= MAX_CROPS) continue;
      const jpeg = this.deps.capture(b, heads);
      if (jpeg) s.crops.push(jpeg);
    }
    if (s.crops.length >= 2 || (s.crops.length >= 1 && s.triggeredAt != null)) {
      s.request = "sent";
      this.deps.identify(s.crops).then(
        (r) => { s.result = r; s.request = "done"; },
        () => { s.result = { message: defaultTrash(null), source: "default", sig: null }; s.request = "done"; },
      );
    }
  }

  private decide(id: number, s: PersonState, t: number, d: number | null): void {
    const waited = t - (s.triggeredAt as number);
    if (s.request === "done" && s.result) {
      s.told = true;
      if (s.result.message) this.say(id, s.result.message, s.result.source, t, s.result.sig ?? null);
      return;
    }
    const arrived = d === 0 && waited >= ARRIVAL_GRACE_S;
    if (s.request === "sent" && (arrived || waited >= LEAD_S + 1.5)) {
      s.told = true;  // asked, but no answer in time: trash, as the team decided for "very uncertain"
      this.say(id, defaultTrash(null), "default", t, null);
    }
    // request "none": no hand crop could be taken (hands hidden, or faces could not be removed) -> stay silent
  }

  private say(id: number, message: GuideMessage, source: string, t: number, sig: string | null): void {
    this.said.push({ t, id, message, source });
    this.deps.speak(message, t, id, source, sig);
  }
}

const MP: Record<string, number> = {
  nose: 0, leftEye: 2, rightEye: 5, leftEar: 7, rightEar: 8, mouthLeft: 9, mouthRight: 10,
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14, leftWrist: 15, rightWrist: 16,
  leftHip: 23, rightHip: 24, leftAnkle: 27, rightAnkle: 28,
};

/** MediaPipe Pose's 33 normalized landmarks -> named pixel points with visibility. */
export function fromMediaPipe(lm: Array<{ x: number; y: number; visibility?: number }>, w: number, h: number): Pose {
  const p: Pose = {};
  for (const [name, i] of Object.entries(MP)) {
    const q = lm[i];
    if (q) (p as Record<string, unknown>)[name] = { x: q.x * w, y: q.y * h, v: q.visibility ?? 0 };
  }
  return p;
}
