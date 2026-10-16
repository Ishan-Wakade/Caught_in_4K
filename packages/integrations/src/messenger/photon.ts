import type { Messenger, OutboundMessage, SendResult } from "../types.js";

export type PhotonMessengerConfig = {
  apiKey: string;
  channel: string;
};

// Real adapter skeleton. Photon 2.0's actual send endpoint, auth header, and
// request/response shape are unconfirmed (no docs reviewed yet) — see
// packages/integrations/AGENTS.md "Open questions" before wiring this up.
// MESSENGER_MODE=live routes here; until the TODOs below are resolved this
// throws instead of silently pretending to send.
export class PhotonMessenger implements Messenger {
  constructor(private readonly config: PhotonMessengerConfig) {}

  async send(_msg: OutboundMessage): Promise<SendResult> {
    throw new Error(
      "PhotonMessenger is not implemented: Photon 2.0's send endpoint and auth scheme " +
        "have not been confirmed against their docs. Set MESSENGER_MODE=mock, or finish " +
        "this adapter once PHOTON_API_KEY / PHOTON_CHANNEL and the API reference are available.",
    );
    // TODO once Photon docs are reviewed:
    // const res = await fetch(PHOTON_SEND_URL, {
    //   method: "POST",
    //   headers: { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" },
    //   body: JSON.stringify({ channel: this.config.channel, to: _msg.to, text: _msg.body }),
    // });
    // ...map res to SendResult, mocked: false
  }
}
