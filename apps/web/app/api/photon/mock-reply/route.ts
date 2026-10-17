import { randomUUID } from "node:crypto";
import { CoreError } from "@recyclone/core";
import { handleInboundReply } from "../_shared";
import { integrationMode } from "../../_core/adapters";
import { body, requireManager, respond } from "../../_core/http";
export const runtime = "nodejs";

// Uses the same reply sink as the verified provider webhook. Native Request /
// Response are supported by Next.js and make this handler independently testable.
export async function POST(request: Request) {
  return respond(async () => {
    if (integrationMode(process.env.MESSENGER_MODE, "MESSENGER_MODE") !== "mock") throw new CoreError(403, "mock-reply is only available while MESSENGER_MODE=mock");
    if (process.env.ENABLE_MOCK_REPLY !== "true") throw new CoreError(403, "mock-reply is disabled; set ENABLE_MOCK_REPLY=true to enable it");
    requireManager(request);
    const input = await body(request);
    if (!input || typeof input !== "object" || !("contactId" in input) || !("body" in input) || typeof input.contactId !== "string" || !input.contactId.trim() || typeof input.body !== "string" || !input.body.trim()) throw new CoreError(400, "contactId and body must be nonempty strings");
    return handleInboundReply({ providerMessageId: `mock_reply_${randomUUID()}`, from: { contactId: input.contactId }, body: input.body, receivedAt: new Date().toISOString() });
  });
}
