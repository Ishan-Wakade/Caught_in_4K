import { timingSafeEqual } from "node:crypto";
import { CoreError } from "@recyclone/core";
export function requireWorker(request: Request) {
  const token = process.env.WORKER_INGEST_TOKEN;
  if (!token) throw new CoreError(503, "Worker ingestion is not configured");
  const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(request.headers.get("authorization") ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new CoreError(401, "Invalid worker token");
}
/** Shared manager token. Full user/role authentication remains deployment work. */
export function requireManager(request: Request) {
  const token = process.env.MANAGER_API_TOKEN;
  if (!token) throw new CoreError(503, "Manager API is not configured");
  const expected = Buffer.from(`Bearer ${token}`), actual = Buffer.from(request.headers.get("authorization") ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new CoreError(401, "Invalid manager token");
}
export async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > 1_000_000) throw new CoreError(413, "Request body too large");
  try { return JSON.parse(text); } catch { throw new CoreError(400, "Invalid JSON"); }
}
export async function respond(action: () => Promise<unknown>) {
  try { return Response.json(await action(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) {
    if (error instanceof CoreError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Core API failed:", error instanceof Error ? error.message : "unknown error");
    return Response.json({ error: "Core backend unavailable; check server configuration" }, { status: 503 });
  }
}
