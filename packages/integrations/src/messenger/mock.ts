import type { Messenger } from "@recyclone/contracts";

type OutboundMessage = Parameters<Messenger["send"]>[0];
type SendResult = Awaited<ReturnType<Messenger["send"]>>;
export type MockSentMessage = OutboundMessage & SendResult;

// Demo stand-in for Photon: keeps every send in memory so the Messages scene
// and the mock-reply route can show/use it without a real channel.
export class MockMessenger implements Messenger {
  readonly sent: MockSentMessage[] = [];
  private counter = 0;

  async send(msg: OutboundMessage): Promise<SendResult> {
    this.counter += 1;
    const result: SendResult = {
      providerMessageId: `mock_msg_${this.counter}`,
      sentAt: new Date().toISOString(),
      mocked: true,
    };
    this.sent.push({ ...msg, ...result });
    return result;
  }
}
