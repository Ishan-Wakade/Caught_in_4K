"use client";

import { RANGE_LABEL, SITES, type Range } from "@/lib/dashboard/sample";
import { useFilters } from "./DashboardContext";

function Toggles<T extends string>({ label, options, value, onChange }: { label: string; options: [T, string][]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap rounded-lg border border-rule-soft bg-card p-0.5">
      {options.map(([v, text]) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className={`min-h-9 cursor-pointer rounded-md px-3 text-[15px] ${v === value ? "bg-forest font-bold text-card" : "font-medium text-ink-2 hover:text-ink"}`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** One row above everything it scopes: site, then date range. */
export function Filters({ showRange = true }: { showRange?: boolean }) {
  const { site, setSite, range, setRange } = useFilters();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Toggles label="Site" value={site} onChange={setSite} options={[["all", "All sites"], ...SITES.map((s): [string, string] => [s.id, s.name])]} />
      {showRange && <Toggles label="Date range" value={range} onChange={setRange} options={(Object.keys(RANGE_LABEL) as Range[]).map((r) => [r, RANGE_LABEL[r]])} />}
    </div>
  );
}
