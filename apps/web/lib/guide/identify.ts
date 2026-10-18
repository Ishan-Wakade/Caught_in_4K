/**
 * Server side of the voice guide: what is the person holding, and which bin? Same flow as the worker
 * (worker/recyclone_worker/namer.py + generic.py): two DeepSeek calls in parallel on the item crops (catalog pick,
 * and a generic description incl. "is anything held"), then Jev under the city's rules for items not in the catalog.
 * Crops arrive already face-redacted by the phone. Keys stay on the server. Any provider failure -> trash.
 */
import siteJson from "../../../../contracts/fixtures/demo-site.json";
import { CATALOG_IDS, defaultTrash, fromCatalog, fromSuggestion, unsureSuggestion, type GuideMessage } from "./message";
import { LOCAL_RULES, RULES_SOURCE } from "./rules";

export type Keys = { anthropic: string; jev: string };
/**
 * source "unclear": DeepSeek could not see what it is (blurry, or covered by the face blackout): worth another look.
 * `name`/`confidence` are only set for source "llm" — what it was, and how sure Jev's destination suggestion was; the
 * dashboard logs it as a new-item sighting.
 */
export type Result = {
  message: GuideMessage | null;
  source: "catalog" | "llm" | "default" | "unclear" | "nothing_held";
  name?: string;
  confidence?: number | null;
};
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

/** The vision model: Claude Sonnet 5.5 in place of DeepSeek (18 Oct, team decision); same two prompts, same flow. */
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const CLAUDE_MODEL = "claude-sonnet-5-5";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const TIMEOUT_MS = 8000;

const CATALOG = (siteJson as { catalog: Array<{ catalog_item_id: string; name?: string }> }).catalog
  .filter((i) => CATALOG_IDS.includes(i.catalog_item_id))
  .map((i) => `${i.catalog_item_id}: ${i.name ?? i.catalog_item_id}`)
  .join("\n");

const CATALOG_PROMPT = (n: number) => `These ${n} images are crops of ONE object a person is carrying to a waste bin (the same object seen at different moments; a hand may be in the crop).
Choose a catalog item only if the object clearly IS that item; if it is something else, or you cannot tell, answer null and describe it in "what". Do not name a brand unless its logo or text is clearly visible.
Catalog (id: description):
${CATALOG}
Answer JSON only: {"catalog_item_id": id or null, "what": "short description of the object", "material": "main material", "brand_visible": "brand or null", "confidence": 0.0-1.0}`;

const GENERIC_PROMPT = (n: number) => `These ${n} images are crops around the hand of ONE person walking to a waste bin (faces are blacked out).
Describe the object generically, for deciding which waste bin it belongs in:
- holding: true if the person is holding any object in their hand (not just an empty hand or a sleeve)
- name: short generic name including its use; if you cannot see the object clearly enough to tell what it is, "unknown" (do not guess)
- material: one of plastic_film, rigid_plastic, paper, cardboard, metal, glass, organic, textile, foam, mixed, unknown
- form: one word for its shape or use: cup, bag, wrapper, box, napkin, bottle, can, container, utensil, food, glove, battery, phone, or other
- condition: one of clean, food_residue, liquid, unknown (only what you can see)
- hazardous: true only for batteries, electronics, chemicals, needles, or items labeled hazardous
Answer JSON only: {"holding": true, "name": "...", "material": "...", "form": "...", "condition": "...", "hazardous": false}`;

/**
 * DeepSeek's generic description -> the catalog's generic kind, whose bin the local rules already decide (bins.json), so
 * Jev is only asked about items the catalog does not cover (17 Oct: Jev called snack wrappers "special" at 57%).
 * By form, then material where the bin depends on it. Bags and boxes are left to Jev (a grocery bag or a clean shipping
 * box is not a chip bag or a takeout box).
 */
const KIND_BY_FORM: Record<string, string | Record<string, string>> = {
  wrapper: "item_generic_wrapper",
  napkin: "item_napkin",
  food: "item_generic_food",
  can: { metal: "item_generic_can" },
  bottle: { rigid_plastic: "item_generic_bottle", glass: "item_generic_glass" },
  cup: { rigid_plastic: "item_generic_cup", paper: "item_generic_paper_cup" },
  container: { rigid_plastic: "item_generic_container" },
  utensil: { rigid_plastic: "item_generic_utensil" },
};

/**
 * The two DeepSeek calls see the same crops; when the unsure one (catalog confidence < 0.5) describes something else
 * than the generic one names, neither is trusted (17 Oct: "paper wrapper or packet" vs "packaging box" -> recycling;
 * "cup lid" vs "phone" -> none). Agreeing = the generic form or a word of its name appears in the other description.
 */
export function disagree(gen: { name?: string; form?: string } | null, cat: { what?: string; confidence?: number } | null): boolean {
  const what = (cat?.what ?? "").toLowerCase();
  if (!what || (cat?.confidence ?? 1) >= 0.5) return false;
  const words = [gen?.form ?? "", ...(gen?.name ?? "").toLowerCase().split(/\W+/)].filter((w) => w.length >= 3);
  return !words.some((w) => what.includes(w.toLowerCase()));
}

export function catalogKind(item: { form?: string; material?: string; hazardous?: boolean }): string | null {
  if (item.hazardous) return null;
  const m = KIND_BY_FORM[(item.form ?? "").toLowerCase()];
  const id = typeof m === "string" ? m : m?.[(item.material ?? "").toLowerCase()];
  return id && CATALOG_IDS.includes(id) ? id : null;
}

