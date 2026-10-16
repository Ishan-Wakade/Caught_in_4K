import { after, NextRequest } from "next/server";
import { getActiveModes, getPhotonApp, type Message, type Space } from "@recyclone/integrations";
import { handleInboundReply, toInboundReply } from "../_shared";

// Inbound replies from Photon 2.0 (contract §2, §6). Delegates verification
// and parsing entirely to spectrum-ts's app.webhook(), which auto-detects
// the native Spectrum webhook vs. a fusor envelope, checks the
// X-Spectrum-Signature HMAC against PHOTON_WEBHOOK_SECRET, and invokes our
// handler with an already-deserialized [space, message].
export async function POST(request: NextRequest) {
  if (getActiveModes().messenger !== "live") {
    return new Response("Photon webhook is only active while MESSENGER_MODE=live", { status: 404 });
  }

  const app = await getPhotonApp();

  // app.webhook()'s handler runs fire-and-forget after the Response below is
  // computed — on Vercel the function can freeze right after the response is
  // sent, so `after()` is what actually keeps handleInboundReply's work
  // (dedupe + core's ReplySink) alive. Requires Next's `after()` API
  // (stable Next 15+); confirm the apps/web Next version once it's scaffolded.
  return app.webhook(request, (_space: Space, message: Message) => {
    after(handleInboundReply(toInboundReply(message)));
  });
}
