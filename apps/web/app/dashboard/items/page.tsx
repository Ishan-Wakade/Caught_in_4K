"use client";

import { useMemo, useState } from "react";
import { Section, Swatch, num } from "@/components/dashboard/charts";
import { useFilters } from "@/components/dashboard/DashboardContext";
import { Filters } from "@/components/dashboard/Filters";
import { DEST_COLOR, DEST_LABEL, DESTINATIONS, slice, windowFor, type Destination, type Source } from "@/lib/dashboard/sample";

type Row = { item: string; dest: Destination; source: Source; count: number };

const HOW: Record<Source, string> = { catalog: "", new_item: "New", unsure: "Not sure", late: "Too late" };

export default function ItemsPage() {
  const { site, range } = useFilters();
  const [only, setOnly] = useState<Destination | "all">("all");
  const w = windowFor(range);
  const all = useMemo(() => slice(site, w.from, w.to), [site, w.from, w.to]);

  const rows = useMemo(() => {
    const m = new Map<string, Row>();
    for (const a of all) {
      const key = `${a.item}|${a.dest}|${a.source}`;
      const r = m.get(key) ?? { item: a.item, dest: a.dest, source: a.source, count: 0 };
      r.count++;
      m.set(key, r);
    }
    return [...m.values()].filter((r) => only === "all" || r.dest === only).sort((a, b) => b.count - a.count);
  }, [all, only]);
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <h1 className="m-0 font-display text-[40px] leading-none font-bold">Items</h1>
          <Filters />
        </div>
        <div role="group" aria-label="Destination" className="flex flex-wrap items-center gap-2">
          {(["all", ...DESTINATIONS] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={only === d}
              onClick={() => setOnly(d)}
              className={`flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-[15px] ${
                only === d ? "border-forest bg-forest font-bold text-card" : "border-rule-soft bg-card font-medium text-ink-2 hover:text-ink"
              }`}
            >
              {d !== "all" && <Swatch dest={d} />}
              {d === "all" ? "Everything" : DEST_LABEL[d]}
            </button>
          ))}
        </div>
      </div>

      <Section>
        <ul className="m-0 flex list-none flex-col divide-y divide-rule-soft p-0">
          {rows.map((r) => (
            <li key={`${r.item}|${r.dest}|${r.source}`} className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_3.5rem] items-center gap-4 py-2.5 text-[15px]">
              <span className="flex items-center gap-2.5 text-ink">
                <Swatch dest={r.dest} />
                {r.item}
                {HOW[r.source] && <span className="text-sm text-muted">{HOW[r.source]}</span>}
              </span>
              <div className="h-1.5 rounded-r-[4px]" style={{ width: `${Math.max(2, (100 * r.count) / max)}%`, background: DEST_COLOR[r.dest] }} />
              <span className="text-right font-mono text-ink-2 tabular-nums">{num(r.count)}</span>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
