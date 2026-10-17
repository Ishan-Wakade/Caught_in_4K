/**
 * Pure state for the demo screen (layout B).
 *
 * User decision: the dashboard never switches scenes by itself. Only the
 * presenter switches (nav links or keys 1/2/3; each scene is its own page). Feed items update the content of
 * every scene, raise a toast for notable events, and mark other tabs as having
 * unseen updates so the presenter knows when to switch.
 */
import type { FeedItem } from "./types";

export type Scene = "live" | "bins" | "messages";
export const SCENES: Scene[] = ["live", "bins", "messages"];

export const TOAST_MS = 4000;

export type Toast = { text: string; tone: "alert" | "info"; until: number };

export type DirectorState = {
  /** The demo scene on screen, or null on a management page (every tab then collects unseen updates). */
  scene: Scene | null;
  /** Tabs with updates the presenter hasn't looked at yet. */
  unseen: Record<Scene, boolean>;
  toast: Toast | null;
  focusBinId: string | null;
  activeAlertId: string | null;
};

export function initialDirector(): DirectorState {
  return {
    scene: "live",
    unseen: { live: false, bins: false, messages: false },
    toast: null,
    focusBinId: null,
    activeAlertId: null,
  };
}

const AFFECTS: Partial<Record<FeedItem["type"], Scene[]>> = {
  disposal: ["live", "bins"],
  illustration_ready: ["bins"],
  bin_emptied: ["bins", "messages"],
  alert_opened: ["messages"],
  message_sent: ["messages"],
  reply_received: ["messages"],
  intervention_recorded: ["messages"],
};

const TOAST_TONE: Partial<Record<FeedItem["type"], Toast["tone"]>> = {
  alert_opened: "alert",
  review_queued: "info",
  bin_emptied: "info",
  intervention_recorded: "info",
};

/** Apply one new feed item. Never changes `scene`. Backlog items from the first load should not be passed here. */
export function onFeedItem(prev: DirectorState, item: FeedItem, now: number): DirectorState {
  const s = expireToast(prev, now);
  const unseen = { ...s.unseen };
  for (const scene of AFFECTS[item.type] ?? []) if (scene !== s.scene) unseen[scene] = true;

  const tone = TOAST_TONE[item.type];
  return {
    ...s,
    unseen,
    toast: tone ? { text: item.summary, tone, until: now + TOAST_MS } : s.toast,
    focusBinId: item.ref.bin_id && (item.type === "disposal" || item.type === "bin_emptied") ? item.ref.bin_id : s.focusBinId,
    activeAlertId: item.ref.alert_id ?? s.activeAlertId,
  };
}

/** Advance time: expire the toast. */
export function tick(prev: DirectorState, now: number): DirectorState {
  return expireToast(prev, now);
}

/** Presenter pressed a tab or shortcut: the only way the scene changes. */
export function selectScene(prev: DirectorState, scene: Scene | null): DirectorState {
  if (prev.scene === scene && (!scene || !prev.unseen[scene])) return prev;
  return { ...prev, scene, unseen: scene ? { ...prev.unseen, [scene]: false } : prev.unseen };
}

export function dismissToast(prev: DirectorState): DirectorState {
  return { ...prev, toast: null };
}

function expireToast(s: DirectorState, now: number): DirectorState {
  return s.toast && s.toast.until <= now ? { ...s, toast: null } : s;
}
