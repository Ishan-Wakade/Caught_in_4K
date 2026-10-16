import { CoreError } from "@recyclone/core";
import { getCore } from "../../_core/runtime";
import { body, requireManager, respond } from "../../_core/http";
export const runtime = "nodejs";
export async function POST(request: Request, context: { params: Promise<{ event_id: string }> }) {
  return respond(async () => {
    requireManager(request);
    const input = await body(request);
    if (!input || typeof input !== "object" || !("business_id" in input) || (input.business_id !== null && typeof input.business_id !== "string")) throw new CoreError(400, "Expected business_id string or null");
    return (await getCore()).review((await context.params).event_id, input.business_id);
  });
}
