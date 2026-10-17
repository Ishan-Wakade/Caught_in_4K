import type { Messenger } from "@recyclone/contracts";
import { getPhotonProvider } from "./photonApp.js";

type OutboundMessage = Parameters<Messenger["send"]>[0];
type SendResult = Awaited<ReturnType<Messenger["send"]>>;

type PhotonGrpcError = { grpcCode?: number; details?: string; message?: string };

/**
 * Photon's iMessage bridge rejects un-allowlisted recipients with a raw gRPC
 * PERMISSION_DENIED (grpcCode 7) buried under several layers of SDK stack
 * frames. Surface that as an actionable message instead, since it's a
 * project-dashboard problem, not a code bug — the original error is kept as
 * `cause` for anyone who does need the full trace.
 */
export function asFriendlyPhotonError(err: unknown, platformUserId: string): Error {
  const e = err as PhotonGrpcError;
  const text = `${e?.details ?? ""} ${e?.message ?? ""}`;
  if (e?.grpcCode === 7 || /not allowed/i.test(text)) {
    return new Error(
      `Photon rejected sending to "${platformUserId}": not allowed for this project. ` +
        `This is a dashboard/allowlist state, not a code bug — confirm the number is actually ` +
        `active (not just submitted) on the Photon project dashboard.`,
      { cause: err },
    );
  }
  return err instanceof Error ? err : new Error(String(err), { cause: err });
}

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
    let sent;
    try {
      const space = await provider.space.create(platformUserId);
      sent = await space.send(msg.body);
    } catch (err) {
      throw asFriendlyPhotonError(err, platformUserId);
    }
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
