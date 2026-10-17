/** Plain formatters shared by server and client dashboard pages — kept out of charts.tsx, which is "use client". */

const nf = new Intl.NumberFormat("en-US");
export const num = (n: number) => nf.format(n);
export const pct = (part: number, whole: number) => {
  const p = whole ? Math.round((100 * part) / whole) : 0;
  return p === 0 && part > 0 ? "<1%" : `${p}%`;
};
