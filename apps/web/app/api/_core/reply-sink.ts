import type { InboundReply, ReplySink } from "@recyclone/contracts";
import { CoreError } from "@recyclone/core";
import { getCore } from "./runtime.js";
import { integrationMode } from "./adapters.js";

export function photonContactMap(value = process.env.PHOTON_CONTACT_MAP): Record<string, string> {
  if (!value) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new CoreError(503, "PHOTON_CONTACT_MAP must be a JSON object"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some(v => typeof v !== "string" || v.length === 0)) throw new CoreError(503, "PHOTON_CONTACT_MAP must map sender IDs to contact IDs");
  return parsed as Record<string, string>;
}
/** Reusable sink for S's verified webhook and server-enforced mock route. */
export function getCoreReplySink(): ReplySink {
  return {
    async handleReply(reply: InboundReply) {
      const mode = integrationMode(process.env.MESSENGER_MODE, "MESSENGER_MODE");
      return (await getCore()).handleProviderReply(reply, { allowContactIds: mode === "mock", aliases: photonContactMap() });
    },
  };
}
