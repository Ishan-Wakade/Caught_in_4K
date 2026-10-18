import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BELIEFS, BREAKDOWNS, NUMBERS, QUIZ, SOURCES, sourceNumber, spoken } from "./impact";

describe("why-it-matters figures", () => {
  it("numbers each source once, from 1", () => {
    expect(new Set(SOURCES.map((s) => s.id)).size).toBe(SOURCES.length);
    expect(sourceNumber(SOURCES[0].id)).toBe(1);
    for (const s of SOURCES) expect(s.url).toMatch(/^https:\/\//);
  });

  it("cites a listed source for every figure", () => {
    const ids = new Set<string>(SOURCES.map((s) => s.id));
    for (const x of [...NUMBERS, ...BELIEFS, ...BREAKDOWNS]) expect(ids).toContain(x.source);
  });

  it("lists only sources the page cites", () => {
    const page = readFileSync(new URL("../app/(site)/impact/page.tsx", import.meta.url), "utf8");
    const cited = new Set<string>([...NUMBERS, ...BELIEFS, ...BREAKDOWNS].map((x) => x.source));
    for (const s of SOURCES) expect(cited.has(s.id) || page.includes(`"${s.id}"`), s.id).toBe(true);
  });

  it("adds each breakdown up to its published total", () => {
    const sum = (id: string) => BREAKDOWNS.find((b) => b.id === id)!.slices.reduce((n, s) => n + s.value, 0);
    expect(sum("us")).toBeCloseTo(292.4, 0); // EPA 2018, million tons (published parts round to 292.3)
    expect(sum("plastic")).toBe(100);
  });

  it("phrases quiz answers like the voice guide: item <= 6 words, reason <= 14", () => {
    for (const q of QUIZ) {
      expect(q.item.split(" ").length).toBeLessThanOrEqual(6);
      expect(q.reason.split(" ").length).toBeLessThanOrEqual(14);
    }
    expect(spoken(QUIZ.find((q) => q.item === "Chicken bones")!)).toBe(
      "Compost. Chicken bones should be placed in compost because Cambridge compost takes all food scraps, even meat and bones.",
    );
  });
});
