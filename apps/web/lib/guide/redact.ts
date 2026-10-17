/**
 * The only way a camera picture leaves the device: a crop of `box`, at most 320 px, with every head box in `heads`
 * filled black and then any face the face detector still finds in the crop filled black too. Fail closed: a head we
 * cannot size touching the crop, or no face detector, means no crop at all (null). Shared by /guide and /camera.
 */
import type { Box } from "./approach";

export type FaceFinder = { detect(image: HTMLCanvasElement): { detections: Array<{ boundingBox?: { originX: number; originY: number; width: number; height: number } }> } };

export function redactedCrop(source: CanvasImageSource, box: Box, heads: Array<{ box: Box; reliable: boolean }>, face: FaceFinder | null): string | null {
  if (!face) return null;  // no face detector: nothing may leave the device (fail closed)
  const w = box.x1 - box.x0, h = box.y1 - box.y0;
  const s = Math.min(1, 320 / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  const g = c.getContext("2d")!;
  g.drawImage(source, box.x0, box.y0, w, h, 0, 0, c.width, c.height);
  g.fillStyle = "#000";
  for (const hd of heads) {
    const b = hd.box;
    const touches = b.x1 > box.x0 && b.y1 > box.y0 && b.x0 < box.x1 && b.y0 < box.y1;
    if (!touches) continue;
    if (!hd.reliable) return null;  // a head we cannot size touches the crop: drop it
    g.fillRect((b.x0 - box.x0) * s, (b.y0 - box.y0) * s, (b.x1 - b.x0) * s, (b.y1 - b.y0) * s);
  }
  for (const d of face.detect(c).detections) {
    const bb = d.boundingBox;
    if (bb) g.fillRect(bb.originX - 4, bb.originY - 4, bb.width + 8, bb.height + 8);
  }
  return c.toDataURL("image/jpeg", 0.8);
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
      window.history.replaceState(null, "", window.location.pathname);
      return k;
    }
    return localStorage.getItem("guide.token") ?? "";
  } catch {
    return "";
  }
}
