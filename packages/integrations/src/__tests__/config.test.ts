import { describe, expect, it } from "vitest";
import { createIllustrator, getActiveModes } from "../config.js";
import { MockIllustrator } from "../illustrator/mock.js";

describe("config", () => {
  it("defaults to mock illustrator when no mode is set", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(createIllustrator(env)).toBeInstanceOf(MockIllustrator);
    expect(getActiveModes(env)).toEqual({ illustrator: "mock" });
  });

  it("refuses to construct a live illustrator without credentials", () => {
    const env = { ILLUSTRATOR_MODE: "live" } as NodeJS.ProcessEnv;
    expect(() => createIllustrator(env)).toThrow(/GROK_API_KEY/);
  });
});
