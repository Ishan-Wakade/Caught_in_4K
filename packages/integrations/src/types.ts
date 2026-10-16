// Mirrors contract §5 (contracts/README.md), which is not yet published as
// @recyclone/contracts. Replace these with that import once E ships the
// package, and delete this file — do not let the two drift independently.

export type ContactRef = { contactId: string; phone?: string; handle?: string };

export type InboundReply = {
  providerMessageId: string;
  from: ContactRef;
  body: string;
  receivedAt: string;
};

export type OpenAlertSummary = {
  alertId: string;
  kind: "recommendation" | "emptying";
  itemName?: string;
  binName?: string;
  sentAt: string;
};

export type BinInventorySnapshot = {
  snapshotId: string;
  binId: string;
  binType: "trash" | "recycling" | "compost";
  takenAt: string;
  estimatedFullness: number;
  items: { name: string; count: number }[];
  unknownCount: number;
};

export type MessageKind = "recommendation" | "follow_up" | "emptying_request" | "clarification";

export type OutboundMessage = {
  to: ContactRef;
  body: string;
  alertId: string;
  kind: MessageKind;
};

export type SendResult = { providerMessageId: string; sentAt: string; mocked: boolean };

export interface Messenger {
  send(msg: OutboundMessage): Promise<SendResult>;
}

export type IllustrateResult = {
  imageUrl: string;
  generatedAt: string;
  snapshotId: string;
  mocked: boolean;
};

export interface Illustrator {
  illustrate(snapshot: BinInventorySnapshot): Promise<IllustrateResult>;
}

export type ReplyIntent = "action_confirmed" | "bin_emptied" | "acknowledged" | "unclear";

export type InterpretResult = {
  alertId: string | null;
  intent: ReplyIntent;
  emptiedAt?: string;
};

export interface ReplyInterpreter {
  interpret(reply: InboundReply, openAlerts: OpenAlertSummary[]): Promise<InterpretResult>;
}

// Implemented by I in packages/core; called by S's webhook route after
// de-duplicating by providerMessageId (contract §6).
export interface ReplySink {
  handleReply(reply: InboundReply): Promise<{ status: "applied" | "duplicate" | "needs_clarification" }>;
}
