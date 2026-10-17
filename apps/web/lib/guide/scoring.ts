/**
 * E's voice-guide fast path, ported for the browser: worker/recyclone_worker/guide_identify.py (ItemWatcher),
 * items.py (hand_box, Scorer) and guide_message.py (catalog messages). The numbers come from
 * public/models/guide.json, generated from the worker by scripts/build_guide_model.py; scoring.test.ts checks this
 * file against the worker's own outputs (lib/guide/__fixtures__/parity.json).
 */

export type SpokenBin = "compost" | "trash" | "recycle" | "none";
export type GuideMessage = { bin: SpokenBin; explanation: string };
export type Box = [number, number, number, number];
/** 17 COCO keypoints, each [x, y, confidence], in frame pixels. */
export type Keypoints = number[][];

export type GuideData = {
  clip: { repo: string; revision: string; webgpu: string; wasm: string };
  cats: string[];
  /** Per category: its generic kind with the same bin (categories.PRODUCT_PARENT), or itself. */
  parent: string[];
  prompt_owner: number[];
  item_text: number[][];
  bg_text: number[][];
  background: string[];
  table: Record<string, { bin: Exclude<SpokenBin, "none">; name: string }>;
  constants: {
    item_p: number;
    known_p: number;
    min_votes: number;
    hold_window_s: number;
    hold_recent: number;
    hold_confirm: number;
    observe_every_s: number;
    max_words: number;
    logit_scale: number;
  };
};

/** items._forearm_from_body: a forearm length from confident shoulders (x0.7) or ears (x1.7), when no elbow is seen. */
function forearmFromBody(kp: Keypoints): number | null {
  for (const [a, b, k] of [[5, 6, 0.7], [3, 4, 1.7]]) {
    if (kp[a][2] >= 0.5 && kp[b][2] >= 0.5) return k * Math.hypot(kp[a][0] - kp[b][0], kp[a][1] - kp[b][1]);
  }
  return null;
}

/**
 * items.hand_box: the square just past a wrist, along the forearm, where a held item is. With the elbow out of frame
 * (close to a webcam), the box is around the wrist, reaching further up than down, sized from the shoulders or ears.
 */
export function handBox(kp: Keypoints, side: "L" | "R", w: number, h: number): Box | null {
  const [e, wr] = side === "L" ? [7, 9] : [8, 10];
  if (kp[wr][2] < 0.3) return null;
  const [wx, wy] = kp[wr];
  let cx: number, cy: number, s: number;
  if (kp[e][2] >= 0.2) {
    const [ex, ey] = kp[e];
    // A forearm pointing at the camera looks short: never below 0.6 of the body's estimate (items.FORE_MIN_SHARE).
    const fore = Math.max(60, Math.hypot(wx - ex, wy - ey), 0.6 * (forearmFromBody(kp) ?? 0));
    [cx, cy, s] = [wx + 0.35 * (wx - ex), wy + 0.35 * (wy - ey), 0.6 * fore];
  } else {
    const body = forearmFromBody(kp);
    if (body === null) return null;
    const fore = Math.max(60, body);
    [cx, cy, s] = [wx, wy - 0.2 * fore, 0.85 * fore];
  }
  const b: Box = [Math.max(0, cx - s), Math.max(0, cy - s), Math.min(w, cx + s), Math.min(h, cy + s)];
  return b[2] - b[0] > 20 && b[3] - b[1] > 20 ? b : null;
}

function square(cx: number, cy: number, s: number, w: number, h: number): Box | null {
  const b: Box = [Math.max(0, cx - s), Math.max(0, cy - s), Math.min(w, cx + s), Math.min(h, cy + s)];
  return b[2] - b[0] > 20 && b[3] - b[1] > 20 ? b : null;
}

/**
 * items.hand_scan: boxes to look for a held item in, best first: each hand box, the same grown 1.6x, and for a raised
 * hand (wrist above the shoulder line + half a shoulder width) the box between the wrist and the face, where an item
 * held up to a camera is. The crop CLIP is surest holds an item is the one used.
 */
