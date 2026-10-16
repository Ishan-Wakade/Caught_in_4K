import { describe, expect, it } from "vitest";
import { InMemoryReplyDedupeStore } from "../dedupe/replyDedupeStore.js";

describe("InMemoryReplyDedupeStore", () => {
  it("reports the first sighting of an id as new", async () => {
    const store = new InMemoryReplyDedupeStore();
    expect(await store.markSeen("msg_1")).toBe(true);
  });

  it("reports every redelivery of the same id as a duplicate", async () => {
    const store = new InMemoryReplyDedupeStore();
    await store.markSeen("msg_1");
    expect(await store.markSeen("msg_1")).toBe(false);
    expect(await store.markSeen("msg_1")).toBe(false);
  });

  it("treats different ids independently", async () => {
    const store = new InMemoryReplyDedupeStore();
    expect(await store.markSeen("msg_1")).toBe(true);
    expect(await store.markSeen("msg_2")).toBe(true);
  });
});
