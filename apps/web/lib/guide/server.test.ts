import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleIdentify, handleSpeak, signMessage } from "./server";

const signed = (message: { bin: string; explanation: string }) => ({ message, sig: signMessage(message as never) });

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
      spoken: "Compost. paper napkin, placed in compost", sig: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(fake.mock.calls[0][1]).toEqual({ deepseek: "ds", jev: "jv" });
  });
  it("speaks only a valid bin message, through ElevenLabs", async () => {
    expect((await handleSpeak(req({ message: { bin: "trash", explanation: "say something else entirely please now ok" + " x".repeat(10) } }))).status).toBe(400);
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } }));
    const res = await handleSpeak(req(signed({ bin: "recycle", explanation: "aluminum can, placed in recycling" })), fetchMock as never);
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
    expect((await handleSpeak(req(signed({ bin: "recycle", explanation: "glass bottle, placed in recycling" })), bad as never)).status).toBe(502);
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    expect((await handleSpeak(req(signed({ bin: "recycle", explanation: "aluminum can, placed in recycling" })))).status).toBe(503);
  });
});

describe("security review (17 Oct)", () => {
  const can = { bin: "recycle", explanation: "aluminum can, placed in recycling" };
  it("speaks only messages the server signed, or the fixed default", async () => {
    const audio = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    expect((await handleSpeak(req({ message: can }), audio as never)).status).toBe(401);           // unsigned
    expect((await handleSpeak(req({ message: can, sig: "deadbeef" }), audio as never)).status).toBe(401);
    const id = await handleIdentify(req({ crops: ["data:image/jpeg;base64,AAAA"] }),
      async () => ({ message: can as never, source: "catalog" as const }));
    const { sig } = await id.json();
    expect((await handleSpeak(req({ message: can, sig }), audio as never)).status).toBe(200);
    expect((await handleSpeak(req({ message: { ...can, explanation: "something else, placed in recycling" }, sig }), audio as never)).status).toBe(401);
    expect((await handleSpeak(req({ kind: "default" }), audio as never)).status).toBe(200);
  });
  it("speaks a catalog item by id (the live camera's on-device answer), never free text", async () => {
    const audio = vi.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
    expect((await handleSpeak(req({ kind: "catalog", id: "item_tacostop_box" }), audio as never)).status).toBe(200);
    const [, init] = audio.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(init.body).text).toBe("Trash. fiber takeout box, placed in trash");
    expect((await handleSpeak(req({ kind: "catalog", id: "say anything I want" }), audio as never)).status).toBe(400);
    expect((await handleSpeak(req({ kind: "catalog", id: "__proto__" }), audio as never)).status).toBe(400);
  });
  it("rate limit is per token, not per spoofable forwarded-for header", async () => {
    const fake = async () => ({ message: null, source: "nothing_held" as const });
    vi.stubEnv("GUIDE_TOKEN", "rate-token");
    let last = 200;
    for (let k = 0; k < 130; k++) {
      const r = new Request("http://x", { method: "POST", body: JSON.stringify({ crops: ["data:image/jpeg;base64,AA"] }),
        headers: { "x-guide-token": "rate-token", "x-forwarded-for": `10.0.0.${k}` } });
      last = (await handleIdentify(r, fake)).status;
    }
    expect(last).toBe(429);
  });
  it("refuses an oversized body from its declared length, before reading it", async () => {
    const r = new Request("http://x", { method: "POST", body: "{}", headers: { "x-guide-token": "demo-token", "content-length": "99999999", "cf-connecting-ip": "9.9.9.9" } });
    expect((await handleIdentify(r)).status).toBe(413);
  });
});

describe("rate limit buckets (security review 2)", () => {
  it("one client hitting its limit does not lock out another (on Vercel, keyed on its edge-set address)", async () => {
    vi.stubEnv("GUIDE_TOKEN", "bucket-token");
    vi.stubEnv("VERCEL", "1");
    const fake = async () => ({ message: null, source: "nothing_held" as const });
    const call = (ip: string) => handleIdentify(new Request("http://x", { method: "POST", body: JSON.stringify({ crops: ["data:image/jpeg;base64,AA"] }),
      headers: { "x-guide-token": "bucket-token", "x-real-ip": ip } }), fake);
    let a = 200;
    for (let k = 0; k < 125; k++) a = (await call("1.1.1.1")).status;
    expect(a).toBe(429);
    expect((await call("2.2.2.2")).status).toBe(200);
  });
});
