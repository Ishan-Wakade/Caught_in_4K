/**
 * Server side of /model: the worker's demo model (worker/recyclone_worker/claude_namer.py and bins.py) on the web.
 * - identifyItem: ONE Claude call per carried item on face-redacted crops (same system prompt and JSON schema as the
 *   worker), then the same bin decision as the web guide (catalog pick, catalog kind by form/material, else Jev).
 * - findOpenings: one Claude call on a face-redacted frame: every bin opening, its printed label, its bin, its box.
 * Keys stay on the server. Any provider failure -> an "unclear"/empty answer, never an invented one.
 */
import binsJson from "../../../../worker/rules/cambridge-ma-2022.bins.json";
import productsJson from "./products.json";
import { catalogKind } from "../guide/identify";
import { CATALOG_IDS, defaultTrash, fromSuggestion, unsureSuggestion, type GuideMessage } from "../guide/message";
import { LOCAL_RULES } from "../guide/rules";

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

const API_URL = "https://api.anthropic.com/v1/messages";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** Haiku 5.5: same answers as Sonnet 5.5 on the 11 test photos (17 Oct), ~1.0 s instead of ~1.7 s. LIVE_ITEM_MODEL overrides. */
export const ITEM_MODEL = process.env.LIVE_ITEM_MODEL || "claude-haiku-5-5";
/** Haiku is fast but less sure on blurry real crops (17 Oct: IMG_9117 cup "not sure", IMG_9121 chip bag "sandwich in
 * wrapper"): an answer below ESCALATE_BELOW is asked again of this model on the same crops ("" turns it off). */
export const ESCALATE_MODEL = process.env.LIVE_ESCALATE_MODEL ?? "";  // 18 Oct: off by default -- on small webcam crops Sonnet was as unsure as Haiku and took 2.3-2.5 s, past Jolie's 1.5 s wait
export const ESCALATE_BELOW = 0.7;
export const BINS_MODEL = process.env.LIVE_BINS_MODEL || "claude-sonnet-5-5";
/** Each model's own "no thinking" (claude_namer.THINKING_OFF): Haiku 5.5 otherwise spends its budget thinking. */
const THINKING_OFF: Record<string, object> = { "claude-haiku-5-5": { type: "disabled" }, "claude-sonnet-5-5": { type: "between_tools" } };
const BRANDS = ["beanco", "tacostop", "greenbowl", "shakeshack", "goldfish", "biscoff"];
const CATALOG_PICK_MIN = 0.5; // demo_watcher.CATALOG_PICK_MIN
const NAME_MIN = 0.4;         // demo_watcher.NAME_MIN: below this nothing is named
/** Live camera: a name that says nothing ("small handheld object", 18 Oct crowd test: Jev then said trash) is "not sure". */
const VAGUE = /^(?:(?:small|little|unknown|unidentified|unclear|handheld|hand-held|held|some|an?|dark|light|white|black)\s+)*(?:object|item|thing|stuff)s?$/i;

const TABLE = (binsJson as { items: Record<string, { name: string }> }).items;
/**
 * ~110 more product types (products.json), each with the bin the quoted Cambridge rule gives it ("jev": the rules do
 * not clearly decide it, Jev chooses). Only Claude sees them: as on-device CLIP words they fired on 72% of empty hands
 * in the dev clips (7% without them, 17 Oct), so the "is an item held" check keeps its own words.
 */
type Product = { id: string; name: string; bin: "recycle" | "compost" | "trash" | "none" | "jev"; rule: string };
const PRODUCTS = new Map<string, Product>((productsJson.products as [string, string, Product["bin"], string, string[]][])
  .map(([id, name, bin, rule]) => [id, { id, name, bin, rule }]));
/** Where a SPECIAL item goes, by its rule; R_HAZARD and electronics/batteries/bulbs/vapes are "dangerous". */
const SPECIAL: Record<string, string> = { R_ELECTRONICS: "the Recycle Center", R_TEXTILES: "a textile donation bin", R_HAZARD: "a household hazardous waste drop-off" };
const DANGEROUS = new Set(["p_phone", "p_cable", "p_earbuds", "p_vape", "p_tablet", "p_watch", "p_battery_lithium", "p_bulb"]);
/** claude_namer.generic_catalog: no brand products (a model cannot pick a brand it cannot see), then the product types. */
const CATALOG = [...CATALOG_IDS.filter((id) => !BRANDS.some((b) => id.includes(b))).map((id) => `${id}: ${TABLE[id].name}`),
  ...[...PRODUCTS.values()].map((p) => `${p.id}: ${p.name}`)].join("\n");

