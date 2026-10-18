/**
 * /model API handlers (routes: app/api/model/identify, app/api/model/bins). Same demo token, rate limit and body limits
 * as the voice guide (lib/guide/server.ts); ANTHROPIC_API_KEY (and TYPESAFE_API_KEY for Jev) stay on the server.
 */
import { HttpError, guard, json, signMessage } from "../guide/server";
import { spoken } from "../guide/message";
import { findOpenings, identifyItem } from "./claude";

const MAX_CROPS = 3;
const MAX_CROP_CHARS = 300_000;
const MAX_FRAME_CHARS = 1_500_000; // a 1536 px JPEG frame

function err(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function anthropicKey(): string | null {
  return process.env.ANTHROPIC_API_KEY || null;
}

export async function handleLiveIdentify(request: Request): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;
  const key = anthropicKey();
  if (!key) return err(503, "ANTHROPIC_API_KEY is not configured");
  let body: { crops?: unknown };
  try {
    body = await json(request, MAX_CROPS * MAX_CROP_CHARS + 10_000);
  } catch (e) {
    return err(e instanceof HttpError ? e.status : 400, "invalid body");
  }
  const crops = body.crops;
  if (!Array.isArray(crops) || crops.length < 1 || crops.length > MAX_CROPS
      || !crops.every((c) => typeof c === "string" && c.startsWith("data:image/jpeg;base64,") && c.length <= MAX_CROP_CHARS)) {
    return err(400, "send 1-3 JPEG data URLs as crops");
  }
  const t0 = Date.now();
  const r = await identifyItem(crops as string[], { anthropic: key, jev: process.env.TYPESAFE_API_KEY ?? "" });
  return Response.json({ ...r, ms: Date.now() - t0, spoken: r.message ? spoken(r.message) : null, sig: r.message ? signMessage(r.message) : null },
    { headers: { "Cache-Control": "no-store" } });
}

export async function handleLiveBins(request: Request): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;
  const key = anthropicKey();
  if (!key) return err(503, "ANTHROPIC_API_KEY is not configured");
  let body: { frame?: unknown; width?: unknown; height?: unknown };
  try {
    body = await json(request, MAX_FRAME_CHARS + 1_000);
  } catch (e) {
    return err(e instanceof HttpError ? e.status : 400, "invalid body");
  }
  const { frame, width, height } = body;
  if (typeof frame !== "string" || !frame.startsWith("data:image/jpeg;base64,") || !Number.isFinite(width) || !Number.isFinite(height)) {
    return err(400, "send {frame: JPEG data URL, width, height}");
  }
  const t0 = Date.now();
  try {
    const openings = await findOpenings(frame, Number(width), Number(height), key);
    return Response.json({ openings, ms: Date.now() - t0 }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return err(502, "bin detection failed");
  }
}
