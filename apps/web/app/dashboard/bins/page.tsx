"use client";

import { Section, num } from "@/components/dashboard/charts";
import { useFilters } from "@/components/dashboard/DashboardContext";
import { Filters } from "@/components/dashboard/Filters";
import { DEST_COLOR, DEST_LABEL, DESTINATIONS, SITES, countBy, slice, windowFor, type Destination } from "@/lib/dashboard/sample";

/**
 * Destination glyph, one size for all four so the card headers line up. The bins are the shape of the /bins drawing,
 * with no fill level (there's no fullness data here); special disposal isn't a bin, so it gets a warning sign.
 */
function DestIcon({ dest }: { dest: Destination }) {
  const c = DEST_COLOR[dest];
  return (
    <svg aria-hidden="true" width="20" height="22" viewBox="0 0 100 110" className="shrink-0">
      {dest === "none" ? (
        <>
          <path d="M50 8 Q55 8 58 13 L96 92 Q99 100 90 102 L10 102 Q1 100 4 92 L42 13 Q45 8 50 8 Z" fill={c} />
          <rect x="44" y="36" width="12" height="36" rx="6" fill="#FBF8F1" />
          <circle cx="50" cy="86" r="7" fill="#FBF8F1" />
        </>
      ) : (
        <>
          <rect x="37" y="4" width="26" height="12" rx="6" fill={c} />
          <rect x="6" y="14" width="88" height="14" rx="7" fill={c} />
          <path d="M14 34 L86 34 L80 100 Q79 106 73 106 L27 106 Q21 106 20 100 Z" fill={c} />
        </>
      )}
    </svg>
  );
}

/** One bin's count + most-announced items for a site, in the selected window. */
function BinCard({ dest, total, top }: { dest: Destination; total: number; top: [string, number][] }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col rounded-xl bg-paper-deep p-5">
      <span className="flex h-6 items-center justify-between gap-2 text-[15px] font-bold text-ink-2">
        {DEST_LABEL[dest]}
        <DestIcon dest={dest} />
      </span>
      <span className="mt-3 font-display text-[34px] leading-none font-extrabold text-ink tabular-nums">{num(total)}</span>
      <span className="mt-1 text-xs text-muted">items this range</span>
      <ul className="m-0 mt-4 flex list-none flex-col divide-y divide-rule-soft border-t border-rule-soft p-0">
        {top.length === 0 && <li className="py-2 text-sm text-muted">Nothing yet</li>}
        {top.map(([item, n]) => (
          <li key={item} className="flex justify-between gap-3 py-2 text-sm">
            <span className="text-ink">{item}</span>
            <span className="text-ink-2 tabular-nums">{num(n)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function BinsPage() {
  const { site, range } = useFilters();
  const w = windowFor(range);
  const sites = site === "all" ? SITES : SITES.filter((s) => s.id === site);

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 font-display text-[40px] leading-none font-bold">Bins</h1>
          <span className="text-[15px] text-ink-2">How many items were categorized into each bin at each site</span>
        </div>
        <Filters />
      </div>
      {sites.map((s) => {
        const rows = slice(s.id, w.from, w.to);
        return (
          <Section key={s.id} title={s.name}>
            <div className="flex flex-wrap gap-4">
              {DESTINATIONS.map((d) => {
                const inDest = rows.filter((a) => a.dest === d);
                const top = [...countBy(inDest, (a) => a.item)].sort((a, b) => b[1] - a[1]).slice(0, 5);
                return <BinCard key={d} dest={d} total={inDest.length} top={top} />;
              })}
            </div>
          </Section>
        );
      })}
    </>
  );
}