/** A product that goes in none of the bins: where it goes instead (bin "none", spoken as "None. ..."). */
function special(name: string, p: Product): GuideMessage {
  const place = SPECIAL[p.rule] ?? "the Recycle Center";
  const why = DANGEROUS.has(p.id) || p.rule === "R_HAZARD" ? "is dangerous to place in any of these bins" : "does not go in any of these bins";
  return { bin: "none", explanation: `${name} ${why}. Place it in ${place} instead` };
}

// claude_namer.SYSTEM without the "reasons" part: this page never says a reason, and writing three of them was most
// of the answer's length (and so of its time).
const SYSTEM = `You identify ONE object a person is carrying to a set of waste bins, from a few small crops of it (the same object at different moments; a hand may be in the crop).
Solid black rectangles are faces blanked out for privacy: they are not objects and not part of any object.
Set identifiable to false ONLY if no object is visible at all (just a hand, a sleeve or clothing). If you can see an object but are unsure of its exact type, keep identifiable true and give your best generic name ("printed paper", "plastic bag") with a lower confidence.
Pick a catalog item only if the object clearly IS that item; otherwise catalog_item_id is null. Never name a brand unless its logo or text is clearly visible.
name: short generic name of the object, at most 4 words ("paper coffee cup", "plastic water bottle"). If you are not sure of the exact kind, use a more general name ("food item", "paper item", "plastic wrapper") instead of guessing a specific one; never invent an object that is not clearly in the crops.

Catalog (id: description):
${CATALOG}

Local rules (Cambridge, MA):
${LOCAL_RULES}`;

const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    catalog_item_id: { anyOf: [{ type: "string" }, { type: "null" }] },
    confidence: { type: "number", description: "0 to 1" },
    identifiable: { type: "boolean" },
    name: { type: "string" },
    material: { type: "string", enum: ["plastic_film", "rigid_plastic", "paper", "cardboard", "metal", "glass", "organic", "textile", "foam", "mixed", "unknown"] },
    form: { type: "string" },
    condition: { type: "string", enum: ["clean", "food_residue", "liquid", "unknown"] },
    hazardous: { type: "boolean" },
  },
  required: ["catalog_item_id", "confidence", "identifiable", "name", "material", "form", "condition", "hazardous"],
};

// bins.py PROMPT / SCHEMA, word for word.
const BINS_PROMPT = (w: number, h: number) => `This image is ${w}x${h} pixels. Find every opening (hole) of the waste bins. For each: the label printed next to it (exact text; if there is only an icon, describe it, e.g. "recycling icon"), which bin it is (WASTE/LANDFILL/TRASH or a trash-can figure=trash, RECYCLING or the recycling arrows=recycle, ORGANICS/COMPOST or an apple/leaf=compost; unknown if neither a label nor an icon is readable), and a tight box around the opening in pixel coordinates x0,y0,x1,y1 of this image. Only openings that are really in the image.`;
const BINS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["openings"],
  properties: { openings: { type: "array", items: {
    type: "object", additionalProperties: false, required: ["label_text", "bin", "x0", "y0", "x1", "y1"],
    properties: { label_text: { type: "string" }, bin: { type: "string", enum: ["recycle", "trash", "compost", "unknown"] },
      x0: { type: "number" }, y0: { type: "number" }, x1: { type: "number" }, y1: { type: "number" } } } } },
};

export type ItemAnswer = {
  message: GuideMessage | null;
  /** catalog: Claude picked a catalog item or its form/material is a catalog kind; llm: Jev decided the bin;
   * unclear: too unsure to name; nothing_held: no object in the crops; error: the provider failed. */
  source: "catalog" | "llm" | "unclear" | "nothing_held" | "error";
  /** What Claude saw (shown on the item box): its generic name, material, form, condition, confidence. */
  item?: { name: string; material: string; form: string; condition: string; confidence: number; catalog_item_id: string | null };
  /** For a product type: the rule line its bin comes from (products.json). */
  rule?: string;
  /** The model whose answer this is (the fast one, or the escalation). */
  model?: string;
};
export type Opening = { bin: "recycle" | "trash" | "compost" | "unknown"; label: string; box: [number, number, number, number] };

