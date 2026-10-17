import {
  createMessenger, createIllustrator, createReplyInterpreter,
} from "@recyclone/integrations";
import type { Messenger, Illustrator, ReplyInterpreter } from "@recyclone/contracts";

export type IntegrationAdapters = {
  messenger: Messenger;
  illustrator: Illustrator;
  interpreter: ReplyInterpreter;
};
export type IntegrationMode = "mock" | "live";
export function integrationMode(value: string | undefined, name: string): IntegrationMode {
  if (value === undefined || value === "mock") return "mock";
  if (value === "live") return "live";
  throw new Error(`${name} must be mock or live`);
}
/** Compose S's public factories within each server instance, before core starts. */
export function createIntegrationAdapters(env: NodeJS.ProcessEnv = process.env): IntegrationAdapters {
  integrationMode(env.MESSENGER_MODE, "MESSENGER_MODE");
  integrationMode(env.ILLUSTRATOR_MODE, "ILLUSTRATOR_MODE");
  return {
    messenger: createMessenger(env),
    illustrator: createIllustrator(env),
    interpreter: createReplyInterpreter(),
  };
}
