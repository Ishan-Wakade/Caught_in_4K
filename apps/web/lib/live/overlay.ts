/**
 * /model's picture, drawn like the worker's demo videos (worker/recyclone_worker/guide.py, Guide.annotate with --cctv):
 * camera name + clock and a red dot, each bin opening boxed in its bin's colour with its label, the green skeleton,
 * a black box around the item a person carries with its name (and type) on top, the fps, and the black bottom bar:
 * "Item: <item>  Bin: <bin>" and, once the item went in, "Thrown in: <bin>  CORRECT | WRONG BIN".
 * Sizes follow the worker's (1920 px reference), OpenCV font scale 1.0 drawn as a 30 px font, video pixels.
 */
import type { GuideMessage } from "../guide/message";
import type { Keypoints } from "../guide/scoring";
import type { Opening } from "./claude";
import type { Outcome } from "./watch";

type Box4 = [number, number, number, number];
export type OverlayPerson = { kp: Keypoints; item: Box4 | null; label: string | null };
/** sure: false for a "not sure" answer; then the bar says where it went but not CORRECT / WRONG BIN. */
export type Caption = { message: GuideMessage; outcome: Outcome | null; sure: boolean };
export type OverlayInput = {
  people: OverlayPerson[];
  openings: Opening[];
  caption: Caption | null;
  cam: string;
  now: Date;
  fps: number;
};

const SKELETON = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6]];
const GREEN = "rgb(60,220,60)";
const RIM = "rgb(20,90,20)";
/** guide.BIN_COLOR / OPENING_COLOR (BGR there). */
const BIN_RGB: Record<string, string> = { recycle: "rgb(80,190,255)", compost: "rgb(90,230,90)", trash: "rgb(220,220,220)", none: "rgb(255,160,60)" };
const OPENING_RGB: Record<string, string> = { recycle: "rgb(20,110,200)", compost: "rgb(30,140,30)", trash: "rgb(40,40,40)" };
const BIN_LABEL: Record<string, string> = { recycle: "Recycle", compost: "Compost", trash: "Trash" };
const BIN_NAME: Record<string, string> = { recycle: "Recycling", trash: "Waste", compost: "Organics" };
const FONT = "Helvetica, Arial, sans-serif";

/** ("clear plastic cup", "Recycle"); a dangerous item gives ("AA battery", "No bin: Recycle Center"). */
export function itemAndBin(m: GuideMessage): [string, string] {
  if (m.bin === "none") {
    const hit = /^(.*?) (?:is dangerous|does not go).*?Place it in (.*?)(?: instead)?\.?$/.exec(m.explanation);
    const item = hit?.[1] ?? m.explanation;
    const place = (hit?.[2] ?? "special drop-off").replace(/^the /i, "");
    return [item, `No bin: ${place}`];
  }
  const item = m.explanation.replace(/, placed in \w+$/, "");
  return [item, BIN_LABEL[m.bin] ?? "Trash"];
}

/** bins.outcome_text: ("Thrown in: Organics", "CORRECT" | "WRONG BIN", correct); null when the opening's bin is unknown. */
export function outcomeText(m: GuideMessage, o: Outcome): [string, string, boolean] | null {
  if (!(o.bin in BIN_NAME)) return null;
  const ok = o.bin === m.bin;
  return [`Thrown in: ${BIN_NAME[o.bin]}`, ok ? "CORRECT" : "WRONG BIN", ok];
}

const two = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, scale: number, fill: string, outline?: [string, number], weight = 600) {
  ctx.font = `${weight} ${Math.round(30 * scale)}px ${FONT}`;
  if (outline) {
    ctx.strokeStyle = outline[0];
    ctx.lineWidth = outline[1];
    ctx.lineJoin = "round";
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(s, x, y);
}

function bottomBar(ctx: CanvasRenderingContext2D, w: number, h: number, c: Caption) {
  const [item, bin] = itemAndBin(c.message);
  const pairs: Array<Array<[string, string]>> = [[[`Item: ${item}`, "#fff"], [`Bin: ${bin}`, BIN_RGB[c.message.bin] ?? "#fff"]]];
  const verdict = c.outcome ? outcomeText(c.message, c.outcome) : null;
  if (verdict && c.sure) pairs.push([[verdict[0], "#fff"], [verdict[1], verdict[2] ? "rgb(90,230,90)" : "rgb(255,60,60)"]]);
  else if (verdict) pairs.push([[verdict[0], "#fff"]]);
  const margin = Math.floor(w * 0.03) + 4, gap = Math.floor(w * 0.05);
  const lineH = Math.max(44, Math.floor(Math.min(h, w * 1.6) * 0.06));
  let scale = lineH / 44;
  const width = (s: string, sc: number) => {
    ctx.font = `700 ${Math.round(30 * sc)}px ${FONT}`;
    return ctx.measureText(s).width;
  };
  const rows: Array<Array<[string, string]>> = [];
  for (const pair of pairs) {
    const fits = pair.reduce((s, [t]) => s + width(t, scale), 0) + gap <= w - 2 * margin;
    if (fits) rows.push(pair);
    else pair.forEach((p) => rows.push([p]));
  }
  const widest = Math.max(...rows.flat().map(([t]) => width(t, 1)));
  scale = Math.min(scale, (w - 2 * margin) / Math.max(1, widest));
  const step = Math.floor(lineH * 1.15);
  const barH = step * rows.length + Math.floor(lineH * 0.45);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, h - barH, w, barH);
  rows.forEach((row, k) => {
    const y = h - barH + Math.floor(lineH * 0.2) + step * k + lineH - Math.floor(lineH * 0.15);
    let x = margin;
    for (const [t, color] of row) {
      text(ctx, t, x, y, scale, color, undefined, t === "CORRECT" || t === "WRONG BIN" ? 800 : 600);
      x += width(t, scale) + gap;
    }
  });
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

  // each bin opening with its label, in its bin's colour
  for (const op of o.openings) {
    const [x0, y0, x1, y1] = op.box;
    const color = OPENING_RGB[op.bin] ?? "#fff";
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(2, Math.floor(lw / 2)) + 1;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    text(ctx, op.label, x1 + 8 * big + 4, (y0 + y1) / 2 + 10 * big, 0.7 * big + 0.3, color, ["#fff", lw + 2]);
  }

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
    if (!p.item) continue;
    const [x0, y0, x1, y1] = p.item;
    ctx.strokeStyle = "#000";
    ctx.lineWidth = lw * 2;
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);  // the item, in black
    if (p.label) {  // its name right on top of the box: black, with a light edge to stay readable
      text(ctx, p.label, x0, Math.max(30 * big + 10, y0 - 12 * big - 6), 1.1 * big + 0.35, "#000", ["#fff", lw * 2 + 2]);
    }
  }

  if (o.caption) bottomBar(ctx, w, h, o.caption);
  text(ctx, `${Math.round(o.fps)} fps`, w - 200 * big - 40, 50 * big + 20, big + 0.3, "#fff");
}
