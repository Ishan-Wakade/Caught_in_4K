import { getCore } from "../_core/runtime";
import { respond } from "../_core/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { return respond(async () => (await getCore()).getReviews()); }
