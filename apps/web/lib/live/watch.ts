/**
 * The demo model's item logic, live (no look ahead): worker/recyclone_worker/demo_watcher.py (the forearm hand box,
 * CLIP "is an item held", crops kept for Claude) and bins.py (which opening the item went into). The worker's
 * prepared demo sees the whole clip first; here every decision is made from the frames seen so far:
 *  - an item is identified while it is carried (first crop -> Claude; asked again if Claude saw nothing usable),
 *  - when a carried item stops being seen, the opening it was over in its last second is where it went.
 * Pure logic, no DOM: session.ts feeds it pose + CLIP results.
 */
import { handBox, type Box, type Keypoints } from "../guide/scoring";
import type { ItemAnswer, Opening } from "./claude";

export const ITEM_P = 0.5;          // demo_watcher.ITEM_P
export const CROP_GAP_S = 0.5;      // demo_watcher.CROP_GAP_S
export const KEEP_CROPS = 3;        // demo_watcher.KEEP_CROPS
export const HOLD_WINDOW_S = 1.0;   // demo_watcher.HOLD_WINDOW_S
export const OBSERVE_EVERY_S = 0.1; // demo_watcher.OBSERVE_EVERY_S
export const SEGMENT_GAP_S = 0.5;   // bins.SEGMENT_GAP_S
export const END_WINDOW_S = 1.0;    // bins.END_WINDOW_S
/** Live only: a carrying stretch shorter than this is a false sighting (bins._carry keeps the longest stretch). */
export const MIN_CARRY_S = 0.4;
/** Live only: an item not seen this long is finished; the next one seen is a new item (new identification). */
export const NEW_ITEM_AFTER_S = 5.0;
/**
 * Live only: when to ask Claude. The prepared demo sends the 3 best crops of the whole clip; live, the first crops are
 * often a far, blurry hand (IMG_9117: 72 px). A crop's quality is CLIP's P(item) x its size (full at GOOD_PX); the
 * first ask waits for a good crop, two crops, or ASK_BY_S of carrying; it is asked again (newer, better crops) while
 * the answer is not usable, and once more when the carrying stretch ends (the drop), at most MAX_ASKS times.
 */
export const GOOD_PX = 140;
export const GOOD_Q = 0.6;
export const ASK_BY_S = 1.5;
export const MAX_ASKS = 4;
export const ASK_AGAIN_AFTER_S = 0.6;
export const BETTER_BY = 0.1;
/** The bottom bar shows the last answer / outcome this long (the worker's BANNER_S). */
export const BAR_S = 5;

/**
 * demo_watcher._hand_box: the square just past a wrist along the forearm. The demo's copy needs the elbow; in front of
 * a laptop webcam the elbows are usually out of frame, so then the web guide's close-up box is used (scoring.handBox:
 * around the wrist, sized from the shoulders or ears).
 */
export function demoHandBox(kp: Keypoints, side: "L" | "R", w: number, h: number): Box | null {
  const [e, wr] = side === "L" ? [7, 9] : [8, 10];
  if (kp[wr][2] < 0.3) return null;
  if (kp[e][2] < 0.2) return handBox(kp, side, w, h);
  const [ex, ey] = kp[e];
  const [wx, wy] = kp[wr];
  const fore = Math.max(60, Math.hypot(wx - ex, wy - ey));
  const cx = wx + 0.35 * (wx - ex), cy = wy + 0.35 * (wy - ey), s = 0.6 * fore;
  const b: Box = [Math.max(0, cx - s), Math.max(0, cy - s), Math.min(w, cx + s), Math.min(h, cy + s)];
  return b[2] - b[0] > 20 && b[3] - b[1] > 20 ? b : null;
}

/** bins._drop_point: the bottom middle of the item box (where the item hangs). */
const dropPoint = (b: Box): [number, number] => [(b[0] + b[2]) / 2, b[3]];

/** bins._over: the drop point is over the opening, grown by half its size (the hand is above the hole, not in it). */
export function over(box: Box, o: Box): boolean {
  const [cx, cy] = dropPoint(box);
  const gx = 0.5 * (o[2] - o[0]), gy = 0.5 * (o[3] - o[1]);
  return o[0] - gx <= cx && cx <= o[2] + gx && o[1] - gy <= cy && cy <= o[3] + gy;
}

