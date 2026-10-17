"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useDisposals } from "@/hooks/useDisposals";
import { useResource } from "@/hooks/useResource";
import { api } from "@/lib/api";
import { BIN_LABEL, day, scoreLabel, shortTime, time } from "@/lib/format";
import type { BinType, Period } from "@/lib/types";
import { BinTag, Dot, Empty, LoadError, Mono } from "@/components/ui";

function Big({ label, p, tone }: { label: string; p: Period; tone: "before" | "after" }) {
  const known = p.score.status === "ok";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[13px] text-muted">{label}</span>
      <span
        className={`font-display leading-[0.82] font-extrabold tracking-[-0.03em] ${known ? "text-[136px]" : "text-5xl text-muted"} ${known && tone === "before" ? "text-[#7C8074]" : ""} ${known && tone === "after" ? "text-forest" : ""}`}
      >
        {scoreLabel(p.score)}
      </span>
      <span className="text-[13px] text-muted">
        {p.assessed_count} {p.assessed_count === 1 ? "drop" : "drops"} ·{" "}
        <Mono>
          {day(p.from)} {shortTime(p.from)} – {day(p.to)} {shortTime(p.to)}
        </Mono>
      </span>
    </div>
  );
}

export default function ItemPage() {
  const { id } = useParams<{ id: string }>();
  const { data: item, error, loaded } = useResource(() => api.item(id), id);
  const alerts = useResource(api.alerts);
  const disposals = useDisposals().filter((d) => d.item_id === id);

  if (!loaded) return <Empty title="Loading…" />;
  if (error) return <LoadError error={error} />;
  if (!item) return <Empty title="Item not found"><Link href="/catalog">Back to the catalog</Link></Empty>;

  const iv = item.interventions.at(-1);
  const alert = alerts.data?.alerts.find((a) => a.item_id === id);
  const assessed = disposals.filter((d) => d.outcome === "correct" || d.outcome === "incorrect");
  const wrongBins = new Map<BinType, number>();
  for (const d of assessed) if (d.outcome === "incorrect" && d.bin) wrongBins.set(d.bin, (wrongBins.get(d.bin) ?? 0) + 1);

  return (
    <div className="flex flex-1 flex-col">
      <section aria-label="Sorting for this item" className="flex-1 px-10 pt-4 pb-[22px]">
        <div className="mx-auto flex max-w-[1360px] flex-wrap gap-x-16 gap-y-6">
          <div className="flex min-w-0 flex-[3_1_680px] flex-col gap-4">
            <div className="flex flex-col gap-0.5">
              <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm">
                <Link href="/catalog" className="flex min-h-8 items-center">← Catalog</Link>
                <span aria-hidden="true" className="text-[#9A9C92]">/</span>
                <span className="text-muted">{item.business_name ?? "Generic packaging"}</span>
              </nav>
              <h1 className="m-0 font-display text-[34px] leading-[1.1] font-bold">{item.name}</h1>
            </div>

            {iv ? (
              <>
                <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
                  <Big label="before" p={iv.before} tone="before" />
                  <div className="flex flex-col items-center gap-1.5 pb-[34px]">
                    <span className="flex items-center gap-2 text-[13px] font-bold text-forest">
                      <Dot className="bg-forest" />
                      action confirmed · {day(iv.confirmed_at)}
                    </span>
                    <svg width="88" height="20" viewBox="0 0 96 20" aria-hidden="true" fill="none" stroke="#8FAE80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 10 h86" />
                      <path d="M80 3 l9 7 l-9 7" />
                    </svg>
                  </div>
                  <Big label="after" p={iv.after} tone="after" />
                </div>
                <p className="m-0 max-w-[700px] text-base leading-normal text-pretty text-ink-2">
                  The manager&apos;s reply: “{iv.action.replace(/[.!\s]+$/, "")}”. These are counts before and after the time they confirmed it. Recyclone only sees what goes into
                  the bins, so it can&apos;t say the change caused any difference; crowds, staff and weather vary too.
                  {iv.after.assessed_count < item.min_assessed && " The after period still has very few drops."}
                </p>
              </>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  <span className="text-[13px] text-muted">sorted correctly</span>
                  <span
                    className={`font-display leading-[0.82] font-extrabold tracking-[-0.03em] ${item.score.status === "ok" ? `text-[136px] ${item.score.percent < item.threshold_percent ? "text-clay-deep" : "text-forest"}` : "text-5xl text-muted"}`}
                  >
                    {scoreLabel(item.score)}
                  </span>
                  <span className="text-[13px] text-muted">
                    from {item.assessed_count} {item.assessed_count === 1 ? "drop" : "drops"}, recent ones weighted more
                  </span>
                </div>
                <p className="m-0 max-w-[700px] text-base leading-normal text-pretty text-ink-2">
                  {item.score.status === "insufficient_data"
                    ? "We haven't seen this item go into a bin we could judge yet."
                    : item.assessed_count < item.min_assessed
                      ? `Recyclone waits for at least ${item.min_assessed} drops before texting anyone about an item.`
                      : "No change has been confirmed for this item yet, so there's no before and after."}
                </p>
              </>
            )}
          </div>

          <div className="flex flex-[1_1_260px] flex-col gap-3.5 pt-3">
            <dl className="m-0 flex flex-col gap-3">
              <div className="flex justify-between gap-3">
                <dt className="text-sm text-muted">Belongs in</dt>
                <dd className="m-0 text-base"><BinTag type={item.correct_destination} bold size={9} /></dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-rule pt-3">
                <dt className="text-sm text-muted">Sorting goal</dt>
                <dd className="m-0 text-base font-bold">{item.threshold_percent}%</dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-rule pt-3">
                <dt className="text-sm text-muted">Restaurant</dt>
                <dd className="m-0 text-base">{item.business_name ?? "none (generic)"}</dd>
              </div>
              <div className="flex justify-between gap-3 border-t border-rule pt-3">
                <dt className="text-sm text-muted">Texts</dt>
                <dd className="m-0 text-[15px]">{alert ? <Link href={`/messages?alert=${alert.alert_id}`}>Conversation with the {alert.contact.name} →</Link> : "none sent"}</dd>
              </div>
            </dl>
            {wrongBins.size > 0 && (
              <div className="flex flex-col gap-2 border-t border-rule pt-3.5">
                <span className="text-sm text-muted">Where the wrong drops went</span>
                <div className="flex gap-10">
                  {[...wrongBins].map(([bin, n]) => (
                    <div key={bin} className="flex flex-col">
                      <span className="font-display text-[56px] leading-[0.9] font-extrabold">{n}</span>
                      <span className="text-sm font-bold"><BinTag type={bin} /></span>
                    </div>
                  ))}
                </div>
                <span className="text-xs text-muted-2">from the drops seen in this session</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="drops-h" className="bg-sage px-10 pt-5 pb-[18px]">
        <div className="mx-auto flex max-w-[1360px] flex-col gap-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
            <h2 id="drops-h" className="m-0 font-display text-[22px] font-bold">Every drop of this item</h2>
            <span className="text-xs text-muted">
              {item.stations.map((s) => `${s.station_name}: ${s.correct_count} of ${s.assessed_count} right`).join(" · ") || "no stations yet"}
            </span>
          </div>
          {disposals.length === 0 ? (
            <span className="py-6 text-[15px] text-muted">No drops seen in this session yet.</span>
          ) : (
            <div className="flex flex-wrap items-end gap-1.5 overflow-x-auto pb-1">
              {[...disposals].reverse().map((d) => {
                const tall = d.outcome === "correct" || d.outcome === "incorrect";
                return (
                  <div key={d.cursor} className="flex w-14 flex-col items-center gap-1" title={`${time(d.at)} · ${d.bin ? BIN_LABEL[d.bin] : "?"} · ${d.outcome ?? "unknown"}`}>
                    <div
                      className={`w-full rounded-t-[7px] ${d.outcome === "correct" ? "h-[110px] bg-[#6E9B5C]" : d.outcome === "incorrect" ? "h-[110px] bg-clay" : "h-[60px]"}`}
                      style={tall ? undefined : { background: "repeating-linear-gradient(-45deg, rgba(255,253,248,0.6) 0 6px, rgba(201,214,190,0.6) 6px 12px)" }}
                    />
                    <span className="w-full border-t border-rule-sage pt-1 text-center font-mono text-[11px] text-ink-2">{shortTime(d.at)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <span className="text-xs text-muted">green: right bin · clay: wrong bin · striped: couldn&apos;t judge, not counted</span>
        </div>
      </section>
    </div>
  );
}
