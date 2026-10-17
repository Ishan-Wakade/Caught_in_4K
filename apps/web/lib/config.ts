/**
 * `NEXT_PUBLIC_DATA_SOURCE` is J-local: `mock` (default until I's API exists)
 * runs a scripted in-browser backend; `api` calls the real `/api/*` routes.
 */
export const DATA_SOURCE: "mock" | "api" =
  process.env.NEXT_PUBLIC_DATA_SOURCE === "api" ? "api" : "mock";

/** Base URL of the CV worker (contract §4). Empty when not configured. */
export const WORKER_URL = (process.env.NEXT_PUBLIC_WORKER_URL ?? "").replace(/\/$/, "");

export function evidenceUrl(uri: string): string | null {
  if (!WORKER_URL) return null;
  // The contract sample uri already starts with "evidence/" while §4 serves
  // `/evidence/<path>`; accept both until E settles it.
  return `${WORKER_URL}/evidence/${uri.replace(/^\/?(evidence\/)?/, "")}`;
}

/**
 * `NEXT_PUBLIC_DEMO_TOOLS=true` turns on the presenter's tools: "Reset demo",
 * keys 1/2/3, and the "reply as manager (mocked)" box. Off by default, so the
 * site is what a manager sees (user decision, 2026-10-16).
 */
export const DEMO_TOOLS = process.env.NEXT_PUBLIC_DEMO_TOOLS === "true";

export const FEED_POLL_MS = 1000;

/** Product name shown in the UI (user's choice, 2026-10-16; all-caps per 2026-10-17). Code and packages keep "recyclone". */
export const APP_NAME = "CAUGHT IN 4K";
