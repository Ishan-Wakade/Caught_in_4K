import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeEventId } from "../src/event-id.js";

type Vector = { camera_id: string; clip_id: string; track_id: number; bin_id: string; event_id: string };
const vectors: Vector[] = JSON.parse(
  readFileSync(new URL("../fixtures/event-id-vectors.json", import.meta.url), "utf8"),
);

describe("makeEventId", () => {
  it("matches vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(3);
    expect(vectors.some((v) => v.track_id === 0)).toBe(true);
    for (const v of vectors) {
      expect(makeEventId(v.camera_id, v.clip_id, v.track_id, v.bin_id)).toBe(v.event_id);
    }
  });

  it("is deterministic and order-sensitive", () => {
    const a = makeEventId("cam_a", "clip_1", 3, "bin_b");
    expect(makeEventId("cam_a", "clip_1", 3, "bin_b")).toBe(a);
    expect(makeEventId("bin_b", "clip_1", 3, "cam_a")).not.toBe(a);
    expect(a).toMatch(/^evt_[0-9a-f]{16}$/);
  });
});
