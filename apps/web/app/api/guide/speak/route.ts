import { handleSpeak } from "@/lib/guide/server";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export function POST(request: Request) { return handleSpeak(request); }
