import type { Messenger, OutboundMessage, SendResult } from "../types.js";
import { getPhotonProvider } from "./photonApp.js";

// Real adapter, built against spectrum-ts's actual d.ts (there is no plain
// REST "send a message" endpoint — see packages/integrations/AGENTS.md).
// space.create() both resolves an existing conversation and creates a new
// one from a participant, so a fresh space is requested on every send
// rather than caching one — cheap and correct for 1:1 manager contacts.
export class PhotonMessenger implements Messenger {
  async send(msg: OutboundMessage): Promise<SendResult> {
    const platformUserId = msg.to.phone ?? msg.to.handle;
    if (!platformUserId) {
      throw new Error(`OutboundMessage.to (contactId=${msg.to.contactId}) has neither phone nor handle set.`);
    }

    const provider = await getPhotonProvider();
    const space = await provider.space.create(platformUserId);
    const sent = await space.send(msg.body);
    if (!sent) {
      throw new Error(`space.send returned no message for contactId=${msg.to.contactId} (kind=${msg.kind}).`);
    }

    return {
      providerMessageId: sent.id,
      sentAt: sent.timestamp.toISOString(),
      mocked: false,
    };
  }
}
