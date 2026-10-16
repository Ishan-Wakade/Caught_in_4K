import { getCore } from "../_core/runtime";
import { respond } from "../_core/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) { return respond(async () => (await getCore()).getFeed(new URL(request.url).searchParams.get("after") ?? "")); }
