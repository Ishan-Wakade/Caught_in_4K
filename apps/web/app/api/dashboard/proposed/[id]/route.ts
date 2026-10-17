import { CoreError } from "@recyclone/core";
import { decide } from "@/lib/dashboard/db";
import { body, requireManager, respond } from "../../../_core/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return respond(async () => {
    requireManager(request);
    const input = await body(request);
    if (!input || typeof input !== "object" || !("decision" in input) || (input.decision !== "approved" && input.decision !== "rejected")) {
      throw new CoreError(400, 'Expected decision: "approved" or "rejected"');
    }
    const row = await decide((await context.params).id, input.decision);
    if (!row) throw new CoreError(404, "Unknown item");
    return row;
  });
}
