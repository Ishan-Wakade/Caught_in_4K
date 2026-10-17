import { createIllustrator } from "@recyclone/integrations";
import type { Illustrator } from "@recyclone/contracts";

export type IntegrationAdapters = {
  illustrator: Illustrator;
};
export type IntegrationMode = "mock" | "live";
export function integrationMode(value: string | undefined, name: string): IntegrationMode {
  if (value === undefined || value === "mock") return "mock";
  if (value === "live") return "live";
  throw new Error(`${name} must be mock or live`);
}
/** Compose S's public factories within each server instance, before core starts. */
export function createIntegrationAdapters(env: NodeJS.ProcessEnv = process.env): IntegrationAdapters {
  integrationMode(env.ILLUSTRATOR_MODE, "ILLUSTRATOR_MODE");
  return {
    illustrator: createIllustrator(env),
  };
}