async function claude(fetchFn: Fetch, key: string, model: string, body: object, timeoutMs: number): Promise<any> {
  const res = await fetchFn(API_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, ...(THINKING_OFF[model] ? { thinking: THINKING_OFF[model] } : {}), ...body }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Claude HTTP ${res.status}`);
  const r = await res.json();
  const text = r.content.find((b: { type: string }) => b.type === "text")?.text;
  return JSON.parse(text);
}

const image = (dataUrl: string) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: dataUrl.split(",")[1] } });

async function jev(fetchFn: Fetch, key: string, item: object): Promise<{ choice?: string; confidence?: number }> {
  const res = await fetchFn(JEV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "jev-latest",
      state: JSON.stringify({ item, local_rules: LOCAL_RULES }),
      questions: { bin: { type: "choice", instructions: "Under the local rules given in the state, where should this item be disposed of?", criteria: {
        recycling: "Curbside recycling cart",
        compost: "Curbside compost (food scraps and the paper items the rules accept)",
        trash: "Trash (not recyclable, not compostable, not a special item)",
        special: "Not curbside: drop-off, Recycle Center, textile donation, or hazardous waste event",
      } } },
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}`);
  return (await res.json()).answers.bin;
}

const BIN_TO_DEST: Record<string, string> = { recycle: "recycling", compost: "compost", trash: "trash" };
const binOf = (id: string) => (binsJson as { items: Record<string, { bin: string }> }).items[id].bin;
/** Claude's own name with a known bin ("<name>, placed in <bin>"). */
const named = (name: string, bin: string) => fromSuggestion({ name, suggested_destination: BIN_TO_DEST[bin], suggestion_confidence: 1 });

/** Fast model first; an unsure answer (not "nothing held") goes to ESCALATE_MODEL, whose answer is used. */
/** The live camera ("hold it up to the camera"): an object that is not held up in a hand is not the answer (18 Oct
 * crowd test: water bottles standing on tables behind became "RECYCLE plastic water bottle"). */
const HOLDUP = `
The camera is a demo station: someone holds an item up close to it. If no object is held in a hand close to the camera (objects standing on a table, lying around, or in the background behind people), set identifiable to false.
Black areas are faces and people in the background blanked out for privacy. The object is the thing in the hand; clothing, sleeves, hands, arms and furniture are never the object.
Soft, thin, white paper that is crumpled or folded (tissue-like) is a used paper napkin or tissue (item_napkin), not printer paper.`;

export async function identifyItem(crops: string[], keys: { anthropic: string; jev: string }, fetchFn: Fetch = fetch as unknown as Fetch,
  holdup = false): Promise<ItemAnswer> {
  const first = await identifyWith(ITEM_MODEL, crops, keys, fetchFn, holdup);
  const sure = first.source === "nothing_held" || (first.source !== "unclear" && first.source !== "error" && (first.item?.confidence ?? 0) >= ESCALATE_BELOW);
  if (sure || !ESCALATE_MODEL || ESCALATE_MODEL === ITEM_MODEL) return { ...first, model: ITEM_MODEL };
  const second = await identifyWith(ESCALATE_MODEL, crops, keys, fetchFn, holdup);
  return second.source === "error" ? { ...first, model: ITEM_MODEL } : { ...second, model: ESCALATE_MODEL };
}

