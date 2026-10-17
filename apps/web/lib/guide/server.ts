/**
 * Voice-guide API handlers (routes: app/api/guide/identify, app/api/guide/speak).
 * Both require the demo token (x-guide-token, env GUIDE_TOKEN; not configured -> 503, fail closed). Provider keys
 * (DEEPSEEK_API_KEY, TYPESAFE_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID) stay on the server. The speech
 * route only voices a validated bin message, so the ElevenLabs credit cannot be used to say arbitrary text.
 */
import { timingSafeEqual } from "node:crypto";
import { identify as realIdentify, type Keys, type Result } from "./identify";
import { spoken, validateMessage, type GuideMessage } from "./message";

const MAX_CROPS = 3;
const MAX_CROP_CHARS = 300_000; // ~220 KB of JPEG per crop (the phone sends ~320 px crops)
const RATE_PER_MIN = 60;
const hits = new Map<string, number[]>();
const audioCache = new Map<string, ArrayBuffer>(); // per instance; speech for repeated messages is free

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<Response>;
type Identify = (crops: string[], keys: Keys) => Promise<Result>;

function err(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function guard(request: Request): Response | null {
  const token = process.env.GUIDE_TOKEN;
  if (!token) return err(503, "voice guide is not configured");
  const a = Buffer.from(request.headers.get("x-guide-token") ?? ""), e = Buffer.from(token);
  if (a.length !== e.length || !timingSafeEqual(a, e)) return err(401, "invalid guide token");
  const who = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const now = Date.now();
  const recent = (hits.get(who) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= RATE_PER_MIN) return err(429, "too many requests");
  hits.set(who, [...recent, now]);
  return null;
}

async function json(request: Request): Promise<any> {
  const text = await request.text();
  if (text.length > MAX_CROPS * MAX_CROP_CHARS + 10_000) throw Object.assign(new Error("too large"), { status: 413 });
  return JSON.parse(text);
}

export async function handleIdentify(request: Request, identify: Identify = realIdentify): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;
  let body: { crops?: unknown };
  try {
    body = await json(request);
  } catch (e) {
    return err((e as { status?: number }).status ?? 400, "invalid body");
  }
  const crops = body.crops;
  if (!Array.isArray(crops) || crops.length < 1 || crops.length > MAX_CROPS
      || !crops.every((c) => typeof c === "string" && c.startsWith("data:image/jpeg;base64,"))) {
    return err(400, "send 1-3 JPEG data URLs as crops");
  }
  if (crops.some((c: string) => c.length > MAX_CROP_CHARS)) return err(413, "crop too large");
  const keys = { deepseek: process.env.DEEPSEEK_API_KEY ?? "", jev: process.env.TYPESAFE_API_KEY ?? "" };
  if (!keys.deepseek) return err(503, "DEEPSEEK_API_KEY is not configured");
  const r = await identify(crops as string[], keys);
  return Response.json({ ...r, spoken: r.message ? spoken(r.message) : null }, { headers: { "Cache-Control": "no-store" } });
}

export async function handleSpeak(request: Request, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;
  let msg: GuideMessage;
  try {
    msg = await json(request);
    validateMessage(msg);
  } catch {
    return err(400, "send a valid bin message");
  }
  const key = process.env.ELEVENLABS_API_KEY, voice = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voice) return err(503, "ElevenLabs is not configured");
  const text = spoken(msg);
  let audio = audioCache.get(text);
  if (!audio) {
    const res = await fetchFn(`https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_flash_v2_5" }),
    });
    if (!res.ok) return err(502, `voice provider error ${res.status}`);
    audio = await res.arrayBuffer();
    if (audioCache.size > 200) audioCache.clear();
    audioCache.set(text, audio);
  }
  return new Response(audio, { headers: { "content-type": "audio/mpeg", "Cache-Control": "no-store" } });
}
