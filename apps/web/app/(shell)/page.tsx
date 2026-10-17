"use client";

import Link from "next/link";
import { useResource } from "@/hooks/useResource";
import { api } from "@/lib/api";
import { ALERT_STATE_LABEL, BIN_DOT, BIN_INK, BIN_LABEL, day, fullnessPercent, scoreLabel, shortTime } from "@/lib/format";
import { SITE } from "@/lib/site";
import type { Alert, ItemSummary } from "@/lib/types";
import { MiniBin, fillUnknown } from "@/components/BinFigure";
import { Dot, Mono, Page } from "@/components/ui";
import { APP_NAME } from "@/lib/config";

const siteTitle = SITE.site.name.replace(/\s*\(demo\)\s*$/i, "");

function pct(i: ItemSummary): number | null {
  return i.score.status === "ok" ? i.score.percent : null;
}

export default function OverviewPage() {
  const bins = useResource(api.bins);
  const items = useResource(api.items);
  const reviews = useResource(api.reviews);
  const alerts = useResource(api.alerts);

  const pending = reviews.data?.reviews.filter((r) => r.status === "pending").length ?? 0;
  const allItems = items.data?.items ?? [];
  const allAlerts = alerts.data?.alerts ?? [];
  const latestSnapshot = bins.data?.bins.map((b) => b.illustration?.snapshot_taken_at).filter(Boolean).sort().at(-1);

  const toImprove = allItems
    .filter((i) => i.assessed_count > 0 && (i.score.status === "insufficient_data" || (pct(i) ?? 100) < i.threshold_percent))
    .sort((a, b) => (pct(a) ?? 101) - (pct(b) ?? 101));
  const changes = allItems.filter((i) => i.interventions.length > 0);

  // Core scores items, not restaurants, so each row lists its items (weakest first) rather than one number.
  const row = (key: string, name: string, theirs: ItemSummary[], latest: Alert | undefined) => {
    const sorted = [...theirs].sort((x, y) => (pct(x) ?? 101) - (pct(y) ?? 101));
    return { key, name, items: sorted, drops: theirs.reduce((n, i) => n + i.assessed_count, 0), latest };
  };
  const restaurants = SITE.businesses.map((b) =>
    row(
      b.business_id,
      b.name,
      allItems.filter((i) => i.business_id === b.business_id && i.assessed_count > 0),
      allAlerts.find((a) => a.contact.business_id === b.business_id),
    ),
  );
  // Unbranded items have no restaurant; their recommendations go to the area manager.
  const shared = allItems.filter((i) => !i.business_id && i.assessed_count > 0);
  if (shared.length)
    restaurants.push(row("shared", "Shared items", shared, allAlerts.find((a) => a.kind === "recommendation" && !a.contact.business_id)));

  return (
    <div className="flex flex-1 flex-col">
      <section aria-label="Today" className="px-10 pt-[18px] pb-4">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-end justify-between gap-x-8 gap-y-2">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h1 className="m-0 font-display text-[40px] leading-none font-extrabold">{siteTitle} today</h1>
            <span suppressHydrationWarning className="text-[15px] text-muted">
              {new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}
            </span>
          </div>
          {pending > 0 ? (
            <Link href="/reviews" className="flex min-h-11 items-center gap-2 text-base font-bold">
              <Dot className="bg-clay" />
              {pending} {pending === 1 ? "drop" : "drops"} waiting for review →
            </Link>
          ) : (
            <span className="text-[15px] text-muted">Nothing waiting for review</span>
          )}
        </div>
      </section>

      <section aria-labelledby="bins-h" className="bg-sage px-10 pt-[18px] pb-5">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-end gap-x-20 gap-y-4">
          <div className="flex flex-none flex-col gap-1 self-center">
            <h2 id="bins-h" className="m-0 font-display text-2xl font-bold">Bins right now</h2>
            <span className="text-[13px] text-muted">
              estimated from what we&apos;ve seen{latestSnapshot ? <> · <Mono>{shortTime(latestSnapshot)}</Mono></> : null}
            </span>
            <Link href="/bins" className="flex min-h-8 items-center text-sm font-bold">See bins →</Link>
          </div>
          {(bins.data?.bins ?? []).map((b) => {
            const unknown = fillUnknown(b);
            const over = b.estimated_fullness >= b.fullness_threshold;
            return (
              <div key={b.bin_id} className="flex items-end gap-4">
                <MiniBin bin={b} />
                <div className="flex flex-col gap-0.5">
                  <span className={`flex items-center gap-2 text-[15px] font-bold ${BIN_INK[b.type]}`}>
                    <Dot className={BIN_DOT[b.type]} />
                    {BIN_LABEL[b.type]}
                  </span>
                  {unknown ? (
                    <>
                      <span className="font-display text-3xl leading-[1.1] font-bold text-muted">Not enough data</span>
                      <span className="text-[13px] text-muted">nothing seen going in yet</span>
                    </>
                  ) : (
                    <>
                      <span className="font-display text-[54px] leading-[0.9] font-extrabold">~{fullnessPercent(b.estimated_fullness)}%</span>
                      <span className="text-[13px] text-muted">
                        estimated{over && <span className="font-bold text-clay-deep"> · time to empty</span>}
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="flex-1 px-10 pt-[22px] pb-[18px]">
        <div className="mx-auto flex max-w-[1360px] flex-wrap gap-x-16 gap-y-6">
          <section aria-labelledby="rest-h" className="flex min-w-0 flex-[1.5_1_560px] flex-col">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
              <h2 id="rest-h" className="m-0 font-display text-2xl font-bold">Restaurants</h2>
              <span className="text-[13px] text-muted">each item scored on its own · goal {SITE.config_profiles.demo.correct_threshold_pct ?? "—"}% for every item</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] border-collapse text-base">
                <thead>
                  <tr className="text-left">
                    <th scope="col" className="py-1.5 pr-3 text-xs font-medium text-muted">Restaurant</th>
                    <th scope="col" className="px-3 py-1.5 text-xs font-medium text-muted">Items · sorted correctly</th>
                    <th scope="col" className="py-1.5 pl-5 text-xs font-medium text-muted">Latest text</th>
                  </tr>
                </thead>
                <tbody>
                  {restaurants.map(({ key, name, items: theirs, drops, latest }, i) => {
                    const shown = theirs.slice(0, 3);
                    return (
                      <tr key={key} className={`border-t border-rule align-top ${i === restaurants.length - 1 ? "border-b" : ""}`}>
                        <th scope="row" className="py-3 pr-3 text-left font-display text-[21px] font-bold">
                          {name}
                          <span className="block font-sans text-xs font-normal text-muted">
                            {key === "shared" ? "no restaurant · texts go to the area manager · " : ""}
                            {drops} {drops === 1 ? "drop" : "drops"}
                          </span>
                        </th>
                        <td className="p-3">
                          {shown.length === 0 && <span className="text-sm text-muted">no drops yet</span>}
                          <div className="flex flex-col gap-1.5">
                            {shown.map((it) => {
                              const p = pct(it);
                              const below = p !== null && p < it.threshold_percent;
                              return (
                                <Link key={it.catalog_item_id} href={`/items/${it.catalog_item_id}`} className="flex items-baseline gap-2.5 text-ink no-underline hover:text-ink">
                                  <span className={`min-w-[3.6ch] font-display leading-none font-extrabold ${p === null ? "text-base font-bold text-muted" : `text-[28px] ${below ? "text-clay-deep" : ""}`}`}>
                                    {scoreLabel(it.score)}
                                  </span>
                                  <span className={`text-[15px] ${below ? "text-clay-deep" : "text-ink-2"}`}>{it.name.replace(`${name} `, "")}</span>
                                  <span className="text-[13px] whitespace-nowrap text-muted">
                                    · {it.assessed_count} {it.assessed_count === 1 ? "drop" : "drops"}
                                  </span>
                                </Link>
                              );
                            })}
                            {theirs.length > shown.length && (
                              <Link href="/catalog" className="text-[13px] font-bold">
                                +{theirs.length - shown.length} more {theirs.length - shown.length === 1 ? "item" : "items"} →
                              </Link>
                            )}
                          </div>
                        </td>
                        <td className="py-3 pl-5">
                          {latest ? (
                            <Link href={`/messages?alert=${latest.alert_id}`} className="flex items-center gap-2 text-ink no-underline hover:text-ink">
                              <Dot className="bg-leaf" />
                              <span>
                                <strong>{ALERT_STATE_LABEL[latest.state]}</strong> <span className="text-[13px] text-muted-2">· {shortTime(latest.opened_at)}</span>
                              </span>
                            </Link>
                          ) : (
                            <span className="text-sm text-muted">none</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="watch-h" className="flex min-w-0 flex-[1_1_380px] flex-col">
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <h2 id="watch-h" className="m-0 font-display text-2xl font-bold">Room to improve</h2>
              <Link href="/catalog" className="text-[13px] font-bold">All items →</Link>
            </div>
            {toImprove.length === 0 && <span className="mt-[23px] border-t border-rule py-3 text-[15px] text-muted">Every item with enough drops is at or above its goal.</span>}
            {toImprove.slice(0, 4).map((i, idx) => (
              <Link
                key={i.catalog_item_id}
                href={`/items/${i.catalog_item_id}`}
                className={`flex min-h-11 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-rule py-2.5 text-ink no-underline hover:text-ink ${idx === 0 ? "mt-[23px]" : ""} ${idx === Math.min(3, toImprove.length - 1) ? "border-b" : ""}`}
              >
                <span className="flex flex-col gap-px">
                  <strong className="text-[17px]">{i.name}</strong>
                  <span className="flex items-center gap-[7px] text-[13px] text-muted">
                    <Dot className={BIN_DOT[i.correct_destination]} size={7} />
                    belongs in {BIN_LABEL[i.correct_destination]} · {i.assessed_count} {i.assessed_count === 1 ? "drop" : "drops"}
                  </span>
                </span>
                {pct(i) === null ? (
                  <span className="text-sm text-muted">not enough data</span>
                ) : (
                  <span className="font-display text-4xl leading-none font-extrabold text-clay-deep">{scoreLabel(i.score)}</span>
                )}
              </Link>
            ))}
          </section>
        </div>
      </div>

      {changes.length > 0 && (
        <section aria-labelledby="change-h" className="bg-paper-deep px-10 pt-4 pb-[18px]">
          <div className="mx-auto flex max-w-[1360px] flex-col gap-3">
            <h2 id="change-h" className="m-0 font-display text-[22px] font-bold">Changes after a text</h2>
            {changes.map((i) => {
              const iv = i.interventions.at(-1)!;
              return (
                <Link
                  key={i.catalog_item_id}
                  href={`/items/${i.catalog_item_id}`}
                  className="flex min-h-11 flex-wrap items-center justify-between gap-x-6 gap-y-1.5 text-ink no-underline hover:text-ink"
                >
                  <span className="flex flex-col gap-px">
                    <strong className="text-[17px]">{i.name}</strong>
                    <span className="flex items-center gap-[7px] text-[13px] text-muted">
                      <Dot className="bg-forest" size={7} />
                      action confirmed {day(iv.confirmed_at)}, {shortTime(iv.confirmed_at)}
                    </span>
                  </span>
                  <span className="flex items-baseline gap-2.5 font-display text-4xl leading-none font-extrabold">
                    <span className="text-[#7C8074]">{scoreLabel(iv.before.score)}</span>
                    <span aria-hidden="true" className="font-sans text-xl font-medium text-leaf">→</span>
                    <span className="text-forest">{scoreLabel(iv.after.score)}</span>
                  </span>
                  <span className="text-xs leading-snug text-muted">
                    {iv.before.assessed_count} drops before · {iv.after.assessed_count} after
                    <br />
                    {APP_NAME} can&apos;t tell what caused the change.
                  </span>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
