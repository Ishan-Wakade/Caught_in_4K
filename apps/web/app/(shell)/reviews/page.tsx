"use client";

import { useState } from "react";
import { useResource } from "@/hooks/useResource";
import { api } from "@/lib/api";
import { evidenceUrl } from "@/lib/config";
import { BIN_DOT, BIN_INK, BIN_LABEL, dayTime, shortTime } from "@/lib/format";
import { binTypeOf, businessName, SITE } from "@/lib/site";
import type { CatalogItem, ReviewDecision, ReviewItem } from "@/lib/types";
import { Dot, Empty, LoadError, Mono } from "@/components/ui";

function Evidence({ review }: { review: ReviewItem }) {
  const [failed, setFailed] = useState(false);
  const ev = review.evidence[0];
  const url = ev ? evidenceUrl(ev.uri) : null;
  return (
    <figure className="m-0 flex min-w-0 flex-[1.6_1_620px] flex-col gap-2">
      <div className="relative h-[560px] overflow-hidden rounded-[28px] bg-[linear-gradient(180deg,#3A4136_0_30%,#4A5044_30%_100%)] shadow-[0_16px_40px_rgba(50,45,25,0.14)]">
        {url && !failed ? (
          // Evidence crops are served by the worker (contract §4).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="Camera crop of the item as it entered the bin" className="h-full w-full object-contain" onError={() => setFailed(true)} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-10 text-center text-[#C9CCBF]">
            <span className="font-display text-2xl font-bold text-card">Camera still not available</span>
            <span className="text-sm">
              {url ? "The worker didn't return this crop." : "The camera worker isn't connected, so its crop can't be shown."}
              {ev && (
                <>
                  <br />
                  <Mono className="text-xs">{ev.uri}</Mono>
                </>
              )}
            </span>
          </div>
        )}
        <span className="absolute top-[18px] left-5 font-mono text-sm text-[#E6E8DE]">
          {SITE.cameras[0]?.name ?? "Camera"} · {dayTime(review.occurred_at)}
        </span>
      </div>
      <figcaption className="text-xs text-muted-2">Camera still, not an illustration · cropped from the recording by the worker</figcaption>
    </figure>
  );
}

