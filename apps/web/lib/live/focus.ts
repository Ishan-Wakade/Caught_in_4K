/**
 * Crowded rooms (18 Oct, for a hackathon demo: lights and people everywhere). On 8 open-licence crowd videos (Indic
 * Wikimedia Hackathon 2023, a conference, a station) the live camera said "RECYCLE plastic water bottle" in 4 of 8
 * (bottles on tables next to people's resting hands), asked Claude 88 times in ~3 min, and 20 of 94 crops it sent
 * showed a bystander's face. The fixes here, all on the browser side:
 *  - one person: the largest person, and only if near enough to be the one at the camera (pickPrimary);
 *  - a hand counts only when raised: wrist above its elbow when the elbow is seen (raisedHands);
 *  - the crop keeps that person's region only; everything else, and every other head, is black (keepRegion).
 */
import type { Box, Keypoints } from "../guide/scoring";

export type Found = { box: Box; score?: number; kp: Keypoints };

/** The person at the camera fills at least this share of the frame's height (or MIN_WIDTH of its width). */
export const MIN_HEIGHT = 0.4;
export const MIN_WIDTH = 0.22;
/** The kept region around that person, as a share of their box (arms held out reach a bit past the box). */
export const KEEP_MARGIN = 0.15;

const area = (b: Box) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/** Index of the person at the camera (the largest one, if near enough), or -1. */
export function pickPrimary(people: Found[], w: number, h: number): number {
  let best = -1;
  people.forEach((p, i) => {
    if (best < 0 || area(p.box) > area(people[best].box)) best = i;
  });
  if (best < 0) return -1;
  const b = people[best].box;
  return b[3] - b[1] >= MIN_HEIGHT * h || b[2] - b[0] >= MIN_WIDTH * w ? best : -1;
}

/**
 * Keypoints with the lowered hands removed (wrist confidence 0, so no hand box is made for it): a wrist below its
 * elbow, when both are seen, is resting (on a table, by the side), not showing an item. Elbow out of frame (a close-up
 * at a laptop): the hand is kept.
 */
export function raisedHands(kp: Keypoints): Keypoints {
  const out = kp.map((k) => [...k]);
  for (const [e, wr] of [[7, 9], [8, 10]]) {
    if (kp[e][2] >= 0.3 && kp[wr][2] >= 0.3 && kp[wr][1] > kp[e][1]) out[wr][2] = 0;
  }
  return out;
}

/** The region of the frame a crop may show: the person's box grown by KEEP_MARGIN, inside the frame. */
export function keepRegion(p: Found, w: number, h: number): Box {
  const [x0, y0, x1, y1] = p.box;
  const mx = KEEP_MARGIN * (x1 - x0), my = KEEP_MARGIN * (y1 - y0);
  return [Math.max(0, x0 - mx), Math.max(0, y0 - my), Math.min(w, x1 + mx), Math.min(h, y1 + my)];
}

/**
 * Light: stretch each colour channel so its 1st-99th percentile spans 0-255 (backlit or dim items), only when the
 * crop's range is narrow. Black (redacted) pixels are left out of the percentiles and stay black.
 */
export function autoLevels(px: Uint8ClampedArray): void {
  for (let c = 0; c < 3; c++) {
    const hist = new Array<number>(256).fill(0);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] === 0 && px[i + 1] === 0 && px[i + 2] === 0) continue;
      hist[px[i + c]]++;
      n++;
    }
    if (n < 100) return;
    const at = (q: number) => {
      let s = 0;
      for (let v = 0; v < 256; v++) if ((s += hist[v]) >= q * n) return v;
      return 255;
    };
    const lo = at(0.01), hi = at(0.99);
    if (hi - lo >= 200 || hi <= lo) continue;
    const k = 255 / (hi - lo);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] === 0 && px[i + 1] === 0 && px[i + 2] === 0) continue;
      px[i + c] = Math.max(1, Math.min(255, Math.round((px[i + c] - lo) * k)));
    }
  }
}

/**
 * What Claude sees for the person at the camera: their hands and upper body (shoulders to the hand that holds the
 * item, plus the hand box), padded, inside their kept region. 18 Oct logs: hand-box crops at a laptop camera were
 * mostly "hand and sleeve" / "dark fabric" (the box CLIP picked lay on the arm), while whole pictures of a hand
 * holding an item were 11/11 right.
 */
export function upperBody(p: Found, hand: Box, w: number, h: number): Box {
  const kp = p.kp;
  const pts: number[][] = [[hand[0], hand[1]], [hand[2], hand[3]]];
  for (const j of [5, 6, 9, 10]) if (kp[j][2] >= 0.3) pts.push([kp[j][0], kp[j][1]]);
  const shoulder = kp[5][2] >= 0.3 && kp[6][2] >= 0.3 ? Math.abs(kp[5][0] - kp[6][0]) : (hand[2] - hand[0]);
  const pad = 0.35 * shoulder;
  const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
  const [k0, k1, k2, k3] = keepRegion(p, w, h);
  return [Math.max(k0, Math.min(...xs) - pad), Math.max(k1, Math.min(...ys) - pad), Math.min(k2, Math.max(...xs) + pad), Math.min(k3, Math.max(...ys) + pad)];
}
