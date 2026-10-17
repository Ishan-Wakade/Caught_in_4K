"use client";

import { useResource } from "@/hooks/useResource";
import { useScenes } from "@/hooks/useScenes";
import { api } from "@/lib/api";
import { BIN_DOT, BIN_INK, BIN_LABEL, dayTime, fullnessPercent, time } from "@/lib/format";
import type { BinStatus, CatalogItem } from "@/lib/types";
import { BinFigure, fillUnknown } from "@/components/BinFigure";
import { Dot, Empty, LoadError, Mono } from "@/components/ui";

function BinColumn({ bin, lead, emptyingRequested, highlight }: { bin: BinStatus; lead: boolean; emptyingRequested: boolean; highlight: boolean }) {
  const unknown = fillUnknown(bin);
  const pct = fullnessPercent(bin.estimated_fullness);
  const over = bin.estimated_fullness >= bin.fullness_threshold;
  const ill = bin.illustration;
  return (
    <section
      aria-label={`${bin.name}`}
      className={`flex min-w-0 flex-col gap-1.5 ${lead ? "flex-[1.4_1_420px]" : "flex-[1_1_300px]"} ${highlight ? "animate-rise-in" : ""}`}
    >
      <h2 className={`m-0 flex items-center gap-2.5 font-display font-bold ${lead ? "text-[26px]" : "text-[23px]"} ${BIN_INK[bin.type]}`}>
        <Dot className={BIN_DOT[bin.type]} size={lead ? 12 : 11} />
        {BIN_LABEL[bin.type]}
        <span className="font-sans text-sm font-normal text-muted-2">{bin.name} · {bin.capacity_l} L</span>
      </h2>
      <BinFigure bin={bin} height={lead ? 310 : 250} />

      {unknown ? (
        <>
          <span className="font-display text-[38px] leading-[0.95] font-bold text-muted">Not enough data</span>
          <span className="text-[15px] leading-snug text-ink-2">Nothing seen going in yet, and we don&apos;t know what was in it before monitoring began.</span>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
            <span className={`font-display leading-[0.85] font-extrabold tracking-[-0.02em] ${lead ? "text-[104px]" : "text-[72px]"}`}>~{pct}%</span>
            <span className="text-sm text-muted-2">full · estimated</span>
          </div>
          {over ? (
            <span className="flex items-center gap-2.5 text-lg font-bold text-clay-deep">
              <Dot className="bg-clay" size={10} />
              {emptyingRequested ? "Nearly full · emptying requested" : "Nearly full · time to empty it soon"}
            </span>
          ) : (
            <span className="text-[17px] text-ink-2">{pct >= 50 ? "Filling up" : "Plenty of room"}</span>
          )}
          <span className="text-[13px] text-muted-2">
            {bin.assumed_initial_l > 0
              ? `Includes ~${Math.round(bin.assumed_initial_l)} L assumed to be in it when monitoring began`
              : !bin.initial_contents_known
                ? "Counts only what we've seen since monitoring began"
                : `Since emptied ${dayTime(bin.last_emptied_at)}`}
          </span>
        </>
      )}

      <span className="text-[13px] text-muted-2">
        {ill ? (
          <>
            AI illustration, not a photo · drawn from snapshot <Mono>{time(ill.snapshot_taken_at)}</Mono>
            {ill.mocked ? " · mock image service" : " · Grok Imagine"}
          </>
        ) : (
          "No illustration yet"
        )}
      </span>
    </section>
  );
}

function SeenList({ bin, catalog }: { bin: BinStatus; catalog: Map<string, CatalogItem> }) {
  const byName = new Map([...catalog.values()].map((c) => [c.name, c]));
  const rows = [...bin.observed_counts].sort((a, b) => b.count - a.count);
  return (
    <div className="flex min-w-0 flex-[1_1_300px] flex-col">
      <span className={`flex items-center gap-2 pb-1 text-[13px] font-bold ${BIN_INK[bin.type]}`}>
        <Dot className={BIN_DOT[bin.type]} size={7} />
        {BIN_LABEL[bin.type]}
      </span>
      {rows.length === 0 && bin.unknown_count === 0 && <span className="py-1.5 text-base text-muted">Nothing yet</span>}
      {rows.map((r, i) => {
        const cat = (r.catalog_item_id && catalog.get(r.catalog_item_id)) || byName.get(r.name);
        const wrong = cat && cat.correct_destination !== bin.type;
        return (
          <div key={r.name} className={`flex justify-between gap-3 py-[5px] text-base ${i ? "border-t border-rule" : ""}`}>
            <span>
              {r.name}
              {wrong && <span className="text-sm font-bold text-clay-deep"> · belongs in {BIN_LABEL[cat.correct_destination]}</span>}
            </span>
            <Mono>{r.count}</Mono>
          </div>
        );
      })}
      {bin.unknown_count > 0 && (
        <div className={`flex justify-between gap-3 py-[5px] text-base text-ink-2 ${rows.length ? "border-t border-rule" : ""}`}>
          <span>
            Couldn&apos;t identify <span className="text-[13px] text-muted-2">· not counted as mistakes</span>
          </span>
          <Mono>{bin.unknown_count}</Mono>
        </div>
      )}
    </div>
  );
}

export default function BinsPage() {
  const bins = useResource(api.bins);
  const alerts = useResource(api.alerts);
  const catalog = useResource(api.catalog);
  const { focusBinId } = useScenes();

  if (bins.error && !bins.data) return <LoadError error={bins.error} />;
  if (!bins.data) return <Empty title="Loading bins…" />;

  const list = bins.data.bins;
  const leadId = [...list].sort((a, b) => b.estimated_fullness - a.estimated_fullness)[0]?.bin_id;
  const requested = new Set(
    (alerts.data?.alerts ?? []).filter((a) => a.kind === "emptying" && a.state !== "emptied").map((a) => a.bin_id),
  );
  const catMap = new Map((catalog.data?.items ?? []).map((c) => [c.catalog_item_id, c]));

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-wrap items-end gap-x-14 gap-y-6 px-10 pt-[18px] pb-[22px]">
        {list.map((b) => (
          <BinColumn key={b.bin_id} bin={b} lead={b.bin_id === leadId} emptyingRequested={requested.has(b.bin_id)} highlight={b.bin_id === focusBinId} />
        ))}
      </div>

      <section aria-labelledby="seen-h" className="bg-paper-deep px-10 pt-4 pb-[18px]">
        <div className="mb-1.5 flex flex-wrap items-baseline gap-x-3.5 gap-y-1">
          <h2 id="seen-h" className="m-0 font-display text-xl font-bold">Seen going in</h2>
          <span className="font-mono text-[13px] text-muted">since each bin was last emptied</span>
        </div>
        <div className="flex flex-wrap gap-x-14 gap-y-3">
          {list.map((b) => (
            <SeenList key={b.bin_id} bin={b} catalog={catMap} />
          ))}
        </div>
      </section>
    </div>
  );
}
