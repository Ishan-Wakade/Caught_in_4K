import type { ReplySink } from "@recyclone/contracts";
import { getCoreReplySink } from "../_core/reply-sink";

// Core owns durable deduplication, manager-contact resolution and state changes.
export function getReplySink(): ReplySink {
  return getCoreReplySink();
}
