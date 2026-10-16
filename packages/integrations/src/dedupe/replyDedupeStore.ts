// Photon may redeliver the same webhook; this stops a redelivery from
// reaching ReplySink.handleReply twice. In-memory only — fine for the demo
// process, which is why this is kept behind an interface: swap in a
// persistent store (e.g. backed by core's DB) without touching the webhook route.
export interface ReplyDedupeStore {
  /** Returns true the first time a providerMessageId is seen, false on every repeat. */
  markSeen(providerMessageId: string): Promise<boolean>;
}

export class InMemoryReplyDedupeStore implements ReplyDedupeStore {
  private readonly seen = new Set<string>();

  async markSeen(providerMessageId: string): Promise<boolean> {
    if (this.seen.has(providerMessageId)) return false;
    this.seen.add(providerMessageId);
    return true;
  }
}
