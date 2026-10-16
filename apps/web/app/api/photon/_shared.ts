// Shared by webhook/route.ts and mock-reply/route.ts so both enter the exact
// same path (contract §5/§6). Not itself a route — Next's App Router only
// treats files named route.ts as endpoints.
import crypto from "node:crypto";
import {
  InMemoryReplyDedupeStore,
  type InboundReply,
  type ReplyDedupeStore,
  type ReplySink,
} from "@recyclone/integrations";
import { getReplySink } from "./_replySink";

// Module-level singleton: Next.js keeps one Node process per server instance
// in dev/this demo, so this survives across requests. Swap for a persistent
// store before relying on it across multiple instances or restarts.
const dedupeStore: ReplyDedupeStore = new InMemoryReplyDedupeStore();

export function verifyPhotonSignature(_rawBody: string, _signatureHeader: string | null): boolean {
  // Photon's signature scheme is unconfirmed — no docs reviewed yet (see
  // packages/integrations/AGENTS.md "Open questions"). Until PHOTON_WEBHOOK_SECRET
  // and the real scheme are confirmed, verification is a no-op that always
  // passes; flip this once the real scheme is known, rather than silently
  // trusting unverified webhooks in production.
  if (!process.env.PHOTON_WEBHOOK_SECRET) return true;
  // TODO once Photon docs are reviewed, replace with the real HMAC/signature check, e.g.:
  // const expected = crypto.createHmac("sha256", process.env.PHOTON_WEBHOOK_SECRET).update(_rawBody).digest("hex");
  // return _signatureHeader === expected;
  return true;
}

/**
 * Best-guess normalization of Photon's inbound webhook payload. The real
 * field names are unconfirmed; adjust this mapping once Photon's webhook
 * reference is checked (see packages/integrations/AGENTS.md).
 */
export function normalizePhotonWebhookPayload(body: unknown): InboundReply {
  const b = body as Record<string, unknown>;
  const messageId = String(b.message_id ?? b.id ?? crypto.randomUUID());
  const contactId = String(
    (b.from as Record<string, unknown> | undefined)?.contact_id ?? b.contact_id ?? b.from ?? "unknown",
  );
  const text = String(b.text ?? b.body ?? "");
  const receivedAt = String(b.received_at ?? b.timestamp ?? new Date().toISOString());

  return {
    providerMessageId: messageId,
    from: { contactId, phone: (b.from as Record<string, unknown> | undefined)?.phone as string | undefined },
    body: text,
    receivedAt,
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
