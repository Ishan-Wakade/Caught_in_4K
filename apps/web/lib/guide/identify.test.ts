import { describe, expect, it } from "vitest";
import { catalogKind, disagree, identify } from "./identify";

type Call = { url: string; body: any };

function fakeFetch(answers: { catalog: object; generic: object; jev?: object; fail?: boolean }, calls: Call[]) {
  return async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (answers.fail) return new Response("down", { status: 500 });
    if (url.includes("deepseek")) {
      const text = body.messages[0].content[0].text as string;
      const ans = text.includes("Describe the object generically") ? answers.generic : answers.catalog;
      return Response.json({ choices: [{ message: { content: JSON.stringify(ans) } }] });
    }
    return Response.json({ answers: { bin: answers.jev } });
  };
}

const KEYS = { deepseek: "ds", jev: "jv" };
const CROP = "data:image/jpeg;base64,AAAA";

describe("identify (DeepSeek, then Jev for items not in the catalog)", () => {
  it("a catalog item is answered from the bin table", async () => {
    const calls: Call[] = [];
    const r = await identify([CROP], KEYS, fakeFetch({ catalog: { catalog_item_id: "item_generic_can", what: "a can", confidence: 0.9 },
      generic: { holding: true, name: "aluminum can", material: "metal", form: "can", condition: "clean", hazardous: false } }, calls) as never);
    expect(r).toEqual({ message: { bin: "recycle", explanation: "aluminum can, placed in recycling" }, source: "catalog" });
    expect(calls.filter((c) => c.url.includes("typesafe"))).toHaveLength(0);
    const ds = calls.find((c) => c.url.includes("deepseek"))!.body;
    expect(ds.thinking).toEqual({ type: "disabled" });
    expect(ds.response_format).toEqual({ type: "json_object" });
  });

  it("an unknown item goes through Jev with the city's rules", async () => {
    const calls: Call[] = [];
    const r = await identify([CROP], KEYS, fakeFetch({ catalog: { catalog_item_id: null, what: "a glove" },
      generic: { holding: true, name: "disposable glove", material: "plastic_film", form: "glove", condition: "clean", hazardous: false },
      jev: { type: "choice", choice: "trash", confidence: 0.83 } }, calls) as never);
    expect(r).toEqual({ message: { bin: "trash", explanation: "disposable glove, placed in trash" }, source: "llm", name: "disposable glove", confidence: 0.83 });
    const jev = calls.find((c) => c.url.includes("typesafe"))!.body;
    expect(Object.keys(jev.questions.bin.criteria)).toEqual(["recycling", "compost", "trash", "special"]);
    expect(JSON.parse(jev.state).local_rules).toContain("City of Cambridge");
  });

  it("a dangerous item is none without asking Jev (it would not change the answer)", async () => {
    const calls: Call[] = [];
    const r = await identify([CROP], KEYS, fakeFetch({ catalog: { catalog_item_id: null, what: "a smartphone" },
      generic: { holding: true, name: "smartphone", material: "mixed", form: "phone", condition: "clean", hazardous: true },
      jev: { type: "choice", choice: "special", confidence: 1 } }, calls) as never);
    expect(r).toMatchObject({ message: { bin: "none" }, source: "llm" });
    expect(calls.some((c) => c.url.includes("typesafe"))).toBe(false);
  });

  it("a description that matches a catalog kind answers from the bin table, without Jev", async () => {
    const calls: Call[] = [];
    const r = await identify([CROP], KEYS, fakeFetch({ catalog: { catalog_item_id: null, what: "an orange snack bag" },
      generic: { holding: true, name: "snack wrapper", material: "plastic_film", form: "wrapper", condition: "unknown", hazardous: false },
      jev: { type: "choice", choice: "special", confidence: 0.57 } }, calls) as never);
    expect(r).toEqual({ message: { bin: "trash", explanation: "snack wrapper, placed in trash" }, source: "catalog" });
    expect(calls.some((c) => c.url.includes("typesafe"))).toBe(false);
  });

  it("an object DeepSeek cannot make out is unclear, not a guess, and Jev is not asked", async () => {
    const calls: Call[] = [];
    const r = await identify([CROP], KEYS, fakeFetch({ catalog: { catalog_item_id: null, what: "blurry, unclear" },
      generic: { holding: true, name: "unknown", material: "unknown", form: "other", condition: "unknown", hazardous: false },
      jev: { type: "choice", choice: "trash", confidence: 0.9 } }, calls) as never);
    expect(r.source).toBe("unclear");
    expect(calls.some((c) => c.url.includes("typesafe"))).toBe(false);
  });

  it("the two DeepSeek answers disagreeing at low confidence is unclear (17 Oct crops)", () => {
    expect(disagree({ name: "product packaging box", form: "box" }, { what: "white paper wrapper or packet", confidence: 0.3 })).toBe(true);
    expect(disagree({ name: "phone", form: "phone" }, { what: "light object with a dark oval hole, possibly a cup lid", confidence: 0.2 })).toBe(true);
    expect(disagree({ name: "snack wrapper", form: "wrapper" }, { what: "Orange snack bag held in hand", confidence: 0.3 })).toBe(false);
    expect(disagree({ name: "phone", form: "phone" }, { what: "a dark rectangular object, possibly a phone", confidence: 0.4 })).toBe(false);
    expect(disagree({ name: "glove", form: "glove" }, { what: "a blue cloth", confidence: 0.9 })).toBe(false); // sure: trusted
  });

  it("catalogKind needs the material where the bin depends on it, and never maps a hazard", () => {
    expect(catalogKind({ form: "bottle", material: "glass" })).toBe("item_generic_glass");
    expect(catalogKind({ form: "bottle", material: "metal" })).toBeNull();
    expect(catalogKind({ form: "bag", material: "plastic_film" })).toBeNull();
    expect(catalogKind({ form: "wrapper", hazardous: true })).toBeNull();
  });

  it("Jev under 50% is the trash fallback, marked default (so the demo can stay silent)", async () => {
    const r = await identify([CROP], KEYS, fakeFetch({ catalog: { catalog_item_id: null, what: "a glove" },
      generic: { holding: true, name: "disposable glove", material: "plastic_film", form: "glove", condition: "clean", hazardous: false },
      jev: { type: "choice", choice: "compost", confidence: 0.3 } }, []) as never);
    expect(r).toEqual({ message: { bin: "trash", explanation: "disposable glove, placed in trash" }, source: "default" });
  });

  it("nothing in the hand: no message", async () => {
    const r = await identify([CROP], KEYS, fakeFetch({ catalog: { catalog_item_id: null, what: "an empty hand" },
      generic: { holding: false, name: "", material: "unknown", form: "", condition: "unknown", hazardous: false } }, []) as never);
    expect(r).toEqual({ message: null, source: "nothing_held" });
  });

  it("a provider failure answers trash instead of failing the request", async () => {
    const r = await identify([CROP], KEYS, fakeFetch({ catalog: {}, generic: {}, fail: true }, []) as never);
    expect(r).toEqual({ message: { bin: "trash", explanation: "not sure what this is, placed in trash" }, source: "default" });
  });
});
