import { describe, expect, it } from "vitest";
import { areaParam, errorInfo, getJob, stageIndex, UploadError, videoUrl } from "./upload";

describe("areaParam", () => {
  it("sends no area when no box was drawn", () => {
    expect(areaParam(null)).toBe("");
  });
  it("clamps to the frame and rounds", () => {
    expect(areaParam({ x0: -0.1, y0: 0.123456, x1: 1.2, y1: 0.9 })).toBe("0.0000,0.1235,1.0000,0.9000");
  });
});

describe("helpers", () => {
  it("builds video and download URLs", () => {
    expect(videoUrl("abc", false, "https://x.modal.run")).toBe("https://x.modal.run/jobs/abc/video");
    expect(videoUrl("abc", true, "https://x.modal.run")).toBe("https://x.modal.run/jobs/abc/video?download=1");
  });
  it("orders the stages, an unknown stage counting as started", () => {
    expect(stageIndex({ status: "queued" })).toBe(0);
    expect(stageIndex({ status: "running", stage: "identifying" })).toBe(4);
    expect(stageIndex({ status: "running", stage: "something new" })).toBe(1);
  });
  it("falls back to a generic message for unknown codes", () => {
    expect(errorInfo("no_bins").retry).toBe("review");
    expect(errorInfo("weird").title).toBe(errorInfo("failed").title);
  });
});

describe("getJob", () => {
  const fake = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("returns the job", async () => {
    expect(await getJob("id", fake(200, { status: "running", stage: "rendering" }), "")).toEqual({ status: "running", stage: "rendering" });
  });
  it("throws the server's error code", async () => {
    await expect(getJob("id", fake(404, { detail: "expired" }), "")).rejects.toEqual(new UploadError("expired"));
    await expect(getJob("id", fake(429, "<html>"), "")).rejects.toEqual(new UploadError("rate_limited"));
  });
  it("reports a network failure", async () => {
    const down = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
    await expect(getJob("id", down, "")).rejects.toEqual(new UploadError("network"));
  });
});