export function handScan(kp: Keypoints, w: number, h: number): Box[] {
  const out: Box[] = [];
  for (const side of ["L", "R"] as const) {
    const b = handBox(kp, side, w, h);
    if (!b) continue;
    out.push(b);
    const grown = square((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, (1.6 * Math.max(b[2] - b[0], b[3] - b[1])) / 2, w, h);
    if (grown) out.push(grown);
  }
  if (kp[5][2] < 0.3 || kp[6][2] < 0.3) return out; // items.SCAN_SHOULDER_MIN
  const width = Math.abs(kp[5][0] - kp[6][0]);
  const line = Math.min(kp[5][1], kp[6][1]);
  const face = kp[0][2] >= 0.3 ? [kp[0][0], kp[0][1]] : [(kp[5][0] + kp[6][0]) / 2, line - 0.5 * width];
  for (const wr of [9, 10]) {
    if (kp[wr][2] < 0.3 || kp[wr][1] >= line + 0.5 * width) continue;
    const d = Math.hypot(kp[wr][0] - face[0], kp[wr][1] - face[1]);
    const b = square((kp[wr][0] + face[0]) / 2, (kp[wr][1] + face[1]) / 2, Math.max(80, 0.75 * d), w, h);
    if (b) out.push(b);
  }
  return out;
}

function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** items.Scorer for one L2-normalized CLIP image embedding: P(item) and P(each category). */
export function score(emb: ArrayLike<number>, data: GuideData): { pItem: number; pCat: number[] } {
  const n = data.cats.length;
  const perCat = new Array<number>(n).fill(-1);
  data.item_text.forEach((t, i) => {
    const k = data.prompt_owner[i];
    perCat[k] = Math.max(perCat[k], dot(emb, t));
  });
  const logits = [...perCat, ...data.bg_text.map((t) => dot(emb, t))].map((s) => data.constants.logit_scale * s);
  const top = Math.max(...logits);
  const exp = logits.map((l) => Math.exp(l - top));
  const sum = exp.reduce((a, b) => a + b, 0);
  const pCat = exp.slice(0, n).map((v) => v / sum);
  return { pItem: pCat.reduce((a, b) => a + b, 0), pCat };
}

/** Debug overlay: P(item) and the closest label overall (a catalog category or a background prompt) for one crop. */
export function lookAt(emb: ArrayLike<number>, data: GuideData): { pItem: number; label: string } {
  const sims = new Map<string, number>();
  data.item_text.forEach((t, i) => {
    const c = data.cats[data.prompt_owner[i]];
    sims.set(c, Math.max(sims.get(c) ?? -1, dot(emb, t)));
  });
  data.bg_text.forEach((t, i) => sims.set(data.background[i], dot(emb, t)));
  const [label] = [...sims].reduce((best, s) => (s[1] > best[1] ? s : best));
  return { pItem: score(emb, data).pItem, label: label.replace(/^item_(generic_)?/, "") };
}

const BIN_NOUN:Record<Exclude<SpokenBin, "none">, string> = { compost: "compost", trash: "trash", recycle: "recycling" };

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}

/** guide_message._placed: "<what, cut short>, placed in <bin>", at most eight words. */
function placed(bin: Exclude<SpokenBin, "none">, what: string, maxWords: number): GuideMessage {
  const explanation = `${words(what).slice(0, maxWords - 3).join(" ")}, placed in ${BIN_NOUN[bin]}`;
  return { bin, explanation: words(explanation).slice(0, maxWords).join(" ") };
}

export function fromCatalog(itemId: string, data: GuideData): GuideMessage {
  const row = data.table[itemId];
  return placed(row.bin, row.name, data.constants.max_words);
}

/** guide_message.default_trash: the team's rule when the answer is very uncertain or missing. */
export function defaultTrash(data: GuideData, what?: string | null): GuideMessage {
  return placed("trash", what || "not sure what this is", data.constants.max_words);
}

type Person = {
  votes: number[];
  nVotes: number;
  lastHeld: number;
  firstHeld: number | null;
  /** Did each of the last hold_recent looks see an item? hold_confirm of them start "holding". */
  recent: boolean[];
  confirmed: boolean;
  /** The first catalog answer, kept for this item (no switching between guesses). */
  locked: string | null;
};

/**
 * guide_identify.ItemWatcher without the LLM path: each observation of a person's hands adds the best hand's
 * category probabilities (weighted by P(item)) to that person's votes; the catalog answers once one category has
 * known_p of the votes over min_votes observations, and keeps that first answer. "Holding" needs hold_confirm of the
 * last hold_recent looks to see an item. Hazards are never in the table, so they are never answered here.
 */