/**
 * bins.same_openings: the same openings in about the same places (within tol x the frame width): the camera did not
 * move. An arm over the bins shifts the boxes a little (IMG_9117-9120); a pan moves them hundreds of pixels (IMG_9121).
 */
export function sameOpenings(a: Opening[], b: Opening[], width: number, tol = 0.12): boolean {
  if (!a.length || a.length !== b.length) return false;
  const c = (o: Opening) => [(o.box[0] + o.box[2]) / 2, (o.box[1] + o.box[3]) / 2];
  return a.every((x) => Math.min(...b.map((y) => Math.abs(c(x)[0] - c(y)[0]) + Math.abs(c(x)[1] - c(y)[1]))) <= tol * width);
}

export type Sighting = { t: number; box: Box };
export type Outcome = { t: number; bin: Opening["bin"]; label: string };

/** bins.thrown_into for one finished carrying stretch: the opening the item was over in its last second, if any. */
export function thrownInto(stretch: Sighting[], openings: Opening[]): Outcome | null {
  if (!stretch.length || !openings.length) return null;
  const end = stretch[stretch.length - 1].t;
  for (let i = stretch.length - 1; i >= 0; i--) {
    const { t, box } = stretch[i];
    if (end - t > END_WINDOW_S) break;
    const near = openings.filter((o) => over(box, o.box));
    if (near.length) {
      const [cx, cy] = dropPoint(box);
      const d = (o: Opening) => Math.abs((o.box[0] + o.box[2]) / 2 - cx) + Math.abs((o.box[1] + o.box[3]) / 2 - cy);
      const o = near.reduce((a, b) => (d(b) < d(a) ? b : a));
      return { t, bin: o.bin, label: o.label };
    }
  }
  return null;
}

type Crop = { t: number; q: number; image: string };
export type Item = {
  firstSeen: number;
  lastHeld: number;
  box: Box | null;
  /** Sightings of the current carrying stretch (cleared when the stretch ends). */
  stretch: Sighting[];
  crops: Crop[];
  answer: ItemAnswer | null;
  asking: boolean;
  asks: number;
  lastAsk: number;
  cropsAtAsk: number;
  bestAtAsk: number;
  /** Set once the item is finished: an answer that arrives later still updates it (the event list shows the best one). */
  event?: Event;
};

/** A finished item: what Claude said it was, and which opening it went into (null: not over any opening). */
export type Event = { t: number; answer: ItemAnswer | null; outcome: Outcome | null };

export type Ask = (crops: string[]) => Promise<ItemAnswer>;

export class LiveWatcher {
  readonly items = new Map<number, Item>();
  private observed = new Map<number, number>();
  openings: Opening[] = [];

  /**
   * onEvent(e, update): a finished item; update = true when a later answer (or the drop's opening) changed e.
   * dropBins(id, stretch): the openings seen in the frame of the stretch's last sighting (bins.py re-detects on the drop
   * frame when the camera moved: IMG_9118-9121 were filmed by hand); null -> the openings found at the start.
   */
  constructor(private ask: Ask, private onEvent: (e: Event, update?: boolean) => void = () => {},
    private dropBins?: (id: number, stretch: Sighting[]) => Promise<Opening[] | null>) {}

  due(id: number, t: number): boolean {
    return t - (this.observed.get(id) ?? -1e9) >= OBSERVE_EVERY_S;
  }

  /**
   * One look at a person's hands: `pItem[k]` is CLIP's P(item) for `boxes[k]`. `capture(k)` gives that hand crop
   * face-redacted (or null: it must not leave the device).
   */
  observe(id: number, t: number, boxes: Box[], pItem: number[], capture: (k: number) => string | null): void {
    this.observed.set(id, t);
    if (!boxes.length) return;
    const k = pItem.reduce((best, p, i) => (p > pItem[best] ? i : best), 0);
    if (pItem[k] < ITEM_P) return;
    let item = this.items.get(id);
    if (item && t - item.lastHeld > NEW_ITEM_AFTER_S) {
      this.finish(id, item);
      item = undefined;
    }
    if (!item) {
      item = { firstSeen: t, lastHeld: t, box: null, stretch: [], crops: [], answer: null, asking: false, asks: 0, lastAsk: -1e9, cropsAtAsk: 0, bestAtAsk: 0 };
      this.items.set(id, item);
    }
    item.lastHeld = t;
    item.box = boxes[k];
    item.stretch.push({ t, box: boxes[k] });
    if (item.crops.every((c) => Math.abs(t - c.t) >= CROP_GAP_S)) {
      const image = capture(k);
      if (image) {
        const side = Math.min(boxes[k][2] - boxes[k][0], boxes[k][3] - boxes[k][1]);
        item.crops.push({ t, q: pItem[k] * Math.min(1, side / GOOD_PX), image });
        item.crops = item.crops.sort((a, b) => b.q - a.q).slice(0, KEEP_CROPS);
      }
    }
    this.maybeAsk(item, t);
  }

