/**
 * Voice-guide API handlers (routes: app/api/guide/identify, app/api/guide/speak).
 * Both require the demo token (x-guide-token, env GUIDE_TOKEN; not configured -> 503, fail closed). Provider keys
 * (DEEPSEEK_API_KEY, TYPESAFE_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID) stay on the server. The speech
 * route only voices a validated bin message, so the ElevenLabs credit cannot be used to say arbitrary text.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { identify as realIdentify, type Keys, type Result } from "./identify";
import { defaultTrash, spoken, validateMessage, type GuideMessage } from "./message";

const MAX_CROPS = 3;
const MAX_CROP_CHARS = 300_000; // ~220 KB of JPEG per crop (the phone sends ~320 px crops)
const RATE_PER_MIN = 120;       // per client address (as set by Vercel's edge)
const RATE_TOTAL_PER_MIN = 600; // overall ceiling for this instance
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
  const now = Date.now();
  for (const [k, ts] of hits) if (ts.every((t) => now - t >= 60_000)) hits.delete(k);
  // per client: only an address a trusted edge sets (Vercel: x-real-ip; Cloudflare tunnel: cf-connecting-ip, which
  // Cloudflare overwrites). Elsewhere every caller shares one bucket; the global ceiling below always applies.
  const edgeIp = process.env.VERCEL ? request.headers.get("x-real-ip") : request.headers.get("cf-connecting-ip");
  const client = `ip:${edgeIp ?? "unknown"}`;
  for (const [key, cap] of [[client, RATE_PER_MIN], ["all", RATE_TOTAL_PER_MIN]] as const) {
    if ((hits.get(key) ?? []).filter((t) => now - t < 60_000).length >= cap) return err(429, "too many requests");
  }
  for (const key of [client, "all"]) hits.set(key, [...(hits.get(key) ?? []).filter((t) => now - t < 60_000), now]);
  return null;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The body as JSON, refusing anything over `limit` bytes: by its declared length first, then while streaming. */
async function json(request: Request, limit = MAX_CROPS * MAX_CROP_CHARS + 10_000): Promise<any> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) throw new HttpError(413, "too large");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Server-only secret for signing the messages /identify produced (only those, and the fixed default, are voiced). */
function speakSecret(): string {
  const s = process.env.GUIDE_SPEAK_SECRET || process.env.ELEVENLABS_API_KEY || process.env.DEEPSEEK_API_KEY;
  if (!s) throw new HttpError(503, "voice guide is not configured");
  return `guide-speak|${s}`;
}

export function signMessage(m: GuideMessage): string {
  return createHmac("sha256", speakSecret()).update(JSON.stringify([m.bin, m.explanation])).digest("hex");
}

function validSignature(m: GuideMessage, sig: unknown): boolean {
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const a = Buffer.from(sig, "hex"), e = Buffer.from(signMessage(m), "hex");
  return a.length === e.length && timingSafeEqual(a, e);
}

export async function handleIdentify(request: Request, identify: Identify = realIdentify): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;
  let body: { crops?: unknown };
  try {
    body = await json(request);
  } catch (e) {
    return err(e instanceof HttpError ? e.status : 400, "invalid body");
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
  return Response.json({ ...r, spoken: r.message ? spoken(r.message) : null, sig: r.message ? signMessage(r.message) : null },
    { headers: { "Cache-Control": "no-store" } });
}

export async function handleSpeak(request: Request, fetchFn: Fetch = fetch as unknown as Fetch): Promise<Response> {
  const denied = guard(request);
  if (denied) return denied;
  let msg: GuideMessage;
  try {
    const body = await json(request, 4_000);
    if (body?.kind === "default") {
      msg = defaultTrash(null);  // the phone's fixed fallback: requested by name, never as free text
    } else {
      msg = body?.message;
      validateMessage(msg);
      if (!validSignature(msg, body?.sig)) return err(401, "only messages the server produced can be voiced");
    }
  } catch (e) {
    return err(e instanceof HttpError ? e.status : 400, "send a valid bin message");
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
