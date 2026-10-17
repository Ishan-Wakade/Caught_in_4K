"use client";

import { useState, type ReactNode } from "react";
import { DEST_COLOR, DEST_LABEL, DESTINATIONS, type Bucket, type Destination } from "@/lib/dashboard/sample";
import { num, pct } from "@/lib/dashboard/format";

/**
 * Hand-built HTML charts for the dashboard (dataviz skill specs): bars <= 24 px with 4 px rounded ends, 2 px surface
 * gaps between stacked segments, hairline solid gridlines, text in ink tokens (never the series color), a legend for
 * two or more series, and a table view for every chart. Few, soft panels in the public site's type.
 */

export { num, pct };

export function Section({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-w-0 flex-col gap-5 rounded-2xl bg-card p-6 sm:p-8 ${className}`}>
      {title && <h2 className="m-0 font-display text-[22px] leading-none font-bold text-ink">{title}</h2>}
      {children}
    </section>
  );
}

export function Swatch({ dest }: { dest: Destination }) {
  return <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: DEST_COLOR[dest] }} />;
}

export function Legend({ dests = DESTINATIONS }: { dests?: Destination[] }) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-5 gap-y-1 p-0 text-sm text-ink-2">
      {dests.map((d) => (
        <li key={d} className="flex items-center gap-2">
          <Swatch dest={d} />
          {DEST_LABEL[d]}
        </li>
      ))}
    </ul>
  );
}

/** Up to ~4 clean gridlines from 0 to a round max. */
function ticks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  return Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
}

function compact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}K` : String(n);
}

function Tip({ children, align }: { children: ReactNode; align: "left" | "center" | "right" }) {
  const pos = align === "left" ? "left-0" : align === "right" ? "right-0" : "left-1/2 -translate-x-1/2";
  return (
    <div role="tooltip" className={`pointer-events-none absolute bottom-full z-10 mb-2 w-max min-w-36 rounded-lg bg-night px-3 py-2 text-left text-card shadow-lg ${pos}`}>
      {children}
    </div>
  );
}

/** Columns over time, stacked by destination. Hover or focus a column for every destination's count. */
export function StackedColumns({ data, height = 220, labelEvery = 1 }: { data: Bucket[]; height?: number; labelEvery?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const t = ticks(Math.max(1, ...data.map((b) => b.total)));
  const top = t[t.length - 1] || 1;
  return (
    <div className="flex flex-col">
      <div className="relative ml-9" style={{ height }}>
        {t.map((v) => (
          <div key={v} className="absolute inset-x-0 border-t border-rule-soft" style={{ bottom: `${(100 * v) / top}%` }}>
            <span className="absolute -top-2 -left-9 w-7 text-right font-mono text-[11px] text-muted-2 tabular-nums">{compact(v)}</span>
          </div>
        ))}
        <div className="absolute inset-0 flex items-end">
          {data.map((b, i) => (
            <button
              key={b.long}
              type="button"
              aria-label={`${b.long}: ${b.total} items`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              className={`relative flex h-full flex-1 cursor-default flex-col items-center justify-end rounded-t-md outline-offset-2 ${hover === i ? "bg-paper" : ""}`}
            >
              <div className="flex w-[70%] max-w-6 flex-col-reverse gap-[2px] overflow-hidden rounded-t-[4px]" style={{ height: `${(100 * b.total) / top}%` }}>
                {DESTINATIONS.map((d) => (b.counts[d] ? <div key={d} style={{ flexGrow: b.counts[d], flexBasis: 0, background: DEST_COLOR[d] }} /> : null))}
              </div>
              {hover === i && (
                <Tip align={i < data.length * 0.2 ? "left" : i > data.length * 0.8 ? "right" : "center"}>
                  <div className="pb-1 text-xs text-[#D9DCD0]">{b.long}</div>
                  <div className="pb-1 text-base font-bold">{num(b.total)} items</div>
                  {DESTINATIONS.map((d) => (
                    <div key={d} className="flex items-center gap-2 text-[13px]">
                      <span aria-hidden="true" className="h-[2px] w-3" style={{ background: DEST_COLOR[d] }} />
                      <span className="font-bold">{num(b.counts[d])}</span>
                      <span className="text-[#D9DCD0]">{DEST_LABEL[d]}</span>
                    </div>
                  ))}
                </Tip>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="ml-9 flex pt-1.5">
        {data.map((b, i) => (
          <span key={b.long} className="flex-1 text-center font-mono text-[11px] whitespace-nowrap text-muted-2">
            {i % labelEvery === 0 ? b.label : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The table-view twin of a chart, tucked behind one small link. */
export function TableView({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <details className="text-sm">
      <summary className="w-max cursor-pointer text-sm text-muted hover:text-ink">View as table</summary>
      <div className="mt-2 max-h-72 overflow-auto">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h} className="sticky top-0 border-b border-rule bg-card py-1.5 pr-4 font-medium text-muted">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r[0])} className="border-b border-rule-soft">
                {r.map((c, i) => (
                  <td key={i} className={`py-1 pr-4 ${typeof c === "number" ? "font-mono tabular-nums" : ""}`}>
                    {typeof c === "number" ? num(c) : c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
