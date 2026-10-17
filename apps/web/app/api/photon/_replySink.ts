import type { ReplySink } from "@recyclone/integrations";
import { getCore } from "../_core/runtime";

export function getReplySink(): ReplySink {
  return { handleReply: async (reply) => (await getCore()).handleReply(reply) };
}
