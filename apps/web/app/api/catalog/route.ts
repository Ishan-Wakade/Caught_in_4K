import { getCore } from "../_core/runtime";
import { body, requireManager, respond } from "../_core/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { return respond(async () => (await getCore()).getCatalog()); }
export async function POST(request: Request) { return respond(async () => { requireManager(request); return (await getCore()).upsertCatalog(await body(request)); }); }
