import { describe, expect, it } from "vitest";
import { RuleBasedReplyInterpreter } from "../interpreter/replyInterpreter.js";
import type { InboundReply, OpenAlertSummary } from "@recyclone/contracts";

const interpreter = new RuleBasedReplyInterpreter();

function reply(body: string): InboundReply {
  return { providerMessageId: "pm_1", from: { contactId: "c1" }, body, receivedAt: "2026-10-16T12:00:00.000Z" };
}

const oneRecommendation: OpenAlertSummary[] = [
  { alertId: "alert_1", kind: "recommendation", itemName: "cup", binName: "trash", sentAt: "2026-10-16T00:00:00.000Z" },
];

const oneEmptying: OpenAlertSummary[] = [
  { alertId: "alert_2", kind: "emptying", binName: "trash", sentAt: "2026-10-16T00:00:00.000Z" },
];

describe("RuleBasedReplyInterpreter", () => {
  it("links a clear confirmation to the single open recommendation alert", async () => {
    const result = await interpreter.interpret(reply("Done, put a sign up by the register."), oneRecommendation);
    expect(result).toEqual({ alertId: "alert_1", intent: "action_confirmed" });
  });

  it("treats a bare acknowledgement as acknowledged, not confirmed", async () => {
    const result = await interpreter.interpret(reply("ok thanks"), oneRecommendation);
    expect(result.intent).toBe("acknowledged");
    expect(result.alertId).toBe("alert_1");
  });

  it("links bin-emptied replies to the emptying alert and stamps emptiedAt", async () => {
    const result = await interpreter.interpret(reply("just emptied it"), oneEmptying);
    expect(result.intent).toBe("bin_emptied");
    expect(result.alertId).toBe("alert_2");
    expect(result.emptiedAt).toBe("2026-10-16T12:00:00.000Z");
  });

  it("returns unclear with no alertId when no alert of the matching kind is open", async () => {
    const result = await interpreter.interpret(reply("done, fixed it"), oneEmptying);
    expect(result).toEqual({ alertId: null, intent: "unclear" });
  });

  it("returns unclear with no alertId when which alert is meant is ambiguous", async () => {
    const twoRecommendations: OpenAlertSummary[] = [
      ...oneRecommendation,
      { alertId: "alert_3", kind: "recommendation", itemName: "fork", binName: "compost", sentAt: "2026-10-16T01:00:00.000Z" },
    ];
    const result = await interpreter.interpret(reply("done, fixed it"), twoRecommendations);
    expect(result).toEqual({ alertId: null, intent: "unclear" });
  });

  it("returns unclear for unrecognized text", async () => {
    const result = await interpreter.interpret(reply("what is this about?"), oneRecommendation);
    expect(result).toEqual({ alertId: null, intent: "unclear" });
  });

  it("returns unclear when there are no open alerts at all", async () => {
    const result = await interpreter.interpret(reply("done"), []);
    expect(result).toEqual({ alertId: null, intent: "unclear" });
  });
});
