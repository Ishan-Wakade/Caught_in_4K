/**
 * The area manager's API token (`MANAGER_API_TOKEN` on the server), required by
 * I's and S's write routes (catalog, reviews, demo reset, mock reply).
 *
 * Never bundled into the site: the dashboard asks for it once when a write is
 * refused, and keeps it only in this tab's sessionStorage.
 */
const KEY = "caught-in-4k.manager-token";

export function getManagerToken(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setManagerToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(KEY, token);
    else sessionStorage.removeItem(KEY);
  } catch {
    // Storage unavailable (private mode etc.): the token just won't persist.
  }
}

/** Ask the presenter for the token; returns null if they cancel. */
export function askForManagerToken(reason: string): string | null {
  if (typeof window === "undefined") return null;
  const t = window.prompt(`${reason}\n\nEnter the manager token (MANAGER_API_TOKEN). It's kept only in this browser tab.`);
  const token = t?.trim() || null;
  setManagerToken(token);
  return token;
}
