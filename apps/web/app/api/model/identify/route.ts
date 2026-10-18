import { handleLiveIdentify } from "@/lib/live/server";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export function POST(request: Request) { return handleLiveIdentify(request); }
