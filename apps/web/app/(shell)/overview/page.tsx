"use client";

import Link from "next/link";
import { useHeavyScroll } from "@/hooks/useHeavyScroll";
import { useDisposals, type Disposal } from "@/hooks/useDisposals";
import { useResource } from "@/hooks/useResource";
import { api } from "@/lib/api";
import { ALERT_STATE_LABEL, BIN_DOT, BIN_LABEL, cap, fullnessPercent, shortTime } from "@/lib/format";
import { SITE } from "@/lib/site";
import type { Alert, BinType } from "@/lib/types";
import { fillUnknown } from "@/components/BinFigure";
import { Dot } from "@/components/ui";

const siteTitle = SITE.site.name.replace(/\s*\(demo\)\s*$/i, "");
const SHARED_KEY = "__shared__";

function isToday(iso: string): boolean {
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
}

// ≥80% good, 50–79% neutral, <50% a problem. Red is reserved for problems (visual rules).
function scoreTone(percent: number): { text: string; bar: string } {
  if (percent >= 80) return { text: "text-forest", bar: "bg-forest" };
  if (percent >= 50) return { text: "text-ink-2", bar: "bg-ink-2" };
  return { text: "text-clay-deep", bar: "bg-clay-deep" };
}

function Bar({ percent, colorClass, className = "" }: { percent: number; colorClass: string; className?: string }) {
  const p = Math.min(100, Math.max(0, percent));
  return (
    <span className={`relative inline-block h-1.5 overflow-hidden rounded-full bg-paper-deep ${className}`}>
      <span className={`absolute inset-y-0 left-0 rounded-full ${colorClass}`} style={{ width: `${p}%` }} />
    </span>
  );
}

type ItemRow = { key: string; name: string; drops: number; correct: number; known: number; belongsIn: BinType | null };
type RestaurantCard = { key: string; name: string; isShared: boolean; dropsToday: number; correct: number; known: number; items: ItemRow[]; latest: Alert | undefined };

/**
 * Today's restaurant stats, built from the live feed's disposal events (not
 * /api/items) because the API has no "today" boundary — see the redesign
 * summary for why. "Known" = assessable drops (correct + incorrect); an
 * unassessable/unidentified drop still counts toward dropsToday but, per
 * core's own rule ("unknown outcomes are not mistakes"), never toward the
 * score's numerator or denominator.
 */
function buildCards(disposals: Disposal[], alerts: Alert[]): RestaurantCard[] {
  const todays = disposals.filter((d) => isToday(d.at));
  const groups = new Map<string, RestaurantCard>();

  for (const d of todays) {
    const key = d.business_name ?? SHARED_KEY;
    let g = groups.get(key);
    if (!g) {
      g = { key, name: d.business_name ?? "Shared items", isShared: key === SHARED_KEY, dropsToday: 0, correct: 0, known: 0, items: [], latest: undefined };
      groups.set(key, g);
    }
    g.dropsToday++;
    if (d.outcome === "correct") {
      g.correct++;
      g.known++;
    } else if (d.outcome === "incorrect") {
      g.known++;
    }

    const itemKey = d.item_id ?? d.item_name;
    let row = g.items.find((r) => r.key === itemKey);
    if (!row) {
      row = { key: itemKey, name: g.isShared ? d.item_name : cap(d.item_name.replace(`${g.name} `, "")), drops: 0, correct: 0, known: 0, belongsIn: d.belongs_in };
      g.items.push(row);
    }
    row.drops++;
    if (d.outcome === "correct") {
      row.correct++;
      row.known++;
    } else if (d.outcome === "incorrect") {
      row.known++;
    }
  }

  for (const g of groups.values()) {
    const bizId = g.isShared ? null : SITE.businesses.find((b) => b.name === g.name)?.business_id;
    g.latest = g.isShared
      ? alerts.find((a) => a.kind === "recommendation" && !a.contact.business_id)
      : alerts.find((a) => a.contact.business_id && a.contact.business_id === bizId);
    g.items.sort((a, b) => (a.known > 0 ? a.correct / a.known : 1) - (b.known > 0 ? b.correct / b.known : 1));
  }

  // Lowest overall score first; a restaurant with no assessable drops yet sorts last (nothing to rank).
  return [...groups.values()].sort((a, b) => {
    const as = a.known > 0 ? a.correct / a.known : Infinity;
    const bs = b.known > 0 ? b.correct / b.known : Infinity;
    return as - bs;
  });
}

