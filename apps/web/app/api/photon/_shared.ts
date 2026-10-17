// Both provider-verified webhooks and the server-enforced mock route use this path.
import type { InboundReply, ReplySink } from "@recyclone/contracts";
import type { Message } from "@recyclone/integrations";
import { getReplySink } from "./_replySink";

function extractReplyText(content: Message["content"]): string {
  if (content.type === "text") return content.text;
  if (content.type === "markdown") return content.markdown;
  return "";
}

// Called after the Photon SDK verifies and deserializes a provider message.
// The sink resolves sender.id against configured manager phone/handle/aliases.
export function toInboundReply(message: Message): InboundReply {
  return {
    providerMessageId: message.id,
    from: { contactId: message.sender?.id ?? "unknown" },
    body: extractReplyText(message.content),
    receivedAt: message.timestamp.toISOString(),
  };
}

export type HandleInboundReplyResult = Awaited<ReturnType<ReplySink["handleReply"]>>;

export async function handleInboundReply(reply: InboundReply): Promise<HandleInboundReplyResult> {
  // Do not mark seen before core accepts a reply: configuration failures must
  // remain retryable. Core persists provider-ID deduplication across instances.
  return getReplySink().handleReply(reply);
}
