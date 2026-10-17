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
  prompt_owner: number[];
  item_text: number[][];
  bg_text: number[][];
  table: Record<string, { bin: Exclude<SpokenBin, "none">; name: string }>;
  constants: {
    item_p: number;
    known_p: number;
    min_votes: number;
    hold_window_s: number;
    observe_every_s: number;
    max_words: number;
    logit_scale: number;
  };
};

/** items.hand_box: the square just past a wrist, along the forearm, where a held item is. */
export function handBox(kp: Keypoints, side: "L" | "R", w: number, h: number): Box | null {
  const [e, wr] = side === "L" ? [7, 9] : [8, 10];
  if (kp[wr][2] < 0.3 || kp[e][2] < 0.2) return null;
  const [ex, ey] = kp[e];
  const [wx, wy] = kp[wr];
  const fore = Math.max(60, Math.hypot(wx - ex, wy - ey));
  const cx = wx + 0.35 * (wx - ex);
  const cy = wy + 0.35 * (wy - ey);
  const s = 0.6 * fore;
  const b: Box = [Math.max(0, cx - s), Math.max(0, cy - s), Math.min(w, cx + s), Math.min(h, cy + s)];
  return b[2] - b[0] > 20 && b[3] - b[1] > 20 ? b : null;
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

const BIN_NOUN: Record<Exclude<SpokenBin, "none">, string> = { compost: "compost", trash: "trash", recycle: "recycling" };

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

type Person = { votes: number[]; nVotes: number; lastHeld: number; firstHeld: number | null };
/** One hand crop's CLIP verdict (debug view): P(item), the most likely category and its share of P(item). */
export type HandScore = { pItem: number; top: string; topShare: number };

/**
 * guide_identify.ItemWatcher without the LLM path: each observation of a person's hands adds the best hand's
 * category probabilities (weighted by P(item)) to that person's votes; the catalog answers once one category has
 * known_p of the votes over min_votes observations. Hazards are never in the table, so they are never answered here.
 */
export class Watcher {
  private people = new Map<number, Person>();
  private lastObserved = new Map<number, number>();
  private lastScores = new Map<number, HandScore[]>();

  constructor(private data: GuideData) {}

  /** CLIP runs on a person's hands at most observe_every_s apart (as in the worker). */
  due(id: number, t: number): boolean {
    return t - (this.lastObserved.get(id) ?? -1e9) >= this.data.constants.observe_every_s;
  }

  /** One observation: the embeddings of this person's hand crops (both hands, if seen). */
  observe(id: number, t: number, embeddings: ArrayLike<number>[]): void {
    if (!this.due(id, t)) return;
    this.lastObserved.set(id, t);
    if (!embeddings.length) {
      this.lastScores.set(id, []);
      return;
    }
    const scored = embeddings.map((e) => score(e, this.data));
    this.lastScores.set(id, scored.map(({ pItem, pCat }) => {
      const top = pCat.reduce((best, v, i) => (v > pCat[best] ? i : best), 0);
      return { pItem, top: this.data.cats[top], topShare: pItem > 0 ? pCat[top] / pItem : 0 };
    }));
    const k = scored.reduce((best, s, i) => (s.pItem > scored[best].pItem ? i : best), 0);
    const { pItem, pCat } = scored[k];
    if (pItem < this.data.constants.item_p) return;
    const p = this.people.get(id) ?? { votes: new Array(this.data.cats.length).fill(0), nVotes: 0, lastHeld: -1e9, firstHeld: null };
    p.votes = p.votes.map((v, i) => v + pCat[i] * pItem);
    p.nVotes += 1;
    p.lastHeld = t;
    p.firstHeld ??= t;
    this.people.set(id, p);
  }

  holding(id: number, t: number): boolean {
    const p = this.people.get(id);
    return p !== undefined && t - p.lastHeld <= this.data.constants.hold_window_s;
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
    if (!p || p.nVotes < this.data.constants.min_votes) return null;
    const total = p.votes.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    const k = p.votes.reduce((best, v, i) => (v > p.votes[best] ? i : best), 0);
    const cid = this.data.cats[k];
    return p.votes[k] / total >= this.data.constants.known_p && cid in this.data.table ? cid : null;
  }

  /** Hold-up demo only (not in the worker): an empty hand for `after` seconds starts a new item. */
  resetIfIdle(id: number, t: number, after: number): void {
    const p = this.people.get(id);
    if (p && t - p.lastHeld > after) this.people.delete(id);
  }

  /** The CLIP verdicts of this person's hands at their last observation (same order as the crops), for debugging. */
  scores(id: number): HandScore[] {
    return this.lastScores.get(id) ?? [];
  }

  forget(id: number): void {
    this.people.delete(id);
    this.lastObserved.delete(id);
    this.lastScores.delete(id);
  }
}
