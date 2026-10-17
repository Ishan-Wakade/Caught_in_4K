import { listApproved } from "@/lib/dashboard/db";
import { respond } from "../../_core/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() { return respond(async () => listApproved()); }
