import { getCore } from "../_core/runtime";
import { body, requireWorker, respond } from "../_core/http";
export const runtime = "nodejs";
export async function POST(request: Request) { return respond(async () => { requireWorker(request); return (await getCore()).ingest(await body(request)); }); }
