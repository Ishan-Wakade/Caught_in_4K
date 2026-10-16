import { describe, expect, it } from "vitest";
import { createIllustrator, createMessenger, getActiveModes } from "../config.js";
import { MockMessenger } from "../messenger/mock.js";
import { MockIllustrator } from "../illustrator/mock.js";

describe("config", () => {
  it("defaults to mock adapters when no mode is set", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(createMessenger(env)).toBeInstanceOf(MockMessenger);
    expect(createIllustrator(env)).toBeInstanceOf(MockIllustrator);
    expect(getActiveModes(env)).toEqual({ messenger: "mock", illustrator: "mock" });
  });

  it("refuses to construct a live messenger without credentials", () => {
    const env = { MESSENGER_MODE: "live" } as NodeJS.ProcessEnv;
    expect(() => createMessenger(env)).toThrow(/PHOTON_PROJECT_ID/);
  });

  it("refuses to construct a live illustrator without credentials", () => {
    const env = { ILLUSTRATOR_MODE: "live" } as NodeJS.ProcessEnv;
    expect(() => createIllustrator(env)).toThrow(/GROK_API_KEY/);
  });

  it("reports live mode once top-level credentials are present (channel-specific vars are checked lazily on send)", () => {
    const env = {
      MESSENGER_MODE: "live",
      PHOTON_PROJECT_ID: "proj_1",
      PHOTON_PROJECT_SECRET: "secret",
      PHOTON_CHANNEL: "imessage",
    } as NodeJS.ProcessEnv;
    expect(createMessenger(env)).toBeDefined();
    expect(getActiveModes(env).messenger).toBe("live");
  });
});