async function identifyWith(model: string, crops: string[], keys: { anthropic: string; jev: string }, fetchFn: Fetch, holdup = false): Promise<ItemAnswer> {
  let a: any;
  try {
    a = await claude(fetchFn, keys.anthropic, model, {
      max_tokens: 300,
      system: [{ type: "text", text: holdup ? SYSTEM + HOLDUP : SYSTEM, cache_control: { type: "ephemeral" } }],
      output_config: { format: { type: "json_schema", schema: ITEM_SCHEMA } },
      messages: [{ role: "user", content: [...crops.map(image), { type: "text", text: `${crops.length} crop(s) of the carried object.` }] }],
    }, 20_000);
  } catch {
    return { message: null, source: "error" };
  }
  const conf = Math.min(1, Math.max(0, Number(a.confidence) || 0));
  const item = { name: String(a.name || "").trim(), material: a.material, form: String(a.form || ""), condition: a.condition, confidence: conf,
    catalog_item_id: CATALOG_IDS.includes(a.catalog_item_id) || PRODUCTS.has(a.catalog_item_id) ? a.catalog_item_id : null };
  const product = item.catalog_item_id ? PRODUCTS.get(item.catalog_item_id) : undefined;
  if (!a.identifiable || !item.name) return { message: null, source: "nothing_held", item };
  const dangerous = unsureSuggestion({ name: item.name, form: item.form, hazardous: !!a.hazardous }) === false;
  if (dangerous) return { message: fromSuggestion({ name: item.name, form: item.form, hazardous: true }), source: "catalog", item };
  if (conf < NAME_MIN || (holdup && VAGUE.test(item.name))) return { message: defaultTrash(null), source: "unclear", item };
  if (product && product.bin !== "jev" && conf >= CATALOG_PICK_MIN) {
    const rule = productsJson.rules[product.rule as keyof typeof productsJson.rules];
    return { message: product.bin === "none" ? special(item.name, product) : named(item.name, product.bin), source: "catalog", item, rule };
  }
  if (item.catalog_item_id && !product && conf >= CATALOG_PICK_MIN) return { message: named(item.name, binOf(item.catalog_item_id)), source: "catalog", item };
  const kind = catalogKind({ form: item.form, material: item.material, hazardous: false });
  if (kind) return { message: named(item.name, binOf(kind)), source: "catalog", item };
  let s: { choice?: string; confidence?: number } = {};
  try {
    if (keys.jev) s = await jev(fetchFn, keys.jev, { name: item.name, material: item.material, form: item.form, condition: item.condition, hazardous: false });
  } catch {
    s = {};
  }
  const proposed = { name: item.name, form: item.form, hazardous: false, suggested_destination: s.choice ?? null, suggestion_confidence: s.confidence ?? null };
  if (unsureSuggestion(proposed)) {
    // Jev silent or unsure: not sure (trash fallback, marked unclear).
    return { message: defaultTrash(item.name), source: "unclear", item };
  }
  return { message: fromSuggestion(proposed), source: "llm", item };
}

const BIN_WORDS = new Set(["RECYCLE", "RECYCLING", "RECYCLABLES", "WASTE", "TRASH", "LANDFILL", "ORGANICS", "ORGANIC", "COMPOST"]);
const CANONICAL: Record<string, string> = { recycle: "RECYCLING", trash: "TRASH", compost: "ORGANICS" };

/** bins.short_label: the printed word when there is a short one, else the bin's standard name. */
export function shortLabel(label: string, bin: string): string {
  const text = label.split(" - ")[0].split("(")[0].split(",")[0].trim();
  const words = text.replace(/\//g, " ").split(/\s+/);
  if (!text || words.length > 3 || text !== text.toUpperCase() || !words.some((w) => BIN_WORDS.has(w))) return CANONICAL[bin] ?? "UNKNOWN";
  return text;
}

/** The bin openings in one (face-redacted) frame, in that frame's pixels. [] when the model fails or sees none. */
export async function findOpenings(frame: string, w: number, h: number, key: string, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Opening[]> {
  const r = await claude(fetchFn, key, BINS_MODEL, {
    max_tokens: 2000,
    output_config: { format: { type: "json_schema", schema: BINS_SCHEMA } },
    messages: [{ role: "user", content: [image(frame), { type: "text", text: BINS_PROMPT(w, h) }] }],
  }, 60_000);
  return (r.openings as any[])
    .filter((o) => o.x1 > o.x0 && o.y1 > o.y0)
    .map((o) => ({ bin: o.bin, label: shortLabel(String(o.label_text ?? ""), o.bin), box: [o.x0, o.y0, o.x1, o.y1].map(Math.round) as Opening["box"] }));
}
