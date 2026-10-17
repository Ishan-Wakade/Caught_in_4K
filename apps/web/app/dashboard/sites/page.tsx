"use client";

import { Section, num } from "@/components/dashboard/charts";
import { ANNOUNCEMENTS, CAMERA_OFFLINE_SINCE, SITES, ago, slice, timeLabel, windowFor } from "@/lib/dashboard/sample";

export default function SitesPage() {
  const w = windowFor("7d");
  const week = slice("all", w.from, w.to);
  return (
    <>
      <h1 className="m-0 font-display text-[40px] leading-none font-bold">Sites</h1>
      {SITES.map((s) => (
        <Section key={s.id} title={s.name}>
          <ul className="m-0 flex list-none flex-col divide-y divide-rule-soft p-0">
            {s.cameras.map((c) => {
              const off = CAMERA_OFFLINE_SINCE[c.id];
              const last = [...ANNOUNCEMENTS].reverse().find((a) => a.camera === c.id);
              return (
                <li key={c.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-1 py-2.5 text-[15px] sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <span className="flex items-center gap-2.5 text-ink">
                    <span aria-hidden="true" className={`h-2 w-2 rounded-full ${off ? "bg-clay-deep" : "bg-compost"}`} />
                    {c.name}
                  </span>
                  <span className={off ? "font-bold text-clay-deep" : "text-ink-2"}>{off ? `Offline since ${timeLabel(off)}` : "Online"}</span>
                  <span className="text-muted">{last ? `Last announcement ${ago(last.at)}` : ""}</span>
                  <span className="text-right font-mono text-ink-2 tabular-nums" title="Items announced in the last 7 days">
                    {num(week.filter((a) => a.camera === c.id).length)} this week
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      ))}
    </>
  );
}
