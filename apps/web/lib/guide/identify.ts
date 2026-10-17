/**
 * Server side of the voice guide: what is the person holding, and which bin? Same flow as the worker
 * (worker/recyclone_worker/namer.py + generic.py): two DeepSeek calls in parallel on the item crops (catalog pick,
 * and a generic description incl. "is anything held"), then Jev under the city's rules for items not in the catalog.
 * Crops arrive already face-redacted by the phone. Keys stay on the server. Any provider failure -> trash.
 */
import siteJson from "../../../../contracts/fixtures/demo-site.json";
import { CATALOG_IDS, defaultTrash, fromCatalog, fromSuggestion, type GuideMessage } from "./message";
import { LOCAL_RULES, RULES_SOURCE } from "./rules";

export type Keys = { deepseek: string; jev: string };
export type Result = { message: GuideMessage | null; source: "catalog" | "llm" | "default" | "nothing_held" };
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
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
- holding: true only if the person is clearly holding an object (not just an empty hand, a sleeve, or a phone they keep using)
- name: short generic name including its use ("disposable face mask", "paper takeout box", "paper coffee cup")
- material: one of plastic_film, rigid_plastic, paper, cardboard, metal, glass, organic, textile, foam, mixed, unknown
- form: one word for its shape or use ("cup", "bag", "mask", "wrapper", "box", "napkin", "bottle", "glove", "battery")
- condition: one of clean, food_residue, liquid, unknown (only what you can see)
- hazardous: true only for batteries, electronics, chemicals, needles, or items labeled hazardous
Answer JSON only: {"holding": true, "name": "...", "material": "...", "form": "...", "condition": "...", "hazardous": false}`;

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

async function deepseek(fetchFn: Fetch, key: string, prompt: string, crops: string[]): Promise<any> {
  const r = await post(fetchFn, DEEPSEEK_URL, key, {
    model: "deepseek-flash", temperature: 0, max_tokens: 800, response_format: { type: "json_object" },
    thinking: { type: "disabled" },
    messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...crops.map((url) => ({ type: "image_url", image_url: { url } }))] }],
  });
  return JSON.parse(r.choices[0].message.content);
}

async function jev(fetchFn: Fetch, key: string, item: object): Promise<{ choice: string; confidence: number }> {
  const r = await post(fetchFn, JEV_URL, key, {
    model: "jev-latest",
    state: JSON.stringify({ item, local_rules: LOCAL_RULES }),
    questions: { bin: { type: "choice", instructions: "Under the local rules given in the state, where should this item be disposed of?", criteria: DESTINATIONS } },
  });
  return r.answers.bin;
}

export async function identify(crops: string[], keys: Keys, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Result> {
  try {
    const [cat, gen] = await Promise.all([
      deepseek(fetchFn, keys.deepseek, CATALOG_PROMPT(crops.length), crops),
      deepseek(fetchFn, keys.deepseek, GENERIC_PROMPT(crops.length), crops),
    ]);
    if (gen && gen.holding === false) return { message: null, source: "nothing_held" };
    if (cat && typeof cat.catalog_item_id === "string" && CATALOG_IDS.includes(cat.catalog_item_id)) {
      return { message: fromCatalog(cat.catalog_item_id), source: "catalog" };
    }
    const item = { name: gen?.name || cat?.what || "", material: gen?.material ?? "unknown", form: gen?.form ?? "",
      condition: gen?.condition ?? "unknown", hazardous: !!gen?.hazardous, description: cat?.what ?? "" };
    if (!item.name) return { message: defaultTrash(null), source: "default" };
    let suggestion: { choice?: string; confidence?: number } = {};
    try {
      suggestion = await jev(fetchFn, keys.jev, item);
    } catch {
      suggestion = {}; // no suggestion -> from_suggestion says trash (unless dangerous)
    }
    return {
      message: fromSuggestion({ name: item.name, form: item.form, hazardous: item.hazardous,
        suggested_destination: suggestion.choice ?? null, suggestion_confidence: suggestion.confidence ?? null }),
      source: "llm",
    };
  } catch {
    return { message: defaultTrash(null), source: "default" };
  }
}

export { RULES_SOURCE };
