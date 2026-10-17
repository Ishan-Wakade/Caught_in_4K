import { describe, expect, it } from "vitest";
import type { FeedItem } from "./types";
import { SCENES, TOAST_MS, initialDirector, onFeedItem, selectScene, tick } from "./sceneDirector";

let n = 0;
const item = (type: FeedItem["type"], ref: FeedItem["ref"] = {}): FeedItem => ({
  cursor: String(++n).padStart(6, "0"),
  at: new Date(0).toISOString(),
  type,
  ref,
  summary: type,
  demo: true,
});

const ALL_TYPES: FeedItem["type"][] = [
  "disposal",
  "alert_opened",
  "message_sent",
  "reply_received",
  "intervention_recorded",
  "bin_emptied",
  "illustration_ready",
  "review_queued",
  "review_resolved",
];

describe("sceneDirector", () => {
  it.each(SCENES)("no feed item ever switches away from %s", (scene) => {
    let s = selectScene(initialDirector(), scene);
    let t = 0;
    for (const type of ALL_TYPES) {
      s = onFeedItem(s, item(type, { bin_id: "b1", alert_id: "a1" }), t);
      t += 10_000;
      s = tick(s, t);
      expect(s.scene).toBe(scene);
    }
  });

  it("only the presenter switches scenes", () => {
    let s = selectScene(initialDirector(), "bins");
    expect(s.scene).toBe("bins");
    s = selectScene(s, "live");
    expect(s.scene).toBe("live");
  });

  it("marks other tabs with unseen updates, never the current one", () => {
    const s = onFeedItem(initialDirector(), item("disposal", { bin_id: "b1" }), 0);
    expect(s.unseen).toEqual({ live: false, bins: true });
  });

  it("selecting a tab clears its unseen marker only", () => {
    let s = selectScene(initialDirector(), null);
    s = onFeedItem(s, item("disposal", { bin_id: "b1" }), 0);
    expect(s.unseen).toEqual({ live: true, bins: true });
    s = selectScene(s, "bins");
    expect(s.unseen).toEqual({ live: true, bins: false });
  });

  it("alerts raise a toast that expires without moving the screen", () => {
    let s = onFeedItem(initialDirector(), item("alert_opened", { alert_id: "a1" }), 0);
    expect(s.toast?.tone).toBe("alert");
    expect(s.scene).toBe("live");
    s = tick(s, TOAST_MS + 1);
    expect(s.toast).toBeNull();
    expect(s.scene).toBe("live");
  });

  it("recommendation alerts (item_id set) don't raise a toast", () => {
    const s = onFeedItem(initialDirector(), item("alert_opened", { alert_id: "a1", item_id: "i1" }), 0);
    expect(s.toast).toBeNull();
  });

  it("review_queued shows an info toast", () => {
    const s = onFeedItem(initialDirector(), item("review_queued"), 0);
    expect(s.toast?.tone).toBe("info");
  });

  it("on a management page every scene collects unseen updates", () => {
    let s = selectScene(initialDirector(), null);
    s = onFeedItem(s, item("disposal", { bin_id: "b1" }), 0);
    expect(s.unseen).toEqual({ live: true, bins: true });
  });

  it("tracks the focused bin and the active alert for the hidden scenes", () => {
    let s = onFeedItem(initialDirector(), item("disposal", { bin_id: "b1" }), 0);
    s = onFeedItem(s, item("alert_opened", { alert_id: "a1" }), 0);
    expect(s.focusBinId).toBe("b1");
    expect(s.activeAlertId).toBe("a1");
  });
});
