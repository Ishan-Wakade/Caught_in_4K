import { describe, expect, it } from "vitest";
import { identify } from "./identify";

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
