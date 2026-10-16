import { describe, expect, it, vi } from "vitest";
import { PhotonMessenger } from "../messenger/photon.js";

const createMock = vi.fn();
vi.mock("../messenger/photonApp.js", () => ({
  getPhotonProvider: () => Promise.resolve({ space: { create: createMock } }),
}));

const baseMsg = {
  to: { contactId: "c1", phone: "+15551234567" },
  body: "hello",
  alertId: "alert_1",
  kind: "recommendation" as const,
};

describe("PhotonMessenger", () => {
  it("maps a successful send to SendResult with mocked: false", async () => {
    const timestamp = new Date("2026-10-16T12:00:00.000Z");
    createMock.mockResolvedValueOnce({ send: vi.fn().mockResolvedValueOnce({ id: "msg_abc", timestamp }) });

    const result = await new PhotonMessenger().send(baseMsg);
    expect(result).toEqual({ providerMessageId: "msg_abc", sentAt: timestamp.toISOString(), mocked: false });
  });

  it("turns a PERMISSION_DENIED (grpcCode 7) into an actionable allowlist error", async () => {
    const grpcErr = { grpcCode: 7, details: "[spectrum-imessage] Target not allowed for this project" };
    createMock.mockResolvedValueOnce({ send: vi.fn().mockRejectedValueOnce(grpcErr) });

    const caught: Error = await new PhotonMessenger().send(baseMsg).catch((e) => e);
    expect(caught.message).toMatch(/not allowed for this project/i);
    expect(caught.message).not.toMatch(/grpcCode/);
    expect(caught.cause).toBe(grpcErr); // original error preserved for anyone who needs the full trace
  });

  it("rejects a contact with neither phone nor handle before touching the provider", async () => {
    await expect(new PhotonMessenger().send({ ...baseMsg, to: { contactId: "c2" } })).rejects.toThrow(/phone nor handle/);
    expect(createMock).not.toHaveBeenCalled();
  });
});