export default function OverviewPage() {
  useHeavyScroll();
  const bins = useResource(api.bins);
  const reviews = useResource(api.reviews);
  const alerts = useResource(api.alerts);
  const disposals = useDisposals();

  const pending = reviews.data?.reviews.filter((r) => r.status === "pending").length ?? 0;
  const latestSnapshot = bins.data?.bins.map((b) => b.illustration?.snapshot_taken_at).filter(Boolean).sort().at(-1);
  const cards = buildCards(disposals, alerts.data?.alerts ?? []);
  const zeroDropToday = SITE.businesses.filter((b) => !cards.some((c) => !c.isShared && c.name === b.name)).map((b) => b.name);

  const todayLong = new Date().toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });

  return (
    <div className="flex flex-1 flex-col">
      <section aria-label="Today" className="px-10 pt-[18px] pb-4">
        <div className="mx-auto flex max-w-[1360px] flex-wrap items-end justify-between gap-x-8 gap-y-3">
          <div className="flex flex-col gap-0.5">
            <span suppressHydrationWarning className="text-[14px] text-muted">{todayLong}</span>
            <h1 className="m-0 font-display text-[40px] leading-none font-extrabold">{siteTitle}</h1>
          </div>
          {pending > 0 ? (
            <Link
              href="/reviews"
              className="flex min-h-11 items-center rounded-full bg-clay-light/25 px-4 text-[15px] font-bold text-clay-deep no-underline hover:bg-clay-light/40 hover:text-clay-deep"
            >
              {pending} {pending === 1 ? "drop" : "drops"} waiting for review →
            </Link>
          ) : (
            <span className="text-[15px] text-muted">Nothing waiting for review</span>
          )}
        </div>
      </section>

      <section aria-labelledby="bins-h" className="px-10 pb-5">
        <div className="mx-auto max-w-[1360px]">
          <div className="flex flex-col gap-3 rounded-2xl border border-rule bg-card px-6 py-4 md:flex-row md:items-center md:gap-x-10">
            <div className="flex flex-none flex-col gap-0.5">
              <h2 id="bins-h" className="m-0 font-display text-lg font-bold">Shared bins</h2>
              <span className="text-[13px] text-muted">
                Estimated fill · <span className="font-mono tabular-nums">{latestSnapshot ? shortTime(latestSnapshot) : "—"}</span>
              </span>
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-8">
              {(bins.data?.bins ?? []).map((b) => {
                const unknown = fillUnknown(b);
                const pct = fullnessPercent(b.estimated_fullness);
                return (
                  <div key={b.bin_id} className="flex min-w-[170px] flex-1 items-center gap-2.5">
                    <Dot className={BIN_DOT[b.type]} />
                    <span className="w-[72px] flex-none text-[14px] font-bold">{BIN_LABEL[b.type]}</span>
                    <Bar percent={unknown ? 0 : pct} colorClass={BIN_DOT[b.type]} className="flex-1" />
                    <span className="w-10 flex-none text-right font-mono text-[14px] tabular-nums">{unknown ? "—" : `${pct}%`}</span>
                  </div>
                );
              })}
            </div>
            <Link href="/" className="flex-none text-[14px] font-bold">See bins →</Link>
          </div>
        </div>
      </section>

      <div className="flex-1 px-10 pt-[6px] pb-[22px]">
        <div className="mx-auto flex max-w-[1360px] flex-col gap-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-5 gap-y-1">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="m-0 font-display text-2xl font-bold">Restaurants</h2>
              <span className="text-[13px] text-muted">{cards.length} with drops today · lowest sorting score first</span>
            </div>
            <Link href="/catalog" className="text-[13px] font-bold">All items →</Link>
          </div>

          {cards.length === 0 ? (
            <span className="text-[15px] text-muted">No drops recorded yet today.</span>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {cards.map((c) => {
                const scorePercent = c.known > 0 ? Math.round((c.correct / c.known) * 100) : null;
                const needsAttention = c.items.some((it) => it.known > 0 && it.correct / it.known < 0.5);
                const tone = scorePercent !== null ? scoreTone(scorePercent) : null;
                return (
                  <div
                    key={c.key}
                    className={`flex flex-col gap-3 rounded-2xl border bg-card px-5 py-4 ${needsAttention ? "border-clay-light" : "border-rule"}`}
                  >
                    {needsAttention && (
                      <span className="self-start rounded-full bg-clay-light/25 px-2.5 py-0.5 text-[11px] font-bold text-clay-deep">Needs attention</span>
                    )}

                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-display text-xl font-bold">{c.name}</span>
                        <span className="text-[13px] text-muted">
                          {c.isShared ? "No restaurant · texts go to the area manager · " : ""}
                          {c.dropsToday} {c.dropsToday === 1 ? "drop" : "drops"} today
                        </span>
                      </div>
                      <div className="flex flex-none flex-col items-end">
                        <span className={`font-display text-3xl leading-none font-extrabold tabular-nums ${tone?.text ?? "text-muted"}`}>
                          {scorePercent === null ? "—" : `${scorePercent}%`}
                        </span>
                        <span className="text-[11px] text-muted">sorted correctly</span>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2.5 border-t border-rule-soft pt-2.5">
                      {c.items.map((it) => {
                        const p = it.known > 0 ? Math.round((it.correct / it.known) * 100) : null;
                        const itTone = p !== null ? scoreTone(p) : null;
                        return (
                          <div key={it.key} className="flex items-center gap-3">
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                              <span className="flex min-w-0 items-baseline gap-1 text-[14px]">
                                <strong className="min-w-0 truncate font-bold">{it.name}</strong>
                                <span className="flex-none whitespace-nowrap text-muted">· {it.drops} {it.drops === 1 ? "drop" : "drops"}</span>
                              </span>
                              {p !== null && p < 50 && it.belongsIn && (
                                <span className="flex items-center gap-1.5 text-[12px] text-muted">
                                  <Dot className={BIN_DOT[it.belongsIn]} size={6} /> Belongs in {BIN_LABEL[it.belongsIn]}
                                </span>
                              )}
                            </div>
                            <Bar percent={p ?? 0} colorClass={itTone?.bar ?? "bg-rule"} className="w-24 flex-none" />
                            <span className={`w-10 flex-none text-right font-mono text-[13px] tabular-nums ${itTone?.text ?? "text-muted"}`}>
                              {p === null ? "—" : `${p}%`}
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 border-t border-rule-soft pt-2.5 text-[13px]">
                      <span className="text-muted">Latest text:</span>
                      {c.latest ? (
                        <Link href={`/messages?alert=${c.latest.alert_id}`} className="flex items-center gap-2 text-ink no-underline hover:text-ink">
                          <span className="rounded-full bg-sage px-2.5 py-0.5 text-[12px] font-bold text-forest-deep">{ALERT_STATE_LABEL[c.latest.state]}</span>
                          <span className="font-mono text-[12px] text-muted tabular-nums">{shortTime(c.latest.opened_at)}</span>
                        </Link>
                      ) : (
                        <span className="text-muted">none yet</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {zeroDropToday.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 pt-1 text-[13px] text-muted">
              <span>No drops yet today:</span>
              {zeroDropToday.map((n) => (
                <span key={n} className="rounded-full border border-rule bg-card px-3 py-1 font-medium text-ink-2">{n}</span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