export class Watcher {
  private people = new Map<number, Person>();
  private lastObserved = new Map<number, number>();

  constructor(private data: GuideData) {}

  /** CLIP runs on a person's hands at most observe_every_s apart (as in the worker). */
  due(id: number, t: number): boolean {
    return t - (this.lastObserved.get(id) ?? -1e9) >= this.data.constants.observe_every_s;
  }

  /** One observation: the embeddings of this person's hand crops (both hands, if seen). */
  observe(id: number, t: number, embeddings: ArrayLike<number>[]): void {
    if (!this.due(id, t)) return;
    this.lastObserved.set(id, t);
    if (!embeddings.length) return;
    const scored = embeddings.map((e) => score(e, this.data));
    const k = scored.reduce((best, s, i) => (s.pItem > scored[best].pItem ? i : best), 0);
    const { pItem, pCat } = scored[k];
    const c = this.data.constants;
    const p = this.people.get(id)
      ?? { votes: new Array(this.data.cats.length).fill(0), nVotes: 0, lastHeld: -1e9, firstHeld: null, recent: [], confirmed: false, locked: null };
    this.people.set(id, p);
    if (t - p.lastHeld > c.hold_window_s) [p.recent, p.confirmed] = [[], false]; // empty for a while: confirm afresh
    p.recent = [...p.recent, pItem >= c.item_p].slice(-c.hold_recent);
    p.confirmed ||= p.recent.filter(Boolean).length >= c.hold_confirm;
    if (pItem < c.item_p) return;
    p.votes = p.votes.map((v, i) => v + pCat[i] * pItem);
    p.nVotes += 1;
    p.lastHeld = t;
    p.firstHeld ??= t;
  }

  holding(id: number, t: number): boolean {
    const p = this.people.get(id);
    return p !== undefined && p.confirmed && t - p.lastHeld <= this.data.constants.hold_window_s;
  }

  /** An item was seen in this person's hand within the last `s` seconds (the page fades its banner out otherwise). */
  seenWithin(id: number, t: number, s: number): boolean {
    const p = this.people.get(id);
    return p !== undefined && t - p.lastHeld <= s;
  }

  /** Seconds this person has been holding the current item. */
  heldFor(id: number, t: number): number {
    const p = this.people.get(id);
    return p?.firstHeld == null ? 0 : t - p.firstHeld;
  }

  /** When the current item was first seen in this person's hand (it identifies the item), or null. */
  itemStart(id: number): number | null {
    return this.people.get(id)?.firstHeld ?? null;
  }

  answer(id: number): GuideMessage | null {
    const cid = this.answerId(id);
    return cid ? fromCatalog(cid, this.data) : null;
  }

  /** The catalog item the votes settled on, or null. */
  answerId(id: number): string | null {
    const p = this.people.get(id);
    if (p?.locked) return p.locked;
    if (!p || p.nVotes < this.data.constants.min_votes) return null;
    const total = p.votes.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    const k = p.votes.reduce((best, v, i) => (v > p.votes[best] ? i : best), 0);
    const cid = this.data.cats[k];
    if (p.votes[k] / total >= this.data.constants.known_p && cid in this.data.table) return (p.locked = cid);
    // Votes split between a product and its generic kind (same bin): the generic kind answers (as ItemWatcher._catalog).
    const pooled = new Map<string, number>();
    this.data.cats.forEach((c, i) => pooled.set(this.data.parent[i], (pooled.get(this.data.parent[i]) ?? 0) + p.votes[i]));
    const [kind, v] = [...pooled].reduce((best, e) => (e[1] > best[1] ? e : best));
    return v / total >= this.data.constants.known_p && kind in this.data.table ? (p.locked = kind) : null;
  }

  /** Hold-up demo only (not in the worker): an empty hand for `after` seconds starts a new item. */
  resetIfIdle(id: number, t: number, after: number): void {
    const p = this.people.get(id);
    if (p && t - p.lastHeld > after) this.people.delete(id);
  }

  forget(id: number): void {
    this.people.delete(id);
    this.lastObserved.delete(id);
  }
}
