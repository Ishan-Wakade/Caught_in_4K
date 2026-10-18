"use client";

import { useEffect, useRef, useState } from "react";
import { Section, num } from "@/components/dashboard/charts";
import { useLiveGuide, readGuideKey, type LiveSource, type LiveStatus, type SeenItem } from "@/hooks/useLiveGuide";
import { DEST_COLOR, DEST_LABEL, DESTINATIONS, type Destination } from "@/lib/dashboard/sample";
import { BIN_HEX } from "@/lib/format";
import type { Banner } from "@/lib/guide/engine";
import { itemAndBin } from "@/lib/live/overlay";
import type { BinType } from "@/lib/types";

/** Jolie's bin card (app/camera): the bin in huge type on its colour, fading in with the answer and out with the item. */
const BIN_TYPE: Record<string, BinType> = { recycle: "recycling", compost: "compost", trash: "trash" };
const FADE_MS = 200;
const fade = (shown: boolean) => ({ opacity: shown ? 1 : 0, transition: `opacity ${FADE_MS}ms ease-out, background-color 200ms` });

function BinCard({ banner, shown }: { banner: Banner; shown: boolean }) {
  const bin = BIN_TYPE[banner.message.bin];
  const background = banner.fallback || !bin ? "#A4502F" : BIN_HEX[bin].fill;
  const [item, binLabel] = itemAndBin(banner.message);
  const word = banner.message.bin === "none" ? "NO BIN" : banner.message.bin.toUpperCase();
  return (
    <div aria-hidden={!shown} className="absolute inset-x-0 bottom-0 px-6 pt-3 pb-5 motion-reduce:transition-none!" style={{ background, ...fade(shown) }}>
      <div className="font-display text-[clamp(48px,7vw,104px)] leading-[0.9] font-extrabold tracking-[-0.02em] text-card">{word}</div>
      <div className="mt-1 text-[clamp(17px,1.8vw,26px)] leading-snug text-card">
        {banner.message.bin === "none" ? `${item}: ${binLabel.replace(/^No bin: /, "take it to ")}` : `${item.charAt(0).toUpperCase() + item.slice(1)}, placed in ${binLabel.toLowerCase()}`}.
      </div>
    </div>
  );
}

/** The last banner, kept so the card can fade out with its text still on it (as on /camera). */
function useLastBanner(banner: Banner | null): Banner | null {
  const [last, setLast] = useState<Banner | null>(null);
  useEffect(() => {
    if (banner) setLast(banner);
  }, [banner]);
  return last;
}

const pretty = (s?: string) => (s && s !== "unknown" ? s.replace(/_/g, " ") : "");
const typeLine = (it?: SeenItem["item"]) => (it ? [pretty(it.material), pretty(it.form), pretty(it.condition)].filter(Boolean).join(" · ") : "");
const HOW: Record<string, string> = { catalog: "rule-based bin", llm: "Jev chose the bin", clip: "on-device guess", unclear: "not sure", default: "not sure" };

function statusText(status: LiveStatus, error: string | null, progress: { loaded: number; total: number } | null): string {
  if (status === "loading") return progress?.total ? `Loading the model ${Math.round((100 * progress.loaded) / progress.total)}%` : "Loading the model…";
  if (status === "starting") return "Starting the camera…";
  if (status === "blocked") return "Camera blocked: allow camera access in the address bar, then press Start camera again";
  if (status === "error") return `Couldn't start: ${error}`;
  if (status === "ended") return "Video finished";
  if (status === "live") return "Live";
  return "Off";
}

function ItemRow({ s }: { s: SeenItem }) {
  const [item, bin] = itemAndBin(s.message);
  const dest = s.message.bin as Destination;
  return (
    <li className="flex flex-col gap-1 py-2.5">
      <span className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: DEST_COLOR[dest] }} />
          <span className="truncate text-[15px] font-bold text-ink">{s.item?.name ?? item}</span>
        </span>
        <span className="shrink-0 text-sm text-muted tabular-nums">{s.ms ? `${(s.ms / 1000).toFixed(1)} s` : ""}</span>
      </span>
      <span className="pl-[18px] text-sm text-ink-2">
        {dest === "none" ? bin : DEST_LABEL[dest]}
        {typeLine(s.item) ? ` · ${typeLine(s.item)}` : ""}
        {HOW[s.source] ? <span className="text-muted"> · {HOW[s.source]}</span> : null}
      </span>
    </li>
  );
}

