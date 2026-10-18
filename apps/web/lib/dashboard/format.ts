/** Plain formatters shared by server and client dashboard pages — kept out of charts.tsx, which is "use client". */

const nf = new Intl.NumberFormat("en-US");
export const num = (n: number) => nf.format(n);
export const pct = (part: number, whole: number) => {
  const p = whole ? Math.round((100 * part) / whole) : 0;
  return p === 0 && part > 0 ? "<1%" : `${p}%`;
};

export function ago(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 24 * 60) return `${Math.round(min / 60)} h ago`;
  return `${Math.round(min / (24 * 60))} days ago`;
}
