import type { AlertState, BinType, Outcome, Score } from "./types";

/** Never turns missing data into 0%. */
export function scoreLabel(score: Score): string {
  return score.status === "insufficient_data" ? "not enough data" : `${Math.round(score.percent)}%`;
}

export function fullnessPercent(fullness: number): number {
  return Math.round(fullness * 100);
}

export function time(isoString: string | null | undefined): string {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function shortTime(isoString: string | null | undefined): string {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function dayTime(isoString: string | null | undefined): string {
  if (!isoString) return "—";
  const d = new Date(isoString);
  return `${d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}, ${shortTime(isoString)}`;
}

export function day(isoString: string | null | undefined): string {
  if (!isoString) return "—";
  return new Date(isoString).toLocaleDateString([], { month: "short", day: "numeric" });
}

export const BIN_LABEL: Record<BinType, string> = { trash: "Trash", recycling: "Recycling", compost: "Compost" };

/** Bin colours from the design: dot/fill, darker text, and lighter tints for dark backgrounds. */
export const BIN_HEX: Record<BinType, { fill: string; ink: string; onDark: string; body: string; layer1: string; layer2: string }> = {
  trash: { fill: "#5A5C58", ink: "#45473F", onDark: "#A3A59F", body: "#E4E2DC", layer1: "#BDBEB7", layer2: "#A9AAA3" },
  recycling: { fill: "#4A77A3", ink: "#2F5C88", onDark: "#8DB3D9", body: "#E1E8EF", layer1: "#B7CADC", layer2: "#9FB7CE" },
  compost: { fill: "#4A8539", ink: "#3B6F2D", onDark: "#8CC474", body: "#E2ECD8", layer1: "#BFD6AE", layer2: "#A7C792" },
};

export const BIN_DOT: Record<BinType, string> = { trash: "bg-trash", recycling: "bg-recycling", compost: "bg-compost" };
export const BIN_INK: Record<BinType, string> = { trash: "text-trash-ink", recycling: "text-recycling-ink", compost: "text-compost-ink" };

export const ALERT_STATE_LABEL: Record<AlertState, string> = {
  sent: "Sent",
  follow_up_sent: "Follow-up sent",
  acknowledged: "Acknowledged",
  action_confirmed: "Action confirmed",
  emptied: "Emptied",
  needs_clarification: "Asked to clarify",
};

/** Feed items carry `outcome` when known; otherwise fall back to core's summary text. */
export function outcomeOf(item: { outcome?: Outcome; summary: string }): Outcome | null {
  if (item.outcome) return item.outcome;
  const m = item.summary.match(/\((correct|incorrect|unassessable)\b/i);
  return m ? (m[1].toLowerCase() as Outcome) : null;
}

export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
