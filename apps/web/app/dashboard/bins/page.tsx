"use client";

import { Legend, Section, Swatch, num } from "@/components/dashboard/charts";
import { useFilters } from "@/components/dashboard/DashboardContext";
import { Filters } from "@/components/dashboard/Filters";
import { CAMERA_OFFLINE_SINCE, DEST_LABEL, DESTINATIONS, SITES, countBy, slice, timeLabel, windowFor, type Destination } from "@/lib/dashboard/sample";

/** One bin's count + most-announced items for a site, in the selected window. */
function BinCard({ dest, total, top }: { dest: Destination; total: number; top: [string, number][] }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 rounded-xl bg-paper-deep p-4">
      <span className="flex items-center gap-2 text-[15px] font-bold text-ink-2">
        <Swatch dest={dest} />
        {DEST_LABEL[dest]}
      </span>
      <span className="font-display text-[34px] leading-none font-extrabold text-ink">{num(total)}</span>
      <span className="text-xs text-muted">items this range</span>
      <ul className="m-0 flex list-none flex-col divide-y divide-rule-soft p-0">
        {top.length === 0 && <li className="py-1.5 text-sm text-muted">Nothing yet</li>}
        {top.map(([item, n]) => (
          <li key={item} className="flex justify-between gap-3 py-1.5 text-sm">
            <span className="text-ink">{item}</span>
            <span className="font-mono text-ink-2 tabular-nums">{num(n)}</span>
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
          <span className="text-[15px] text-ink-2">One bin area per site · what the guide has sent to each bin</span>
        </div>
        <Filters />
      </div>
      <Legend />
      {sites.map((s) => {
        const rows = slice(s.id, w.from, w.to);
        const offline = s.cameras.filter((c) => CAMERA_OFFLINE_SINCE[c.id]);
        return (
          <Section key={s.id} title={s.name}>
            {offline.length > 0 && (
              <span className="flex w-max items-center gap-2 text-sm font-bold text-clay-deep">
                <span aria-hidden="true" className="h-2 w-2 rounded-full bg-clay-deep" />
                {offline.map((c) => `${c.name} offline since ${timeLabel(CAMERA_OFFLINE_SINCE[c.id])}`).join("; ")}
              </span>
            )}
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
