import type { InboundReply, OpenAlertSummary, ReplyInterpreter } from "@recyclone/contracts";

type InterpretResult = Awaited<ReturnType<ReplyInterpreter["interpret"]>>;

// Keyword lists are a first pass, not a finished NLU model — tune them once
// real manager replies from the demo/pilot are available.
const BIN_EMPTIED_KEYWORDS = ["emptied", "emptying it", "dumped it", "cleared the bin", "bin is empty"];
const ACTION_CONFIRMED_KEYWORDS = [
  "done",
  "fixed",
  "installed",
  "put up",
  "put a sign",
  "took care of",
  "handled",
  "confirmed",
  "all set",
];
// Checked only when no stronger signal matched; "ok thanks" must land here,
// not as a confirmation that the action was actually done.
const ACKNOWLEDGED_KEYWORDS = ["ok", "okay", "k", "thanks", "thank you", "got it", "sure", "will do", "noted", "sounds good"];

type RawCategory = "bin_emptied" | "action_confirmed" | "acknowledged" | "none";

function classify(body: string): RawCategory {
  const text = body.toLowerCase();
  if (BIN_EMPTIED_KEYWORDS.some((k) => text.includes(k))) return "bin_emptied";
  if (ACTION_CONFIRMED_KEYWORDS.some((k) => text.includes(k))) return "action_confirmed";
  if (ACKNOWLEDGED_KEYWORDS.some((k) => text.includes(k))) return "acknowledged";
  return "none";
}

function alertKindFor(category: RawCategory): OpenAlertSummary["kind"] | null {
  if (category === "bin_emptied") return "emptying";
  if (category === "action_confirmed") return "recommendation";
  return null;
}

export class RuleBasedReplyInterpreter implements ReplyInterpreter {
  async interpret(reply: InboundReply, openAlerts: OpenAlertSummary[]): Promise<InterpretResult> {
    const category = classify(reply.body);

    if (category === "none" || openAlerts.length === 0) {
      return { alertId: null, intent: "unclear" };
    }

    const requiredKind = alertKindFor(category);
    const candidates = requiredKind ? openAlerts.filter((a) => a.kind === requiredKind) : openAlerts;

    // Exactly one plausible target is required; zero or multiple is ambiguous.
    if (candidates.length !== 1) {
      return { alertId: null, intent: "unclear" };
    }

    const alertId = candidates[0].alertId;
    if (category === "bin_emptied") {
      return { alertId, intent: "bin_emptied", emptiedAt: reply.receivedAt };
    }
    if (category === "action_confirmed") {
      return { alertId, intent: "action_confirmed" };
    }
    return { alertId, intent: "acknowledged" };
  }
}
