// Shared by webhook/route.ts and mock-reply/route.ts so both enter the exact
// same path (contract §5/§6). Not itself a route — Next's App Router only
// treats files named route.ts as endpoints.
import {
  InMemoryReplyDedupeStore,
  type InboundReply,
  type Message,
  type ReplyDedupeStore,
  type ReplySink,
} from "@recyclone/integrations";
import { getReplySink } from "./_replySink";

// Module-level singleton: Next.js keeps one Node process per server instance
// in dev/this demo, so this survives across requests. Swap for a persistent
// store before relying on it across multiple instances or restarts.
const dedupeStore: ReplyDedupeStore = new InMemoryReplyDedupeStore();

/**
 * Pulls plain reply text out of a Spectrum Message's content. Managers are
 * expected to reply with ordinary text/markdown; any other content type
 * (attachment, reaction, poll, …) has no text to interpret and comes back
 * as "", which RuleBasedReplyInterpreter correctly reads as "unclear".
 */
function extractReplyText(content: Message["content"]): string {
  if (content.type === "text") return content.text;
  if (content.type === "markdown") return content.markdown;
  return "";
}

/** Builds the InboundReply contract §5 shape from a real Spectrum inbound message. */
export function toInboundReply(message: Message): InboundReply {
  return {
    providerMessageId: message.id,
    from: { contactId: message.sender?.id ?? "unknown" },
    body: extractReplyText(message.content),
    receivedAt: message.timestamp.toISOString(),
  };
}

export type HandleInboundReplyResult = { status: "applied" | "duplicate" | "needs_clarification" };

/** Entry point shared by the real webhook and the mock-reply route. */
export async function handleInboundReply(reply: InboundReply): Promise<HandleInboundReplyResult> {
  const isNew = await dedupeStore.markSeen(reply.providerMessageId);
  if (!isNew) {
    return { status: "duplicate" };
  }

  const replySink: ReplySink = getReplySink();
  return replySink.handleReply(reply);
}
