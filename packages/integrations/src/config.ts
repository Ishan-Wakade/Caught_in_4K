import type { Illustrator, Messenger, ReplyInterpreter } from "@recyclone/contracts";
import { MockMessenger } from "./messenger/mock.js";
import { PhotonMessenger } from "./messenger/photon.js";
import { MockIllustrator } from "./illustrator/mock.js";
import { GrokIllustrator } from "./illustrator/grok.js";
import { RuleBasedReplyInterpreter } from "./interpreter/replyInterpreter.js";

export type MessengerMode = "mock" | "live";
export type IllustratorMode = "mock" | "live";

function readMode(value: string | undefined, fallback: "mock" | "live"): "mock" | "live" {
  if (value === "mock" || value === "live") return value;
  return fallback;
}

export function createMessenger(env: NodeJS.ProcessEnv = process.env): Messenger {
  const mode = readMode(env.MESSENGER_MODE, "mock");
  if (mode === "mock") return new MockMessenger();
  if (!env.SPECTRUM_PROJECT_ID || !env.SPECTRUM_PROJECT_SECRET || !env.PHOTON_CHANNEL) {
    throw new Error("MESSENGER_MODE=live requires SPECTRUM_PROJECT_ID, SPECTRUM_PROJECT_SECRET, and PHOTON_CHANNEL to be set.");
  }
  // PhotonMessenger reads env itself (via getPhotonProvider) when send() is
  // first called; channel-specific vars (e.g. WHATSAPP_ACCESS_TOKEN) are
  // validated lazily there rather than duplicated here.
  return new PhotonMessenger();
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

export function createReplyInterpreter(): ReplyInterpreter {
  return new RuleBasedReplyInterpreter();
}

export function getActiveModes(env: NodeJS.ProcessEnv = process.env): { messenger: MessengerMode; illustrator: IllustratorMode } {
  return {
    messenger: readMode(env.MESSENGER_MODE, "mock"),
    illustrator: readMode(env.ILLUSTRATOR_MODE, "mock"),
  };
}
