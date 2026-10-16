import { getCore } from "../../_core/runtime";
import { requireManager, respond } from "../../_core/http";
export const runtime = "nodejs";
export async function POST(request: Request) { return respond(async () => { requireManager(request); return (await getCore()).resetDemo(); }); }
