/**
 * The live camera's picture, drawn like the worker's rendered videos (worker/recyclone_worker/guide.py, Guide.annotate):
 * camera name + clock and a red dot, the green skeleton, a black box around the hands holding an item with its name on
 * top, the fps, and a black bottom bar "Item: <item>  Bin: <bin>". Sizes follow the worker's (1920 px reference), with
 * OpenCV's font scale 1.0 drawn as a 30 px font. Coordinates are the video's own pixels.
 */
import type { Keypoints } from "./scoring";
import type { GuideMessage } from "./message";

type Box4 = [number, number, number, number];
export type OverlayPerson = { kp: Keypoints; hands: Box4[]; holding: boolean };
export type OverlayInput = {
  people: OverlayPerson[];
  /** The current answer (named on the item box while someone holds it). */
  answer: GuideMessage | null;
  /** The bottom bar's message: the last announcement, for BAR_S after it. */
  caption: GuideMessage | null;
  cam: string;
  now: Date;
  fps: number;
};

/** The worker's BANNER_S: how long the bottom bar shows the last announcement. */
export const BAR_S = 5;

const SKELETON = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6]];
const GREEN = "rgb(60,220,60)";
const RIM = "rgb(20,90,20)";
const BIN_RGB: Record<string, string> = { recycle: "rgb(80,190,255)", compost: "rgb(90,230,90)", trash: "rgb(220,220,220)", none: "rgb(255,160,60)" };
const BIN_LABEL: Record<string, string> = { recycle: "Recycle", compost: "Compost", trash: "Trash" };
const FONT = "Helvetica, Arial, sans-serif";

/** ("clear plastic cup", "Recycle"); a dangerous item gives ("AA battery", "No bin: Recycle Center"). */
export function itemAndBin(m: GuideMessage): [string, string] {
  if (m.bin === "none") {
    const hit = /^(.*?) is dangerous.*?Place it in (.*?)(?: instead)?\.?$/.exec(m.explanation);
    const item = hit?.[1] ?? m.explanation;
    const place = (hit?.[2] ?? "special drop-off").replace(/^the /i, "");
    return [item, `No bin: ${place}`];
  }
  const item = m.explanation.replace(/, placed in \w+$/, "");
  return [item, BIN_LABEL[m.bin] ?? "Trash"];
}

export function unionBox(boxes: Box4[]): Box4 | null {
  if (!boxes.length) return null;
  return [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
}

const two = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, scale: number, fill: string, outline?: [string, number]) {
  ctx.font = `600 ${Math.round(30 * scale)}px ${FONT}`;
  if (outline) {
    ctx.strokeStyle = outline[0];
    ctx.lineWidth = outline[1];
    ctx.lineJoin = "round";
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(s, x, y);
}

function bottomBar(ctx: CanvasRenderingContext2D, w: number, h: number, m: GuideMessage) {
  const [item, bin] = itemAndBin(m);
  const left = `Item: ${item}`, right = `Bin: ${bin}`;
  const margin = Math.floor(w * 0.03) + 4, gap = Math.floor(w * 0.05);
  const lineH = Math.max(44, Math.floor(Math.min(h, w * 1.6) * 0.06));
  let scale = lineH / 44;
  const width = (s: string, sc: number) => {
    ctx.font = `600 ${Math.round(30 * sc)}px ${FONT}`;
    return ctx.measureText(s).width;
  };
  const oneLine = width(left, scale) + gap + width(right, scale) <= w - 2 * margin;
  if (!oneLine) scale = Math.min(scale, (w - 2 * margin) / Math.max(width(left, 1), width(right, 1)));
  const barH = Math.floor(lineH * (oneLine ? 1.5 : 2.6));
  ctx.fillStyle = "#000";
  ctx.fillRect(0, h - barH, w, barH);
  const color = BIN_RGB[m.bin] ?? "#fff";
  if (oneLine) {
    const base = h - Math.floor(barH / 2) + Math.floor(lineH / 3);
    text(ctx, left, margin, base, scale, "#fff");
    text(ctx, right, margin + width(left, scale) + gap, base, scale, color);
  } else {
    const top = h - barH;
    text(ctx, left, margin, top + lineH * 1.1, scale, "#fff");
    text(ctx, right, margin, top + lineH * 2.25, scale, color);
  }
}

export function drawOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, o: OverlayInput) {
  ctx.clearRect(0, 0, w, h);
  ctx.textBaseline = "alphabetic";
  const big = Math.max(w, h) / 1920;
  const lw = Math.max(2, Math.floor(4 * big));

  // surveillance-camera look: name + clock top left, red dot top right
  text(ctx, `${o.cam}  ${stamp(o.now)}`, 24 * big + 10, 60 * big + 30, 1.1 * big + 0.4, "#fff", ["#000", 6]);
  ctx.fillStyle = "rgb(255,0,0)";
  ctx.beginPath();
  ctx.arc(w - 60 * big - 30, 110 * big + 30, 12 * big + 6, 0, 2 * Math.PI);
  ctx.fill();

  const bone = Math.max(2, Math.floor(lw / 2)), joint = Math.max(3, lw);
  for (const p of o.people) {
    const vis = p.kp.map((k) => k[2] > 0.3);
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = bone;
    ctx.lineCap = "round";
    for (const [a, b] of SKELETON) {
      if (!vis[a] || !vis[b]) continue;
      ctx.beginPath();
      ctx.moveTo(p.kp[a][0], p.kp[a][1]);
      ctx.lineTo(p.kp[b][0], p.kp[b][1]);
      ctx.stroke();
    }
    p.kp.forEach((k, j) => {
      if (!vis[j]) return;
      for (const [color, r] of [[RIM, joint + 1], [GREEN, joint]] as const) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(k[0], k[1], r, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
    if (!p.holding) continue;
    const box = unionBox(p.hands);
    if (!box) continue;
    const [x0, y0, x1, y1] = box;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = lw * 2;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);  // the item, in black
    if (o.answer) {  // its name right on top of the box: black, with a light edge to stay readable
      text(ctx, itemAndBin(o.answer)[0], x0, Math.max(30 * big + 10, y0 - 12 * big - 6), 1.1 * big + 0.35, "#000", ["#fff", lw * 2 + 2]);
    }
  }

  if (o.caption) bottomBar(ctx, w, h, o.caption);
  text(ctx, `${Math.round(o.fps)} fps`, w - 200 * big - 40, 50 * big + 20, big + 0.3, "#fff");
}
