/**
 * Is a person carrying waste getting close to the bins? Same rules as worker/recyclone_worker/approach.py:
 * one box around all the bins; the person's feet (ankles) to that box in meters, with their own height as the ruler;
 * announce once per visit when inside, within NEAR_M, or arriving within LEAD_S; again only after COOLDOWN_S away.
 * Also: the hand crop past the wrist, every person's head box (blanked before a crop leaves the phone), and a simple
 * nearest-neighbour tracker that keeps an id per person across frames. All coordinates are pixels.
 */
export type Pt = { x: number; y: number; v: number };
export type Pose = Partial<Record<
  | "nose" | "leftEye" | "rightEye" | "leftEar" | "rightEar" | "mouthLeft" | "mouthRight"
  | "leftShoulder" | "rightShoulder" | "leftElbow" | "rightElbow" | "leftWrist" | "rightWrist"
  | "leftHip" | "rightHip" | "leftAnkle" | "rightAnkle", Pt>>;
export type Box = { x0: number; y0: number; x1: number; y1: number };

export const BODY_M = 1.7;
export const NOSE_TO_ANKLE = 0.87;
export const NEAR_M = 1.5;
export const LEAD_S = 2.5;
export const COOLDOWN_S = 8;
const SPEED_WINDOW_S = 0.5;
const MIN_HISTORY_S = 0.3;
const CONF = 0.3;

const seen = (p: Pt | undefined, c = CONF): p is Pt => !!p && p.v >= c;

function feet(p: Pose): { x: number; y: number } | null {
  const a = [p.leftAnkle, p.rightAnkle].filter((q): q is Pt => seen(q));
  return a.length ? { x: a.reduce((s, q) => s + q.x, 0) / a.length, y: a.reduce((s, q) => s + q.y, 0) / a.length } : null;
}

export function metersPerPx(p: Pose): number | null {
  const f = feet(p);
  if (f && seen(p.nose) && f.y - p.nose.y > 10) return (BODY_M * NOSE_TO_ANKLE) / (f.y - p.nose.y);
  const sh = [p.leftShoulder, p.rightShoulder].filter((q): q is Pt => seen(q));
  const hp = [p.leftHip, p.rightHip].filter((q): q is Pt => seen(q));
  if (sh.length && hp.length) {
    const torso = Math.abs(hp.reduce((s, q) => s + q.y, 0) / hp.length - sh.reduce((s, q) => s + q.y, 0) / sh.length);
    return torso > 5 ? 0.5 / torso : null;
  }
  return null;
}

function gap(pt: { x: number; y: number }, b: Box): number {
  const dx = Math.max(b.x0 - pt.x, 0, pt.x - b.x1);
  const dy = Math.max(b.y0 - pt.y, 0, pt.y - b.y1);
  return Math.hypot(dx, dy);
}

/** Meters from the feet to the bin area (0 inside it); null without visible ankles. */
export function distanceM(p: Pose, area: Box): number | null {
  const f = feet(p);
  const s = metersPerPx(p);
  return f && s != null ? gap(f, area) * s : null;
}

export class Approach {
  private hist = new Map<number, Array<[number, number]>>();
  private fired = new Map<number, boolean>();
  private lastNear = new Map<number, number>();
  constructor(public area: Box) {}

  /** True exactly once per visit, when this person should hear the announcement. */
  update(id: number, t: number, p: Pose): boolean {
    const d = distanceM(p, this.area);
    if (d == null) return false;
    const h = this.hist.get(id) ?? [];
    h.push([t, d]);
    while (h.length && t - h[0][0] > SPEED_WINDOW_S) h.shift();
    this.hist.set(id, h);
    if (d <= NEAR_M) this.lastNear.set(id, t);
    if (this.fired.get(id)) {
      if (d > NEAR_M && t - (this.lastNear.get(id) ?? t) >= COOLDOWN_S) this.fired.set(id, false);
      return false;
    }
    if (d === 0) return this.fire(id);
    const span = t - h[0][0];
    if (span < MIN_HISTORY_S) return false;
    const speed = (h[0][1] - d) / span;
    if (speed < -0.1) return false;
    if (d <= NEAR_M || (speed > 0.2 && d / speed <= LEAD_S)) return this.fire(id);
    return false;
  }

  /** Seconds until this person reaches the bins at their current speed (Infinity if not approaching). */
  eta(id: number): number {
    const h = this.hist.get(id);
    if (!h || h.length < 2) return Infinity;
    const [t0, d0] = h[0];
    const [t1, d1] = h[h.length - 1];
    const speed = t1 > t0 ? (d0 - d1) / (t1 - t0) : 0;
    return d1 === 0 ? 0 : speed > 0.2 ? d1 / speed : Infinity;
  }

