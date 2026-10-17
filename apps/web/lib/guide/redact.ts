/**
 * The only way a camera picture leaves the device: a crop of `box`, at most 320 px, with every head box in `heads`
 * filled black and then any face the face detector still finds in the crop filled black too. Fail closed: a head we
 * cannot size touching the crop, or no face detector, means no crop at all (null). Shared by /guide and /camera.
 */
import type { Box } from "./approach";

export type FaceFinder = { detect(image: HTMLCanvasElement): { detections: Array<{ boundingBox?: { originX: number; originY: number; width: number; height: number } }> } };
export type Head = { box: Box; reliable: boolean };
/** Why a crop did not leave the device (shown in the /camera debug view). */
export type DropReason = "no_face_detector" | "unreliable_head";
/** What redaction did to one crop: the JPEG (null = dropped, with the reason) and how much of it was blacked out. */
export type CropResult = { url: string | null; reason: DropReason | null; black: number; faces: number };
/** The head boxes to fill black, in crop pixels before scaling; or why the crop must be dropped. */
export type RedactionPlan = { drop: DropReason } | { drop: null; fill: Box[] };

const overlaps = (a: Box, b: Box) => a.x1 > b.x0 && a.y1 > b.y0 && a.x0 < b.x1 && a.y0 < b.y1;

/** Pure part of redactedCrop: which head boxes touch `box` (filled black), or drop it if one cannot be sized. */
export function planRedaction(box: Box, heads: Head[]): RedactionPlan {
  const fill: Box[] = [];
  for (const hd of heads) {
    if (!overlaps(hd.box, box)) continue;
    if (!hd.reliable) return { drop: "unreliable_head" };  // a head we cannot size touches the crop: drop it
    fill.push({ x0: hd.box.x0 - box.x0, y0: hd.box.y0 - box.y0, x1: hd.box.x1 - box.x0, y1: hd.box.y1 - box.y0 });
  }
  return { drop: null, fill };
}

/** Share of a w x h crop covered by these rectangles (crop pixels; overlaps counted once, on a coarse grid). */
export function coverage(w: number, h: number, rects: Box[]): number {
  const n = 40;
  let hit = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const x = ((i + 0.5) * w) / n, y = ((j + 0.5) * h) / n;
    if (rects.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1)) hit++;
  }
  return hit / (n * n);
}

export function redactCrop(source: CanvasImageSource, box: Box, heads: Head[], face: FaceFinder | null): CropResult {
  if (!face) return { url: null, reason: "no_face_detector", black: 0, faces: 0 };  // fail closed
  const plan = planRedaction(box, heads);
  if (plan.drop) return { url: null, reason: plan.drop, black: 0, faces: 0 };
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  const s = Math.min(1, 320 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  const g = c.getContext("2d")!;
  g.drawImage(source, box.x0, box.y0, w, h, 0, 0, c.width, c.height);
  g.fillStyle = "#000";
  const filled: Box[] = plan.fill.map((b) => ({ x0: b.x0 * s, y0: b.y0 * s, x1: b.x1 * s, y1: b.y1 * s }));
  for (const b of filled) g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
  const found = face.detect(c).detections;
  for (const d of found) {
    const bb = d.boundingBox;
    if (!bb) continue;
    const b = { x0: bb.originX - 4, y0: bb.originY - 4, x1: bb.originX + bb.width + 4, y1: bb.originY + bb.height + 4 };
    g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    filled.push(b);
  }
  return { url: c.toDataURL("image/jpeg", 0.8), reason: null, black: coverage(c.width, c.height, filled), faces: found.length };
}

/** The crop's JPEG data URL, or null if it must not leave the device (see redactCrop). */
export function redactedCrop(source: CanvasImageSource, box: Box, heads: Head[], face: FaceFinder | null): string | null {
  return redactCrop(source, box, heads, face).url;
}

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
/** Served from this site (MediaPipe BlazeFace short-range, Apache-2.0); the old ".../latest/...task" URL is a 404. */
export const FACE_MODEL = "/models/blaze_face_short_range.tflite";

/** MediaPipe's face detector for redactedCrop; null if it cannot load (then no crop leaves the device). */
export async function loadFaceFinder(): Promise<FaceFinder | null> {
  try {
    const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks(WASM);
    return await FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: "IMAGE" });
  } catch (e) {
    console.warn("face detector unavailable: the server model is off, CLIP only", e);
    return null;
  }
}

/** The demo key: from the URL fragment (#key=…, never sent to a server; erased from the address bar), else stored. */
export function readGuideKey(): string {
  try {
    const k = new URLSearchParams(window.location.hash.slice(1)).get("key");
    if (k) {
      localStorage.setItem("guide.token", k);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return k;
    }
    return localStorage.getItem("guide.token") ?? "";
  } catch {
    return "";
  }
}
