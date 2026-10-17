import type { Illustrator } from "@recyclone/contracts";
import { MockIllustrator } from "./illustrator/mock.js";
import { GrokIllustrator } from "./illustrator/grok.js";

export type IllustratorMode = "mock" | "live";

function readMode(value: string | undefined, fallback: "mock" | "live"): "mock" | "live" {
  if (value === "mock" || value === "live") return value;
  return fallback;
}

export function createIllustrator(env: NodeJS.ProcessEnv = process.env): Illustrator {
  const mode = readMode(env.ILLUSTRATOR_MODE, "mock");
  if (mode === "mock") return new MockIllustrator();
  const apiKey = env.GROK_API_KEY;
  if (!apiKey) {
    throw new Error("ILLUSTRATOR_MODE=live requires GROK_API_KEY to be set.");
  }
  return new GrokIllustrator({ apiKey });
}

export function getActiveModes(env: NodeJS.ProcessEnv = process.env): { illustrator: IllustratorMode } {
  return {
    illustrator: readMode(env.ILLUSTRATOR_MODE, "mock"),
  };
}
