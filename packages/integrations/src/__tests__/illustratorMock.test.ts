import { describe, expect, it } from "vitest";
import { MockIllustrator } from "../illustrator/mock.js";
import type { BinInventorySnapshot } from "@recyclone/contracts";

const snapshot: BinInventorySnapshot = {
  snapshotId: "snap_1",
  binId: "bin_patio_trash",
  binType: "trash",
  takenAt: "2026-10-16T12:00:00.000Z",
  estimatedFullness: 0.42,
  items: [{ name: "paper coffee cup", count: 3 }],
  unknownCount: 1,
};

describe("MockIllustrator", () => {
  it("returns an image linked to the snapshot's own id and bin, labeled mocked", async () => {
    const illustrator = new MockIllustrator();
    const result = await illustrator.illustrate(snapshot);

    expect(result.mocked).toBe(true);
    expect(result.snapshotId).toBe(snapshot.snapshotId);
    expect(result.imageUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);

    const svg = Buffer.from(result.imageUrl.split(",")[1], "base64").toString("utf-8");
    expect(svg).toContain(snapshot.binId);
    expect(svg).toContain(snapshot.snapshotId);
    expect(svg).toContain("paper coffee cup");
    expect(svg).toContain("MOCKED");
  });

  it("produces a different image for a different snapshot of the same bin", async () => {
    const illustrator = new MockIllustrator();
    const later: BinInventorySnapshot = { ...snapshot, snapshotId: "snap_2", estimatedFullness: 0.9 };
    const a = await illustrator.illustrate(snapshot);
    const b = await illustrator.illustrate(later);
    expect(a.imageUrl).not.toBe(b.imageUrl);
  });
});
