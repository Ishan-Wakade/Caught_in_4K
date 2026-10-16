import { createHash } from "node:crypto";

/**
 * Deterministic disposal-event ID: the same clip and track always produce the same ID,
 * so reprocessing a clip never creates duplicates. The Python worker must compute the
 * identical value (see fixtures/event-id-vectors.json).
 */
export function makeEventId(cameraId: string, clipId: string, trackId: number, binId: string): string {
  const key = `${cameraId}|${clipId}|${trackId}|${binId}`;
  return `evt_${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16)}`;
}
