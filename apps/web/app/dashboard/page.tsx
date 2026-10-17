"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Legend, Section, StackedColumns, Swatch, TableView, num, pct } from "@/components/dashboard/charts";
import { useFilters } from "@/components/dashboard/DashboardContext";
import { Filters } from "@/components/dashboard/Filters";
import {
  CAMERA_OFFLINE_SINCE,
  DEST_LABEL,
  DESTINATIONS,
  RANGE_LABEL,
  SITES,
  buckets,
  countBy,
  slice,
  timeLabel,
  windowFor,
  type Destination,
} from "@/lib/dashboard/sample";

/** Only shown when something needs attention. */
function OfflineCameras({ site }: { site: string }) {
  const off = SITES.filter((s) => site === "all" || s.id === site).flatMap((s) =>
    s.cameras.filter((c) => CAMERA_OFFLINE_SINCE[c.id]).map((c) => ({ ...c, site: s.name })),
  );
  if (!off.length) return null;
  return (
    <Link href="/dashboard/sites" className="flex w-max items-center gap-2.5 text-[15px] font-bold text-clay-deep no-underline hover:text-clay-deep">
      <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-clay-deep" />
      {off.map((c) => `${c.site} · ${c.name} offline since ${timeLabel(CAMERA_OFFLINE_SINCE[c.id])}`).join("; ")}
    </Link>
  );
}

function Stat({ label, value, sub, dest }: { label: string; value: string; sub?: string; dest?: Destination }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="flex items-center gap-2 text-[15px] text-ink-2">
        {dest && <Swatch dest={dest} />}
        {label}
      </span>
      <span className="font-display text-[44px] leading-none font-bold tracking-[-0.02em] text-ink">{value}</span>
      {sub && <span className="text-sm text-muted">{sub}</span>}
    </div>
  );
}

export default function OverviewPage() {
  const { site, range } = useFilters();
  const w = windowFor(range);
  const rows = useMemo(() => slice(site, w.from, w.to), [site, w.from, w.to]);
  const prev = useMemo(() => slice(site, w.prevFrom, w.prevTo), [site, w.prevFrom, w.prevTo]);

  const total = rows.length;
  const change = prev.length ? Math.round((100 * (total - prev.length)) / prev.length) : null;
  const byDest = countBy(rows, (a) => a.dest);
  const unsure = rows.filter((a) => a.source === "unsure" || a.source === "late").length;
  const series = buckets(rows, range);
  const top = (d: Destination) =>
    [...countBy(rows.filter((a) => a.dest === d && a.source !== "late" && a.source !== "unsure"), (a) => a.item)]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="m-0 font-display text-[40px] leading-none font-bold">Overview</h1>
          <Filters />
        </div>
        <OfflineCameras site={site} />
      </div>

      <Section>
        <div className="grid grid-cols-2 gap-x-10 gap-y-8 sm:grid-cols-3 lg:grid-cols-[1.6fr_repeat(5,1fr)]">
          <div className="col-span-2 flex flex-col gap-1.5 sm:col-span-3 lg:col-span-1">
            <span className="text-[15px] text-ink-2" title="Items the camera recognized and the speaker announced, one per person per visit">
              Items guided · {RANGE_LABEL[range].toLowerCase()}
            </span>
            <span className="font-display text-[80px] leading-[0.9] font-extrabold tracking-[-0.03em] text-forest">{num(total)}</span>
            {change !== null && (
              <span className="text-sm text-muted">
                {change >= 0 ? "▲" : "▼"} {Math.abs(change)}% vs {w.previousLabel}
              </span>
            )}
          </div>
          {(["recycle", "compost", "trash"] as Destination[]).map((d) => (
            <Stat key={d} label={DEST_LABEL[d]} dest={d} value={pct(byDest.get(d) ?? 0, total)} sub={`${num(byDest.get(d) ?? 0)} items`} />
          ))}
          <Stat label="Special" dest="none" value={num(byDest.get("none") ?? 0)} sub="Hazardous items" />
          <Stat label="Not sure" value={pct(unsure, total)} sub={`${num(unsure)} told trash`} />
        </div>
      </Section>

      <Section title={range === "today" ? "Items by hour" : "Items by day"}>
        <Legend />
        <StackedColumns data={series} labelEvery={range === "30d" ? 5 : 1} />
        <TableView head={[range === "today" ? "Hour" : "Day", ...DESTINATIONS.map((d) => DEST_LABEL[d]), "Total"]} rows={series.map((b) => [b.long, ...DESTINATIONS.map((d) => b.counts[d]), b.total])} />
      </Section>

      <Section title="Top items">
        <div className="grid gap-x-12 gap-y-8 md:grid-cols-3">
          {(["recycle", "compost", "trash"] as Destination[]).map((d) => (
            <ul key={d} className="m-0 flex list-none flex-col p-0">
              <li className="flex items-center gap-2 pb-2 text-sm font-bold text-ink-2">
                <Swatch dest={d} />
                {DEST_LABEL[d]}
              </li>
              {top(d).map(([item, n], i) => (
                <li key={item} className={`flex justify-between gap-4 py-2 text-base ${i ? "border-t border-rule-soft" : ""}`}>
                  <span className="text-ink">{item}</span>
                  <span className="font-mono text-ink-2 tabular-nums">{num(n)}</span>
                </li>
              ))}
            </ul>
          ))}
        </div>
      </Section>
    </>
  );
}