export default function LiveDashboardPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  const [source, setSource] = useState<LiveSource | null>(null);
  useEffect(() => setToken(readGuideKey()), []);
  const live = useLiveGuide(source, token, videoRef, canvasRef);
  const running = live.status === "live";
  const last = useLastBanner(running ? live.banner : null);
  const cardShown = running && live.banner !== null && live.inView;
  const now = live.banner && live.inView ? live.items.at(-1) : undefined;

  const counts = DESTINATIONS.map((d) => [d, live.items.filter((s) => s.message.bin === d).length] as const);
  const button = "min-h-11 rounded-full border border-rule px-5 text-[15px] font-bold text-ink hover:bg-paper-deep disabled:opacity-40";
  const primary = "min-h-11 rounded-full bg-forest px-5 text-[15px] font-bold text-card hover:bg-forest-deep";

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="m-0 font-display text-[40px] leading-none font-bold">Live camera</h1>
          <span className="text-[15px] text-ink-2">Hold an item up to the camera: the voice guide&apos;s model names it and its bin</span>
        </div>
        {token ? (
          <div className="flex flex-wrap items-center gap-2">
            {source ? (
              <button className={button} onClick={() => setSource(null)}>Stop</button>
            ) : (
              <button className={primary} onClick={() => setSource({ kind: "camera", facing: "user" })}>Start camera</button>
            )}
            <button className={button} onClick={() => fileRef.current?.click()}>Play a video</button>
            <input ref={fileRef} type="file" accept="video/*" className="sr-only" onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) setSource({ kind: "file", url: URL.createObjectURL(f), name: f.name, rate: 1 });
              e.target.value = "";
            }} />
            <button className={button} aria-pressed={live.sound} onClick={live.toggleSound}>{live.sound ? "Voice on" : "Voice off"}</button>
          </div>
        ) : (
          <form className="flex items-center gap-2" onSubmit={(e) => {
            e.preventDefault();
            try { localStorage.setItem("guide.token", draft.trim()); } catch { /* this visit only */ }
            setToken(draft.trim());
          }}>
            <input aria-label="Demo key" placeholder="Demo key" type="password" value={draft} onChange={(e) => setDraft(e.target.value)}
              className="min-h-11 w-56 rounded-full border border-rule bg-card px-4 text-[15px]" />
            <button className={primary} type="submit">Unlock</button>
          </form>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4 sm:p-5">
          {/* video and drawing share object-contain on one box, so the boxes line up with the picture */}
          <div className="relative h-[min(68dvh,calc(100vw*1.2))] w-full overflow-hidden rounded-xl bg-night" data-video-box>
            <video ref={videoRef} muted playsInline className="absolute inset-0 h-full w-full object-contain" />
            <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full object-contain" />
            {!source ? (
              <div className="absolute inset-0 flex items-center justify-center p-6 text-center font-display text-[22px] font-bold text-card/80">
                {token ? "Press Start camera" : "Enter the demo key to start"}
              </div>
            ) : null}
            <div aria-live="polite">{last ? <BinCard banner={last} shown={cardShown} /> : null}</div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 px-1 text-sm text-ink-2">
            <span role="status" className="flex items-center gap-2">
              <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-full ${running ? "bg-compost" : live.status === "error" || live.status === "blocked" ? "bg-clay" : "bg-muted-2"}`} />
              {statusText(live.status, live.error, live.progress)}
              {running ? <span className="tabular-nums text-muted"> · {live.fps} fps · {live.backend === "webgpu" ? "GPU" : "CPU"}</span> : null}
            </span>
            {running ? <span className="text-muted">{live.checking ? "Looking at your item…" : live.inView ? "" : "Hold an item up to the camera"}</span> : null}
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-6">
          <Section title="Holding now">
            <div aria-live="polite">
              {!running ? (
                <p className="m-0 text-[15px] text-muted">Start the camera to see what the model sees.</p>
              ) : now ? (
                <div className="flex flex-col gap-3">
                  <span className="font-display text-[30px] leading-tight font-extrabold text-ink">{now.item?.name ?? itemAndBin(now.message)[0]}</span>
                  {typeLine(now.item) ? <span className="text-[15px] text-ink-2">{typeLine(now.item)}</span> : null}
                  <span className="flex flex-wrap items-center gap-3">
                    <span className="inline-flex rounded-full px-3 py-1 text-sm font-bold text-card" style={{ background: DEST_COLOR[now.message.bin as Destination] }}>
                      {now.message.bin === "none" ? itemAndBin(now.message)[1] : DEST_LABEL[now.message.bin as Destination]}
                    </span>
                    {now.item ? <span className="text-sm text-muted tabular-nums">{Math.round(100 * now.item.confidence)}% sure{now.ms ? ` · ${(now.ms / 1000).toFixed(1)} s` : ""}</span> : null}
                  </span>
                </div>
              ) : (
                <p className="m-0 font-display text-[24px] leading-tight font-bold text-ink-2">{live.checking ? "Identifying…" : "Hold an item up to the camera."}</p>
              )}
            </div>
          </Section>
          <Section title="This session">
            <div className="grid grid-cols-2 gap-3">
              {counts.map(([d, n]) => (
                <div key={d} className="flex flex-col rounded-xl bg-paper-deep p-3">
                  <span className="text-xs font-bold text-ink-2">{DEST_LABEL[d]}</span>
                  <span className="mt-1 font-display text-[26px] leading-none font-extrabold tabular-nums" style={{ color: DEST_COLOR[d] }}>{num(n)}</span>
                </div>
              ))}
            </div>
            <ul aria-live="polite" className="m-0 flex max-h-[40vh] list-none flex-col divide-y divide-rule-soft overflow-y-auto border-t border-rule-soft p-0">
              {[...live.items].reverse().map((s, i) => <ItemRow key={`${s.at}-${i}`} s={s} />)}
              {!live.items.length ? <li className="py-2.5 text-sm text-muted">Each item appears here once it is named.</li> : null}
            </ul>
          </Section>
        </div>
      </div>
    </>
  );
}