const DESTINATIONS = {
  recycling: "Curbside recycling cart",
  compost: "Curbside compost (food scraps and the paper items the rules accept)",
  trash: "Trash (not recyclable, not compostable, not a special item)",
  special: "Not curbside: drop-off, Recycle Center, textile donation, or hazardous waste event",
};

async function post(fetchFn: Fetch, url: string, key: string, body: object): Promise<any> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
  return res.json();
}

/** The JSON shape each prompt asks for (DeepSeek's response_format json_object, as Claude's structured output). */
const CATALOG_SCHEMA = {
  type: "object", additionalProperties: false, required: ["catalog_item_id", "what", "material", "brand_visible", "confidence"],
  properties: { catalog_item_id: { anyOf: [{ type: "string" }, { type: "null" }] }, what: { type: "string" }, material: { type: "string" },
    brand_visible: { anyOf: [{ type: "string" }, { type: "null" }] }, confidence: { type: "number" } },
};
const GENERIC_SCHEMA = {
  type: "object", additionalProperties: false, required: ["holding", "name", "material", "form", "condition", "hazardous"],
  properties: { holding: { type: "boolean" }, name: { type: "string" }, material: { type: "string" }, form: { type: "string" },
    condition: { type: "string" }, hazardous: { type: "boolean" } },
};

/** One Claude call with one of the two prompts (unchanged) and the item crops; returns the parsed JSON answer. */
async function claude(fetchFn: Fetch, key: string, prompt: string, schema: object, crops: string[]): Promise<any> {
  const res = await fetchFn(CLAUDE_URL, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: CLAUDE_MODEL, max_tokens: 800,
      thinking: { type: "between_tools" },  // Sonnet 5.5's "no thinking" (it rejects "disabled")
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: [{ type: "text", text: prompt },
        ...crops.map((url) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: url.split(",")[1] } }))] }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${CLAUDE_URL} HTTP ${res.status}`);
  const r = await res.json();
  return JSON.parse(r.content.find((b: { type: string }) => b.type === "text").text);
}

async function jev(fetchFn: Fetch, key: string, item: object): Promise<{ choice: string; confidence: number }> {
  const r = await post(fetchFn, JEV_URL, key, {
    model: "jev-latest",
    state: JSON.stringify({ item, local_rules: LOCAL_RULES }),
    questions: { bin: { type: "choice", instructions: "Under the local rules given in the state, where should this item be disposed of?", criteria: DESTINATIONS } },
  });
  return r.answers.bin;
}

/** trace: each provider answer as it arrives (the server's GUIDE_DEBUG_DIR log); never sent to the browser. */
export async function identify(crops: string[], keys: Keys, fetchFn: Fetch = fetch as unknown as Fetch,
  trace: (step: object) => void = () => {}): Promise<Result> {
  try {
    const [cat, gen] = await Promise.all([
      claude(fetchFn, keys.anthropic, CATALOG_PROMPT(crops.length), CATALOG_SCHEMA, crops),
      claude(fetchFn, keys.anthropic, GENERIC_PROMPT(crops.length), GENERIC_SCHEMA, crops),
    ]);
    trace({ claude_catalog: cat, claude_generic: gen });
    if (gen && gen.holding === false) return { message: null, source: "nothing_held" };
    if (cat && typeof cat.catalog_item_id === "string" && CATALOG_IDS.includes(cat.catalog_item_id)) {
      return { message: fromCatalog(cat.catalog_item_id), source: "catalog" };
    }
    const item = { name: gen?.name || cat?.what || "", material: gen?.material ?? "unknown", form: gen?.form ?? "",
      condition: gen?.condition ?? "unknown", hazardous: !!gen?.hazardous, description: cat?.what ?? "" };
    if (!item.name || /^unknown\b/i.test(item.name.trim())) return { message: defaultTrash(null), source: "unclear" };
    if (disagree(gen, cat)) return { message: defaultTrash(null), source: "unclear" };
    const kind = catalogKind(item);
    if (kind) return { message: fromCatalog(kind), source: "catalog" };
    let suggestion: { choice?: string; confidence?: number } = {};
    // Dangerous items are "none" whatever Jev says (fromSuggestion): skip the call, it only added time.
    const dangerous = unsureSuggestion({ name: item.name, form: item.form, hazardous: item.hazardous }) === false;
    try {
      if (!dangerous) suggestion = await jev(fetchFn, keys.jev, item);
      trace({ jev: suggestion });
    } catch (e) {
      trace({ jev_error: String(e) });
      suggestion = {}; // no suggestion -> from_suggestion says trash (unless dangerous)
    }
    const proposed = { name: item.name, form: item.form, hazardous: item.hazardous,
      suggested_destination: suggestion.choice ?? null, suggestion_confidence: suggestion.confidence ?? null };
    // Jev unsure (< 50%) or silent: the trash fallback, marked "default" so the camera page can treat it as unsure (and
    // not logged as a sighting: its "trash" is the fallback, not Jev's suggestion).
    if (unsureSuggestion(proposed)) return { message: fromSuggestion(proposed), source: "default" };
    return { message: fromSuggestion(proposed), source: "llm", name: item.name, confidence: suggestion.confidence ?? null };
  } catch (e) {
    trace({ error: String(e) });
    return { message: defaultTrash(null), source: "default" };
  }
}

export { RULES_SOURCE };
