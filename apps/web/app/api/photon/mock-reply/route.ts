import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { handleInboundReply } from "../_shared";
import { getActiveModes } from "@recyclone/integrations";

// Demo-only: lets the presenter type a manager reply instead of a real
// Photon message arriving. Enters the exact same path as the real webhook
// (contract §6). J's Messages scene shows the input box this calls only
// while the messenger is mocked; this route enforces that server-side too.
export async function POST(request: NextRequest) {
  if (getActiveModes().messenger !== "mock") {
    return NextResponse.json({ error: "mock-reply is only available while MESSENGER_MODE=mock" }, { status: 403 });
  }

  const body = await request.json();
  const contactId = String(body?.contactId ?? "");
  const text = String(body?.body ?? "");
  if (!contactId || !text) {
    return NextResponse.json({ error: "contactId and body are required" }, { status: 400 });
  }

  const result = await handleInboundReply({
    providerMessageId: `mock_reply_${crypto.randomUUID()}`,
    from: { contactId },
    body: text,
    receivedAt: new Date().toISOString(),
  });
  return NextResponse.json(result);
}
