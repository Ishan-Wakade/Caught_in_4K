/**
 * SAMPLE DATA for the manager dashboard. No store runs the guide yet, so these announcements are generated (seeded,
 * so every load shows the same numbers). Each record is shaped like a line of the worker's Phase 1 guide log: one
 * announcement, i.e. one person's item on one visit to the bin area. Counts are what the system recognized and
 * announced, never which bin the item actually went into (one bin area per site, AGENTS.md).
 */

export type Destination = "compost" | "recycle" | "trash" | "none";

/** Fixed order everywhere (charts, legends, tables); colors checked with the dataviz palette validator. */
export const DESTINATIONS: Destination[] = ["compost", "recycle", "trash", "none"];
export const DEST_LABEL: Record<Destination, string> = { compost: "Compost", recycle: "Recycle", trash: "Trash", none: "Special disposal" };
export const DEST_COLOR: Record<Destination, string> = { compost: "#4A8539", recycle: "#3B72B4", trash: "#55574F", none: "#C8694A" };

/**
 * How the answer was reached. "unsure" and "late" were both announced as trash (team rule): the best answer was
 * below 50% confidence, or no answer was ready when the person reached the bins.
 */
export type Source = "catalog" | "new_item" | "unsure" | "late";
export const SOURCE_LABEL: Record<Source, string> = {
  catalog: "Catalog",
  new_item: "New item (AI suggestion)",
  unsure: "Not sure: said trash",
  late: "Too late: said trash",
};

export type Announcement = { at: number; site: string; camera: string; item: string; dest: Destination; source: Source };

export const COMPANY = "Example Kitchen";

export type Camera = { id: string; name: string };
export type Site = { id: string; name: string; cameras: Camera[]; perDay: number };