  /** See GOOD_Q / ASK_BY_S / BETTER_BY. `final`: the carrying stretch just ended, last chance with these crops. */
  private maybeAsk(item: Item, t: number, final = false): void {
    const usable = item.answer && item.answer.message && item.answer.source !== "unclear";
    if (usable || item.asking || item.asks >= MAX_ASKS || !item.crops.length) return;
    const best = Math.max(...item.crops.map((c) => c.q));
    if (item.asks === 0) {
      if (!(final || item.crops.length >= 2 || best >= GOOD_Q || t - item.firstSeen >= ASK_BY_S)) return;
    } else {
      const newer = best >= item.bestAtAsk + BETTER_BY || item.crops.length > item.cropsAtAsk;
      if (!final && (!newer || t - item.lastAsk < ASK_AGAIN_AFTER_S)) return;
      if (final && !newer) return;
    }
    item.asking = true;
    item.asks += 1;
    item.lastAsk = t;
    item.cropsAtAsk = item.crops.length;
    item.bestAtAsk = best;
    const crops = [...item.crops].sort((a, b) => a.t - b.t).map((c) => c.image);
    this.ask(crops)
      .then((a) => {
        // A sure answer is kept; a later unsure one never replaces it.
        if (!item.answer || !item.answer.message || item.answer.source === "unclear" || a.message) {
          item.answer = a;
          if (item.event) {
            item.event.answer = a;
            this.onEvent(item.event, true);
          }
        }
      })
      .catch(() => undefined)
      .finally(() => {
        item.asking = false;
      });
  }

  holding(id: number, t: number): boolean {
    const item = this.items.get(id);
    return !!item && t - item.lastHeld <= HOLD_WINDOW_S && item.answer?.source !== "nothing_held";
  }

  /**
   * Called every frame after the looks: a stretch with no sighting for SEGMENT_GAP_S has ended -> which opening
   * (if any) the item went into. An item that went into an opening is finished.
   */
  tick(t: number, present: Set<number>): void {
    for (const [id, item] of this.items) {
      const gone = !present.has(id);
      if (item.stretch.length && (gone || t - item.lastHeld > SEGMENT_GAP_S)) {
        const s = item.stretch;
        item.stretch = [];
        this.maybeAsk(item, t, true);
        const carried = s[s.length - 1].t - s[0].t >= MIN_CARRY_S;
        if (carried && this.dropBins) {
          this.resolveDrop(id, item, s, t);
          continue;
        }
        const outcome = carried ? thrownInto(s, this.openings) : null;
        if (outcome) {
          item.event = { t, answer: item.answer, outcome };
          this.onEvent(item.event);
          this.items.delete(id);
          continue;
        }
      }
      if (gone || t - item.lastHeld > NEW_ITEM_AFTER_S) this.finish(id, item);
    }
    for (const id of this.observed.keys()) if (!present.has(id)) this.observed.delete(id);
  }

  /** The drop's opening from the drop frame's own bins (async); the item is finished if it went into one. */
  private resolveDrop(id: number, item: Item, s: Sighting[], t: number): void {
    this.dropBins!(id, s)
      .catch(() => null)
      .then((ops) => {
        const outcome = thrownInto(s, ops?.length ? ops : this.openings);
        if (!outcome) return;
        if (item.event) {  // already finished (left view) while the bins were being found
          item.event.outcome = outcome;
          this.onEvent(item.event, true);
          return;
        }
        if (this.items.get(id) === item && !item.stretch.length) this.items.delete(id);
        item.event = { t, answer: item.answer, outcome };
        this.onEvent(item.event);
      });
  }

  private finish(id: number, item: Item): void {
    this.items.delete(id);
    if (item.answer?.message || item.asking) {
      item.event = { t: item.lastHeld, answer: item.answer, outcome: null };
      this.onEvent(item.event);
    }
  }
}
