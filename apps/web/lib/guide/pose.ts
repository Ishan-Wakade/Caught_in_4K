/**
 * YOLO11n-pose (public/models/yolo11n-pose.onnx, 640x640) in the browser: letterbox in, people out, and a small
 * tracker in place of the worker's ByteTrack. Decoding was checked against ultralytics' predict() on a dev clip
 * (same people, keypoints within ~7 px on a 1920 px frame; ultralytics pads less than this fixed 640 square).
 */
import type { Box, Keypoints } from "./scoring";

export const POSE_SIZE = 640;
const CONF = 0.3; // as the worker (conf=0.3)
const NMS_IOU = 0.7; // ultralytics' default
const ANCHORS = 8400;

export type Letterbox = { scale: number; left: number; top: number; width: number; height: number };

/** ultralytics' letterbox: scale to fit 640, centre, pad with grey 114. */
export function letterbox(w: number, h: number): Letterbox {
  const scale = Math.min(POSE_SIZE / h, POSE_SIZE / w);
  const width = Math.round(w * scale);
  const height = Math.round(h * scale);
  const pad = (free: number) => Math.max(0, Math.round(free / 2 - 0.1));
  return { scale, width, height, left: pad(POSE_SIZE - width), top: pad(POSE_SIZE - height) };
}

export type Person = { box: Box; score: number; kp: Keypoints };

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9);
}

/** output0 [1, 56, 8400]: per anchor cx, cy, w, h, score, then 17 x (x, y, visibility), in letterboxed pixels. */
export function decodePose(out: Float32Array, lb: Letterbox, anchors = ANCHORS): Person[] {
  const at = (row: number, i: number) => out[row * anchors + i];
  const candidates: number[] = [];
  for (let i = 0; i < anchors; i++) if (at(4, i) > CONF) candidates.push(i);
  candidates.sort((a, b) => at(4, b) - at(4, a));
  const back = (x: number, pad: number) => (x - pad) / lb.scale;
  const people: Person[] = [];
  const kept: Box[] = [];
  for (const i of candidates) {
    const [cx, cy, w, h] = [at(0, i), at(1, i), at(2, i), at(3, i)];
    const box: Box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
    if (kept.some((k) => iou(k, box) > NMS_IOU)) continue;
    kept.push(box);
    const kp: Keypoints = [];
    for (let j = 0; j < 17; j++) kp.push([back(at(5 + 3 * j, i), lb.left), back(at(6 + 3 * j, i), lb.top), at(7 + 3 * j, i)]);
    people.push({
      box: [back(box[0], lb.left), back(box[1], lb.top), back(box[2], lb.left), back(box[3], lb.top)],
      score: at(4, i),
      kp,
    });
  }
  return people;
}

/** Keeps a person's id from frame to frame by box overlap (stands in for ByteTrack in the worker). */
export class PersonTracker {
  private tracks: { id: number; box: Box; seen: number }[] = [];
  private nextId = 1;

  constructor(private minIou = 0.3, private forgetAfterS = 1.0) {}

  /** Ids for this frame's people (same order), and the ids that were dropped. */
  update(people: Person[], t: number): { ids: number[]; gone: number[] } {
    const free = new Set(this.tracks.map((_, i) => i));
    const ids = people.map((p) => {
      let best = -1;
      let bestIou = this.minIou;
      for (const i of free) {
        const o = iou(this.tracks[i].box, p.box);
        if (o >= bestIou) [best, bestIou] = [i, o];
      }
      if (best >= 0) {
        free.delete(best);
        Object.assign(this.tracks[best], { box: p.box, seen: t });
        return this.tracks[best].id;
      }
      const track = { id: this.nextId++, box: p.box, seen: t };
      this.tracks.push(track);
      return track.id;
    });
    const gone = this.tracks.filter((tr) => t - tr.seen > this.forgetAfterS).map((tr) => tr.id);
    this.tracks = this.tracks.filter((tr) => t - tr.seen <= this.forgetAfterS);
    return { ids, gone };
  }
}