// Common Massachusetts and Cambridge streets, standing in for real store addresses (no store runs the guide yet).
export const SITES: Site[] = [
  { id: "mass-ave", name: "Massachusetts Avenue", perDay: 150, cameras: [{ id: "mass-ave-patio", name: "Patio bins" }, { id: "mass-ave-indoor", name: "Indoor bins" }] },
  { id: "brattle", name: "Brattle Street", perDay: 95, cameras: [{ id: "brattle-front", name: "Front bins" }] },
  { id: "mount-auburn", name: "Mount Auburn Street", perDay: 70, cameras: [{ id: "mount-auburn-bins", name: "Curbside bins" }] },
  { id: "western-ave", name: "Western Avenue", perDay: 60, cameras: [{ id: "western-ave-bins", name: "Alley bins" }] },
  { id: "beacon", name: "Beacon Street", perDay: 110, cameras: [{ id: "beacon-patio", name: "Patio bins" }, { id: "beacon-back", name: "Back bins" }] },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** "Now" for the sample (store-local time, kept in UTC fields so server and browser agree). */
export const NOW = Date.UTC(2026, 9, 17, 18, 0);

/** Camera health shown on the dashboard; the indoor camera went offline this afternoon, so it has no records since. */
export const CAMERA_OFFLINE_SINCE: Record<string, number> = { "mass-ave-indoor": NOW - 2 * HOUR - 48 * 60_000 };

/** Catalog items the sample uses, copied from worker/rules/cambridge-ma-2022.bins.json (sample.test.ts checks them). */
export const CATALOG: { id: string; name: string; dest: Exclude<Destination, "none">; basis: string; weight: number }[] = [
  { id: "item_generic_cup", name: "clear plastic cup", dest: "recycle", basis: "RECYCLE: plastic containers; no food or liquids", weight: 18 },
  { id: "item_generic_can", name: "aluminum can", dest: "recycle", basis: "RECYCLE: metal cans and foil", weight: 12 },
  { id: "item_generic_bottle", name: "plastic bottle", dest: "recycle", basis: "RECYCLE: plastic containers", weight: 10 },
  { id: "item_generic_container", name: "plastic container", dest: "recycle", basis: "RECYCLE: plastic containers", weight: 6 },
  { id: "item_generic_glass", name: "glass bottle", dest: "recycle", basis: "RECYCLE: glass bottles and jars", weight: 3 },
  { id: "item_generic_paper", name: "clean paper", dest: "recycle", basis: "RECYCLE: paper and cardboard", weight: 2 },
  { id: "item_napkin", name: "paper napkin", dest: "compost", basis: "COMPOST: napkins and paper towels", weight: 16 },
  { id: "item_generic_food", name: "food scraps", dest: "compost", basis: "COMPOST: all food scraps", weight: 9 },
  { id: "item_generic_paper_cup", name: "paper coffee cup", dest: "trash", basis: "Not listed under RECYCLE or COMPOST", weight: 11 },
  { id: "item_generic_box", name: "paper takeout box", dest: "trash", basis: "NOT recycling: paper takeout containers", weight: 8 },
  { id: "item_generic_wrapper", name: "snack wrapper", dest: "trash", basis: "NOT recycling: wrappers", weight: 7 },
  { id: "item_generic_utensil", name: "plastic cutlery", dest: "trash", basis: "Not listed under RECYCLE or COMPOST", weight: 6 },
  { id: "item_chip_bag", name: "chip bag", dest: "trash", basis: "NOT recycling: plastic bags/film, wrappers", weight: 4 },
  { id: "item_sauce_cup", name: "sauce cup with sauce", dest: "trash", basis: "NOT recycling: no food or liquids", weight: 3 },
];

/**
 * Item types the store's catalog doesn't have: described by the vision model, bin suggested by Jev from the local
 * rules. A suggestion is cached so repeats are fast, but it is not an approval; only a manager adds it to the catalog.
 */
export type Proposed = { id: string; name: string; suggested: Destination; confidence: number; basis: string; weight: number };
export const PROPOSED: Proposed[] = [
  { id: "p_lid", name: "plastic cup lid", suggested: "recycle", confidence: 0.71, basis: "RECYCLE: plastic containers", weight: 5 },
  { id: "p_foil", name: "aluminum foil wrap", suggested: "recycle", confidence: 0.86, basis: "RECYCLE: metal cans and foil", weight: 3 },
  { id: "p_packet", name: "sauce packet", suggested: "trash", confidence: 0.81, basis: "NOT recycling: wrappers", weight: 3 },
  { id: "p_straw", name: "paper straw", suggested: "trash", confidence: 0.62, basis: "COMPOST lists only food, napkins, paper towels", weight: 2 },
  { id: "p_fork", name: "compostable fork", suggested: "compost", confidence: 0.42, basis: "COMPOST lists compostable bags, not utensils", weight: 1.5 },
  { id: "p_battery", name: "battery", suggested: "none", confidence: 0.95, basis: "SPECIAL: batteries: Recycle Center", weight: 0.35 },
  { id: "p_vape", name: "vape pen", suggested: "none", confidence: 0.93, basis: "SPECIAL: small electronics: Recycle Center", weight: 0.25 },
];

export const LATE_ITEM = "not identified in time";
const LATE_SHARE = 0.04;
/** Share of visits per opening hour, 7 am to 9 pm (lunch and dinner peaks). */
const HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21];
const HOUR_WEIGHT = [2, 4, 5, 4, 6, 12, 14, 8, 5, 4, 6, 10, 9, 5, 3];
const DAYS = 60;

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: T[], weights: number[]): T {
  let r = rand() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function generate(): Announcement[] {
  const rand = mulberry32(17);
  const kinds = [...CATALOG.map((c) => ({ catalog: c })), ...PROPOSED.map((p) => ({ proposed: p }))];
  const kindWeights = [...CATALOG.map((c) => c.weight), ...PROPOSED.map((p) => p.weight)];
  const out: Announcement[] = [];
  const today = startOfDay(NOW);
  for (let d = DAYS - 1; d >= 0; d--) {
    const day = today - d * DAY;
    const weekend = [0, 6].includes(new Date(day).getUTCDay());
    for (const site of SITES) {
      const n = Math.round(site.perDay * (weekend ? 0.75 : 1) * (0.85 + 0.3 * rand()));
      for (let i = 0; i < n; i++) {
        const at = day + pick(rand, HOURS, HOUR_WEIGHT) * HOUR + Math.floor(rand() * 60) * 60_000;
        const camera = site.cameras.length > 1 && rand() < 0.4 ? site.cameras[1].id : site.cameras[0].id;
        if (at > NOW || at >= (CAMERA_OFFLINE_SINCE[camera] ?? Infinity)) continue;
        const base = { at, site: site.id, camera };
        if (rand() < LATE_SHARE) {
          out.push({ ...base, item: LATE_ITEM, dest: "trash", source: "late" });
          continue;
        }
        const k = pick(rand, kinds, kindWeights);
        if ("catalog" in k) out.push({ ...base, item: k.catalog.name, dest: k.catalog.dest, source: "catalog" });
        else if (k.proposed.confidence < 0.5) out.push({ ...base, item: k.proposed.name, dest: "trash", source: "unsure" });
        else out.push({ ...base, item: k.proposed.name, dest: k.proposed.suggested, source: "new_item" });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export const ANNOUNCEMENTS: Announcement[] = generate();

// ---- slicing ------------------------------------------------------------------------------------------------------

export type Range = "today" | "7d" | "30d";
export const RANGE_LABEL: Record<Range, string> = { today: "Today", "7d": "Last 7 days", "30d": "Last 30 days" };
const PREVIOUS_LABEL: Record<Range, string> = { today: "yesterday at this time", "7d": "the 7 days before", "30d": "the 30 days before" };

export function startOfDay(t: number): number {
  return t - (t % DAY);
}

export type Window = { from: number; to: number; prevFrom: number; prevTo: number; previousLabel: string };

export function windowFor(range: Range): Window {
  const today = startOfDay(NOW);
  const days = range === "today" ? 1 : range === "7d" ? 7 : 30;
  const from = today - (days - 1) * DAY;
  const span = range === "today" ? NOW - today : days * DAY;
  const prevFrom = from - days * DAY;
  return { from, to: NOW, prevFrom, prevTo: prevFrom + span, previousLabel: PREVIOUS_LABEL[range] };
}

export function slice(site: string, from: number, to: number): Announcement[] {
  return ANNOUNCEMENTS.filter((a) => a.at >= from && a.at <= to && (site === "all" || a.site === site));
}

export function countBy<K extends string>(rows: Announcement[], key: (a: Announcement) => K): Map<K, number> {
  const m = new Map<K, number>();
  for (const a of rows) m.set(key(a), (m.get(key(a)) ?? 0) + 1);
  return m;
}

export type Bucket = { label: string; long: string; counts: Record<Destination, number>; total: number };

/** Per hour (today) or per day (7 / 30 days), split by destination. */
export function buckets(rows: Announcement[], range: Range): Bucket[] {
  const w = windowFor(range);
  const edges =
    range === "today"
      ? HOURS.map((h) => w.from + h * HOUR)
      : Array.from({ length: (w.to - w.from) / DAY + 1 }, (_, i) => w.from + i * DAY).filter((t) => t <= w.to);
  const size = range === "today" ? HOUR : DAY;
  return edges.map((start) => {
    const counts = { compost: 0, recycle: 0, trash: 0, none: 0 } as Record<Destination, number>;
    for (const a of rows) if (a.at >= start && a.at < start + size) counts[a.dest]++;
    const total = DESTINATIONS.reduce((s, d) => s + counts[d], 0);
    return range === "today" ? { label: hourLabel(start), long: `${hourLabel(start)} to ${hourLabel(start + HOUR)}`, counts, total } : { label: dayLabel(start), long: dayLabel(start, true), counts, total };
  });
}

export function byHourOfDay(rows: Announcement[]): { label: string; value: number }[] {
  return HOURS.map((h) => ({ label: hourLabel(h * HOUR), value: rows.filter((a) => new Date(a.at).getUTCHours() === h).length }));
}

// ---- formatting (store-local times live in UTC fields) -------------------------------------------------------------

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...o });
const DAY_FMT = fmt({ month: "short", day: "numeric" });
const DAY_LONG_FMT = fmt({ weekday: "short", month: "short", day: "numeric" });
const TIME_FMT = fmt({ hour: "numeric", minute: "2-digit" });

export function dayLabel(t: number, long = false): string {
  return (long ? DAY_LONG_FMT : DAY_FMT).format(t);
}

export function hourLabel(t: number): string {
  const h = new Date(t).getUTCHours();
  return `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;
}

export function timeLabel(t: number): string {
  return startOfDay(t) === startOfDay(NOW) ? TIME_FMT.format(t) : `${DAY_FMT.format(t)}, ${TIME_FMT.format(t)}`;
}

export function ago(t: number): string {
  const min = Math.round((NOW - t) / 60_000);
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / (24 * 60))} days ago`;
}

export function siteName(id: string): string {
  return SITES.find((s) => s.id === id)?.name ?? id;
}

export function cameraName(id: string): string {
  for (const s of SITES) for (const c of s.cameras) if (c.id === id) return c.name;
  return id;
}
