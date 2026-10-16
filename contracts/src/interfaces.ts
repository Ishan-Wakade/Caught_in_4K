// Core ↔ integrations interfaces (contracts/README.md §5). Plain types: these cross no network boundary.

export type ContactRef = { contactId: string; phone?: string; handle?: string };
export type InboundReply = { providerMessageId: string; from: ContactRef; body: string; receivedAt: string };
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

/** Implemented by S in packages/integrations; called by I in packages/core. */
export interface Messenger {
  send(msg: {
    to: ContactRef;
    body: string;
    alertId: string;
    kind: "recommendation" | "follow_up" | "emptying_request" | "clarification";
  }): Promise<{ providerMessageId: string; sentAt: string; mocked: boolean }>;
}

export interface Illustrator {
  illustrate(
    snapshot: BinInventorySnapshot,
  ): Promise<{ imageUrl: string; generatedAt: string; snapshotId: string; mocked: boolean }>;
}

export interface ReplyInterpreter {
  interpret(
    reply: InboundReply,
    openAlerts: OpenAlertSummary[],
  ): Promise<{
    alertId: string | null;
    intent: "action_confirmed" | "bin_emptied" | "acknowledged" | "unclear";
    emptiedAt?: string;
  }>;
}

/** Implemented by I in packages/core; called by S's webhook route after de-duplicating by providerMessageId. */
export interface ReplySink {
  handleReply(reply: InboundReply): Promise<{ status: "applied" | "duplicate" | "needs_clarification" }>;
}
