import { describe, expect, it } from "vitest";
import { MockBackend, interpret } from "./backend";
import { FOLLOW_UP_AFTER_MS } from "./fixtures";
import { SCRIPT_LENGTH_S } from "./script";

function run(untilS: number, opts: { stepS?: number } = {}) {
  let t = 1_000_000;
  const b = new MockBackend(() => t);
  const start = t;
  const step = (opts.stepS ?? 1) * 1000;
  while (t - start <= untilS * 1000) {
    b.feed(null);
    t += step;
  }
  return { b, at: () => t };
}

describe("MockBackend scripted run", () => {
  it("covers every demo scenario's feed types", () => {
    const { b } = run(SCRIPT_LENGTH_S + 1);
    const types = new Set(b.feed(null).items.map((i) => i.type));
    for (const t of ["disposal", "alert_opened", "message_sent", "reply_received", "intervention_recorded", "bin_emptied", "illustration_ready", "review_queued"]) {
      expect(types, t).toContain(t);
    }
  });

  it("is deterministic: two runs produce the same events", () => {
    const a = run(SCRIPT_LENGTH_S + 1).b.feed(null).items.map((i) => `${i.type}|${i.summary}`);
    const c = run(SCRIPT_LENGTH_S + 1).b.feed(null).items.map((i) => `${i.type}|${i.summary}`);
    expect(a).toEqual(c);
  });

  it("feed cursor returns only newer items", () => {
    const { b } = run(20);
    const all = b.feed(null);
    expect(all.items.length).toBeGreaterThan(2);
    const mid = all.items[1].cursor;
    expect(b.feed(mid).items.every((i) => i.cursor > mid)).toBe(true);
    expect(b.feed(all.cursor).items).toHaveLength(0);
  });

  it("recommendation fires at 33% after 3 assessed cup drops, to Bean Co.'s manager", () => {
    const { b } = run(24);
    const rec = b.alertsList().alerts.find((a) => a.kind === "recommendation")!;
    expect(rec.trigger).toMatch(/33% < 60%, 3 assessed/);
    expect(rec.contact.contact_id).toBe("ct_beanco_mgr");
    expect(rec.business_name).toBe("Bean Co.");
  });

  it("uncertain origin goes to review and messages nobody about it", () => {
    const { b } = run(30);
    const r = b.reviews().reviews;
    expect(r).toHaveLength(1);
    expect(r[0].item.catalog_item_id).toBe("item_generic_cup");
    expect(b.alertsList().alerts.some((a) => a.item_id === "item_generic_cup")).toBe(false);
  });

  it("unknown item is unassessable and counted as unknown content", () => {
    const { b } = run(19);
    const unk = b.feed(null).items.find((i) => i.type === "disposal" && i.outcome === "unassessable");
    expect(unk).toBeDefined();
    expect(b.bins().bins.find((x) => x.bin_id === "bin_patio_compost")!.unknown_count).toBe(1);
  });

  it("follow-up is sent after the no-reply interval and not before", () => {
    // Recommendation opens at 23s; follow-up due at 23s + interval.
    const due = 23 + FOLLOW_UP_AFTER_MS / 1000;
    const before = run(due - 2).b.alertsList().alerts.find((a) => a.kind === "recommendation" && a.item_id === "item_beanco_cup")!;
    expect(before.state).toBe("sent");
    expect(before.messages.filter((m) => m.kind === "follow_up")).toHaveLength(0);
    const after = run(due + 1).b.alertsList().alerts.find((a) => a.kind === "recommendation" && a.item_id === "item_beanco_cup")!;
    expect(after.state).toBe("follow_up_sent");
    expect(after.messages.filter((m) => m.kind === "follow_up")).toHaveLength(1);
  });

  it("emptying request goes to the bin's emptying contact and resets only that bin", () => {
    const pre = run(50).b;
    const trashPre = pre.bins().bins.find((x) => x.type === "trash")!;
    expect(trashPre.estimated_fullness).toBeGreaterThanOrEqual(0.8);
    expect(pre.alertsList().alerts.find((a) => a.kind === "emptying")!.contact.contact_id).toBe("ct_area_mgr");
    const { b } = run(61);
    const post = b.bins().bins;
    const trash = post.find((x) => x.type === "trash")!;
    expect(trash.estimated_fullness).toBe(0);
    expect(trash.last_emptied_at).not.toBeNull();
    expect(post.find((x) => x.type === "compost")!.observed_counts).toEqual(pre.bins().bins.find((x) => x.type === "compost")!.observed_counts);
  });

  it("an acknowledgement is not a confirmation; the later DONE records an intervention", () => {
    const mid = run(155).b.alertsList().alerts.find((a) => a.item_id === "item_beanco_cup")!;
    expect(mid.state).toBe("acknowledged");
    const { b } = run(SCRIPT_LENGTH_S + 1);
    const cup = b.item("item_beanco_cup")!;
    expect(cup.interventions).toHaveLength(1);
    expect(cup.interventions[0].before.assessed_count).toBe(3);
    expect(cup.interventions[0].after.assessed_count).toBe(2);
  });

  it("items with no assessed events report insufficient data, not 0%", () => {
    const { b } = run(5);
    const bowl = b.items().items.find((i) => i.catalog_item_id === "item_greenbowl_bowl")!;
    expect(bowl.score).toEqual({ status: "insufficient_data" });
  });

  it("presenter reply before the scripted one wins and the script does not repeat it", () => {
    let t = 0;
    const b = new MockBackend(() => t);
    for (; t <= 30_000; t += 1000) b.feed(null);
    b.mockReply({ contactId: "ct_beanco_mgr", body: "ok thanks" });
    expect(b.alertsList().alerts.find((a) => a.item_id === "item_beanco_cup")!.state).toBe("acknowledged");
    b.mockReply({ contactId: "ct_beanco_mgr", body: "Sign is installed" });
    for (; t <= (SCRIPT_LENGTH_S + 1) * 1000; t += 1000) b.feed(null);
    expect(b.item("item_beanco_cup")!.interventions).toHaveLength(1);
  });

  it("review assignment resolves the queued event", () => {
    const { b } = run(30);
    const r = b.reviews().reviews[0];
    b.decideReview(r.event_id, { action: "assign", business_id: "biz_beanco" });
    expect(b.reviews().reviews[0].status).toBe("resolved");
  });
});

describe("interpret (mock)", () => {
  it("treats acknowledgement as not a confirmation", () => {
    expect(interpret("ok thanks", "recommendation")).toBe("acknowledged");
    expect(interpret("Done, sign is up", "recommendation")).toBe("action_confirmed");
    expect(interpret("emptied", "emptying")).toBe("bin_emptied");
    expect(interpret("what?", "recommendation")).toBe("unclear");
  });
});
