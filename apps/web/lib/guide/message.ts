/**
 * What the bin's speaker says. Same rules as the worker (worker/recyclone_worker/guide_message.py):
 * JSON-forced {bin: compost | trash | recycle | none, explanation}, spoken as "<Bin>. <explanation>".
 * "none" only for dangerous items, with where to take them; trash below 50% confidence.
 */
import binsJson from "../../../../worker/rules/cambridge-ma-2022.bins.json";

export type Bin = "compost" | "trash" | "recycle" | "none";
export type GuideMessage = { bin: Bin; explanation: string };
export type ProposedType = {
  name?: string | null;
  form?: string | null;
  hazardous?: boolean | null;
  suggested_destination?: string | null;
  suggestion_confidence?: number | null;
};

const TABLE = (binsJson as { items: Record<string, { bin: Exclude<Bin, "none">; name: string; basis: string }> }).items;
export const CATALOG_IDS = Object.keys(TABLE);
export const DEFAULT_TRASH_BELOW = 0.5;
const MAX_WORDS = 8;
const NOUN: Record<Exclude<Bin, "none">, string> = { compost: "compost", trash: "trash", recycle: "recycling" };
const JEV_TO_BIN: Record<string, Exclude<Bin, "none">> = { compost: "compost", trash: "trash", recycling: "recycle" };
const HAZARD: Array<[RegExp, string]> = [
  [/\b(battery|batteries|electronic|electronics|phone|phones|smartphone|smartphones|cellphone|cell phone|mobile phone|iphone|tablet|laptop|charger|cable|headphones|earbuds|bulb|lamp|vape|e-cigarette)\b/, "the Recycle Center"],
  [/\b(paint|chemical|chemicals|propane|medication|medicine|pesticide|oil|solvent|aerosol)\b/, "a hazardous waste drop-off"],
];

export function validateMessage(m: GuideMessage): void {
  if (!["compost", "trash", "recycle", "none"].includes(m.bin)) throw new Error(`bad bin ${m.bin}`);
  if (!m.explanation || m.explanation.length > 200) throw new Error("bad explanation");
  if (m.bin !== "none" && m.explanation.split(/\s+/).length > MAX_WORDS) throw new Error("explanation longer than 8 words");
}

export function spoken(m: GuideMessage): string {
  validateMessage(m);
  return `${m.bin[0].toUpperCase()}${m.bin.slice(1)}. ${m.explanation}`;
}

function placed(bin: Exclude<Bin, "none">, what: string): GuideMessage {
  const words = what.trim().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS - 3).join(" ");
  const m = { bin, explanation: `${words}, placed in ${NOUN[bin]}` };
  validateMessage(m);
  return m;
}

export function fromCatalog(id: string): GuideMessage {
  const row = Object.hasOwn(TABLE, id) ? TABLE[id] : undefined;
  if (!row) throw new Error(`not in the bin table: ${id}`);
  return placed(row.bin, row.name);
}

export function defaultTrash(what: string | null): GuideMessage {
  return placed("trash", what || "not sure what this is");
}

/** True when fromSuggestion falls back to trash: an ordinary item without a confident (>= 50%) bin from Jev. */
export function unsureSuggestion(pt: ProposedType): boolean {
  const text = `${(pt.name ?? "").trim()} ${pt.form ?? ""}`.toLowerCase();
  if (pt.hazardous || HAZARD.some(([rx]) => rx.test(text))) return false;
  const conf = pt.suggestion_confidence;
  return conf == null || conf < DEFAULT_TRASH_BELOW || !((pt.suggested_destination ?? "") in JEV_TO_BIN);
}

export function fromSuggestion(pt: ProposedType): GuideMessage {
  const name = (pt.name ?? "").trim() || "this item";
  const text = `${name} ${pt.form ?? ""}`.toLowerCase();
  const place = HAZARD.find(([rx]) => rx.test(text))?.[1];
  if (pt.hazardous || place) {
    const m: GuideMessage = {
      bin: "none",
      explanation: `${name} is dangerous to place in any of these bins. Place it in ${place ?? "a hazardous waste drop-off"} instead`,
    };
    validateMessage(m);
    return m;
  }
  if (unsureSuggestion(pt)) return defaultTrash(name);
  return placed(JEV_TO_BIN[pt.suggested_destination!], name);
}