function Decide({ review, catalog, onDone }: { review: ReviewItem; catalog: CatalogItem[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const bin = binTypeOf(review.bin_id);
  const cat = catalog.find((c) => c.catalog_item_id === review.item.catalog_item_id);
  const right = cat && bin && cat.correct_destination === bin;
  const top = review.business_candidates.slice(0, 2);

  const decide = async (d: ReviewDecision) => {
    setBusy(true);
    setErr(null);
    try {
      await api.decideReview(review.event_id, d);
      setDone(d.action === "assign" ? `Counted toward ${businessName(d.business_id)}` : "Left unresolved");
      setTimeout(onDone, 1200);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-[18px]">
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[50px] leading-[0.98] font-extrabold tracking-[-0.01em] text-balance">
          Whose {(review.item_name ?? "item").toLowerCase().replace(/\s*\(unbranded\)/, "")} is this?
        </h1>
        <span className="flex flex-wrap items-center gap-2 text-base">
          <span>{review.item_name ?? "Unknown item"}, into</span>
          {bin && (
            <>
              <Dot className={BIN_DOT[bin]} size={9} />
              <strong className={BIN_INK[bin]}>{BIN_LABEL[bin]}</strong>
            </>
          )}
        </span>
      </div>

      <div className="flex flex-col">
        {review.business_candidates.length === 0 && <span className="border-t border-rule py-2.5 text-[15px] text-muted">No restaurant guesses from the camera.</span>}
        {review.business_candidates.map((c, i) => (
          <div key={c.business_id} className={`flex items-baseline justify-between gap-3 border-t border-rule py-2.5 ${i === review.business_candidates.length - 1 ? "border-b" : ""}`}>
            <span className="text-lg font-bold">{c.name}</span>
            <span className="font-display text-4xl leading-none font-extrabold">{c.score.toFixed(2)}</span>
          </div>
        ))}
        <span className="pt-1.5 text-xs text-muted-2">match scores from the camera, 0 to 1 · too low to decide on their own</span>
      </div>

      <p className="m-0 text-[15px] leading-normal text-pretty text-ink-2">
        {right
          ? "Good news: this was sorted right either way. Your choice only decides whose numbers it counts toward."
          : cat && bin
            ? `This went in the wrong bin (it belongs in ${BIN_LABEL[cat.correct_destination]}), so your choice decides whose numbers the mistake counts toward. No restaurant is texted about it until you decide.`
            : "Your choice decides whose numbers this drop counts toward."}
      </p>

      {done ? (
        <div role="status" className="flex flex-col gap-1 rounded-[22px] bg-mint px-5 py-[18px]">
          <strong className="font-display text-2xl leading-[1.1] font-bold text-forest-deep">{done}</strong>
          <span className="text-sm text-forest">Scores update right away.</span>
        </div>
      ) : (
        <div role="group" aria-label="Decide who this drop belongs to" className="flex flex-col gap-2 rounded-[22px] bg-card p-[18px] shadow-[0_2px_4px_rgba(70,60,35,0.04),0_10px_28px_rgba(70,60,35,0.09)]">
          <div className="flex flex-wrap gap-2.5">
            {top.map((c) => (
              <button
                key={c.business_id}
                disabled={busy}
                onClick={() => decide({ action: "assign", business_id: c.business_id })}
                className="min-h-[54px] flex-[1_1_160px] cursor-pointer rounded-2xl bg-forest px-[18px] text-[17px] font-bold text-white disabled:opacity-50"
              >
                Assign to {c.name}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={other}
              onChange={(e) => setOther(e.target.value)}
              aria-label="Another restaurant"
              className="min-h-11 flex-1 rounded-xl border border-rule bg-white px-2.5 text-base"
            >
              <option value="">Another restaurant…</option>
              {SITE.businesses.filter((b) => !top.some((t) => t.business_id === b.business_id)).map((b) => (
                <option key={b.business_id} value={b.business_id}>{b.name}</option>
              ))}
            </select>
            <button
              disabled={busy || !other}
              onClick={() => decide({ action: "assign", business_id: other })}
              className="min-h-11 cursor-pointer rounded-xl bg-mint px-4 text-[15px] font-bold text-forest-deep disabled:opacity-40"
            >
              Assign
            </button>
          </div>
          <button
            disabled={busy}
            onClick={() => decide({ action: "leave_unresolved" })}
            className="min-h-[46px] cursor-pointer rounded-[14px] bg-transparent px-[18px] text-base font-bold text-forest disabled:opacity-50"
          >
            Leave unresolved
          </button>
          {err && <span className="text-sm text-clay-deep">{err}</span>}
        </div>
      )}
    </div>
  );
}

export default function ReviewsPage() {
  const reviews = useResource(api.reviews);
  const catalog = useResource(api.catalog);
  const [selected, setSelected] = useState<string | null>(null);

  if (reviews.error && !reviews.data) return <LoadError error={reviews.error} />;
  if (!reviews.data) return <Empty title="Loading the review queue…" />;

  const pending = reviews.data.reviews.filter((r) => r.status === "pending");
  const unresolved = reviews.data.reviews.filter((r) => r.status === "left_unresolved");
  if (!pending.length)
    return (
      <Empty title="Nothing waiting for you">
        When the camera can&apos;t tell which restaurant an item came from, it shows up here so you can decide.
        {unresolved.length > 0 && ` ${unresolved.length} earlier ${unresolved.length === 1 ? "drop was" : "drops were"} left unresolved.`}
      </Empty>
    );

  const current = pending.find((r) => r.event_id === selected) ?? pending[0];

  return (
    <div className="mx-auto box-border flex w-full max-w-[1440px] flex-1 flex-col gap-[22px] px-10 pt-3.5 pb-6">
      <section aria-labelledby="queue-h" className="flex flex-wrap items-baseline gap-y-1.5 border-b border-rule pb-3">
        <h2 id="queue-h" className="m-0 pr-7 text-sm font-medium text-muted">Waiting for you · {pending.length}</h2>
        <ol className="m-0 flex list-none flex-wrap gap-y-1.5 p-0">
          {pending.map((r, i) => {
            const on = r.event_id === current.event_id;
            return (
              <li key={r.event_id} className={i ? "border-l border-rule" : ""}>
                <button
                  onClick={() => setSelected(r.event_id)}
                  aria-current={on ? "true" : undefined}
                  className={`flex cursor-pointer items-baseline gap-2 px-6 text-base ${i === 0 ? "pl-0" : ""} ${on ? "text-ink" : "text-ink-2"}`}
                >
                  {on && <Dot className="self-center bg-forest" />}
                  {on ? <strong>{r.item_name ?? "Unknown item"}</strong> : (r.item_name ?? "Unknown item")}
                  <Mono className="text-xs text-muted-2">{shortTime(r.occurred_at)}</Mono>
                </button>
              </li>
            );
          })}
        </ol>
      </section>

      <div className="flex flex-1 flex-wrap items-start gap-x-[52px] gap-y-7">
        <Evidence review={current} />
        <Decide key={current.event_id} review={current} catalog={catalog.data?.items ?? []} onDone={reviews.reload} />
      </div>
    </div>
  );
}
