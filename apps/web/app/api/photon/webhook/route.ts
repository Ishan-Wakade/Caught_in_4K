import { NextRequest, NextResponse } from "next/server";
import { handleInboundReply, normalizePhotonWebhookPayload, verifyPhotonSignature } from "../_shared";

// Inbound replies from Photon 2.0 (contract §2, §6).
export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  if (!verifyPhotonSignature(rawBody, request.headers.get("x-photon-signature"))) {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  const reply = normalizePhotonWebhookPayload(parsed);
  const result = await handleInboundReply(reply);
  return NextResponse.json(result);
}
