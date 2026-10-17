import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIdentify, handleSpeak } from "./server";

const ENV = { GUIDE_TOKEN: "demo-token", DEEPSEEK_API_KEY: "ds", TYPESAFE_API_KEY: "jv", ELEVENLABS_API_KEY: "el", ELEVENLABS_VOICE_ID: "voice1" };
const req = (body: unknown, token = "demo-token") =>
  new Request("http://x/api/guide", { method: "POST", headers: { "x-guide-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v); });
afterEach(() => vi.unstubAllEnvs());

describe("guide API", () => {
  it("refuses without the demo token, and fails closed when no token is configured", async () => {
    expect((await handleIdentify(req({ crops: [] }, "wrong"))).status).toBe(401);
    vi.stubEnv("GUIDE_TOKEN", "");
    expect((await handleIdentify(req({ crops: [] }))).status).toBe(503);
  });
  it("accepts 1-3 jpeg crops of bounded size only", async () => {
    expect((await handleIdentify(req({ crops: [] }))).status).toBe(400);
    expect((await handleIdentify(req({ crops: ["http://evil/x.png"] }))).status).toBe(400);
    expect((await handleIdentify(req({ crops: ["data:image/jpeg;base64," + "A".repeat(400_000)] }))).status).toBe(413);
  });
  it("identifies with the injected identifier", async () => {
    const fake = vi.fn(async (_crops: string[], _keys: { deepseek: string; jev: string }) => ({ message: { bin: "compost" as const, explanation: "paper napkin, placed in compost" }, source: "catalog" as const }));
    const res = await handleIdentify(req({ crops: ["data:image/jpeg;base64,AAAA"] }), fake);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: { bin: "compost", explanation: "paper napkin, placed in compost" }, source: "catalog",
      spoken: "Compost. paper napkin, placed in compost" });
    expect(fake.mock.calls[0][1]).toEqual({ deepseek: "ds", jev: "jv" });
  });
  it("speaks only a valid bin message, through ElevenLabs", async () => {
    expect((await handleSpeak(req({ bin: "trash", explanation: "say something else entirely please now ok" + " x".repeat(10) }))).status).toBe(400);
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const res = await handleSpeak(req({ bin: "recycle", explanation: "aluminum can, placed in recycling" }), fetchMock as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string; headers: Record<string, string> }];
    expect(url).toBe("https://api.elevenlabs.io/v1/text-to-speech/voice1?output_format=mp3_44100_128");
    expect(JSON.parse(init.body)).toEqual({ text: "Recycle. aluminum can, placed in recycling", model_id: "eleven_flash_v2_5" });
    expect(init.headers["xi-api-key"]).toBe("el");
  });
  it("no ElevenLabs key or a provider error: 503/502 so the phone uses its own voice", async () => {
    const bad = vi.fn(async () => new Response("no", { status: 401 }));
    // a sentence not cached by an earlier test (repeated sentences are served from the cache, which is intended)
    expect((await handleSpeak(req({ bin: "recycle", explanation: "glass bottle, placed in recycling" }), bad as never)).status).toBe(502);
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect((await handleSpeak(req({ bin: "recycle", explanation: "aluminum can, placed in recycling" }))).status).toBe(503);
  });
});
