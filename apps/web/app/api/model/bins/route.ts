import { handleLiveBins } from "@/lib/live/server";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export function POST(request: Request) { return handleLiveBins(request); }