  forget(id: number): void {
    this.hist.delete(id);
    this.fired.delete(id);
    this.lastNear.delete(id);
  }

  private fire(id: number): boolean {
    this.fired.set(id, true);
    return true;
  }
}

/** The region past the wrist along the forearm, where a held object is (same as items.hand_box). */
export function handBox(elbow: Pt | undefined, wrist: Pt | undefined, w: number, h: number): Box | null {
  if (!seen(wrist) || !seen(elbow, 0.2)) return null;
  const fore = Math.max(60, Math.hypot(wrist.x - elbow.x, wrist.y - elbow.y));
  const cx = wrist.x + 0.35 * (wrist.x - elbow.x);
  const cy = wrist.y + 0.35 * (wrist.y - elbow.y);
  const s = 0.6 * fore;
  const b = { x0: Math.max(0, cx - s), y0: Math.max(0, cy - s), x1: Math.min(w, cx + s), y1: Math.min(h, cy + s) };
  return b.x1 - b.x0 > 20 && b.y1 - b.y0 > 20 ? b : null;
}

const FACE_MIN = 0.05; // fail closed: even face points the pose model is unsure about
const SIZE_MIN = 0.5;  // only confident shoulder/hip pairs may size a head
export const HEAD_MIN_PX = 25;

/** A person's head region (to black out) and whether its size could be measured; null if no head point is seen. */
export function headBox(p: Pose): { box: Box; reliable: boolean } | null {
  const face = [p.nose, p.leftEye, p.rightEye, p.leftEar, p.rightEar, p.mouthLeft, p.mouthRight].filter((q): q is Pt => seen(q, FACE_MIN));
  const sh = [p.leftShoulder, p.rightShoulder].filter((q): q is Pt => seen(q, FACE_MIN));
  const width = seen(p.leftShoulder, SIZE_MIN) && seen(p.rightShoulder, SIZE_MIN) ? Math.abs(p.leftShoulder.x - p.rightShoulder.x) : 0;
  const torso = ([[p.leftShoulder, p.leftHip], [p.rightShoulder, p.rightHip]] as const)
    .filter(([a, b]) => seen(a, SIZE_MIN) && seen(b, SIZE_MIN)).map(([a, b]) => Math.abs((a as Pt).y - (b as Pt).y));
  const span = face.length >= 2 ? Math.max(...face.map((q) => q.x)) - Math.min(...face.map((q) => q.x)) : 0;
  let r = Math.max(0.6 * width, 1.2 * span, 0.5 * Math.max(0, ...torso));
  const reliable = r >= HEAD_MIN_PX;
  r = Math.max(r, HEAD_MIN_PX);
  if (face.length) {
    const xs = face.map((q) => q.x), ys = face.map((q) => q.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    return { box: { x0: cx - r, y0: cy - r, x1: cx + r, y1: cy + r }, reliable };
  }
  if (sh.length) {
    const cx = sh.reduce((s, q) => s + q.x, 0) / sh.length, top = Math.min(...sh.map((q) => q.y));
    return { box: { x0: cx - r, y0: top - 2 * r, x1: cx + r, y1: top }, reliable };
  }
  return null;
}

function centre(p: Pose): { x: number; y: number; size: number } | null {
  const pts = Object.values(p).filter((q): q is Pt => seen(q));
  if (pts.length < 3) return null;
  const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
  return { x: xs.reduce((a, b) => a + b, 0) / xs.length, y: ys.reduce((a, b) => a + b, 0) / ys.length,
    size: Math.max(Math.max(...ys) - Math.min(...ys), Math.max(...xs) - Math.min(...xs), 1) };
}

/** Nearest-neighbour ids across frames: a person keeps their id if their centre moved < 0.5 body sizes. */
export class Tracker {
  private next = 1;
  private last = new Map<number, { x: number; y: number; size: number; t: number }>();

  update(poses: Pose[], t: number): Array<{ id: number; pose: Pose }> {
    const out: Array<{ id: number; pose: Pose }> = [];
    const used = new Set<number>();
    for (const pose of poses) {
      const c = centre(pose);
      if (!c) continue;
      let best: number | null = null;
      let bestD = Infinity;
      for (const [id, l] of this.last) {
        if (used.has(id) || t - l.t > 1.0) continue;
        const d = Math.hypot(c.x - l.x, c.y - l.y);
        if (d < 0.5 * Math.max(c.size, l.size) && d < bestD) { best = id; bestD = d; }
      }
      const id = best ?? this.next++;
      used.add(id);
      this.last.set(id, { ...c, t });
      out.push({ id, pose });
    }
    for (const [id, l] of this.last) if (t - l.t > 10) this.last.delete(id);
    return out;
  }
}
