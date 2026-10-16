import { getCore } from "../../_core/runtime";
import { respond } from "../../_core/http";
export const runtime = "nodejs";
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { return respond(async () => (await getCore()).getItem((await context.params).id)); }
