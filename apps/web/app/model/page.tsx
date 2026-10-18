"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { LogoMark } from "@/components/shell/Logo";
import { APP_NAME } from "@/lib/config";
import { useLiveModel, readGuideKey, type LiveSource, type LiveStatus } from "@/hooks/useLiveModel";
import { itemAndBin, outcomeText } from "@/lib/live/overlay";
import type { Event } from "@/lib/live/watch";

const SOURCE_NAME: Record<string, string> = { catalog: "catalog bin", llm: "Jev bin", unclear: "not sure", nothing_held: "nothing held", error: "error" };

function statusLine(status: LiveStatus, error: string | null, progress: { loaded: number; total: number } | null): string {
  if (status === "loading") return progress?.total ? `Loading models ${Math.round((100 * progress.loaded) / progress.total)}%` : "Loading models…";
  if (status === "starting") return "Starting…";
  if (status === "blocked") return "Allow camera access to start";
  if (status === "error") return `Couldn't start: ${error}`;
  if (status === "ended") return "Video finished";
  if (status === "live") return "Live";
  return "Pick a camera or a video file";
}

function EventRow({ e }: { e: Event }) {
  const a = e.answer;
  const [item, bin] = a?.message ? itemAndBin(a.message) : ["(not identified)", "—"];
  const verdict = a?.message && e.outcome ? outcomeText(a.message, e.outcome) : null;
  const sure = a?.source !== "unclear";
  return (
    <li className="grid grid-cols-[3.5rem_1fr] gap-x-3 border-t border-white/10 py-2 font-mono text-[14px] leading-snug">
      <span className="text-white/50">{e.t.toFixed(1)}s</span>
      <span>
        <span className="font-semibold text-white">{a?.item?.name ?? item}</span>
        {a?.item ? <span className="text-white/60"> · {[a.item.material, a.item.form, a.item.condition].filter((x) => x && x !== "unknown").join(" · ").replace(/_/g, " ")} · {Math.round(100 * a.item.confidence)}%</span> : null}
        <br />
        <span className="text-white/80">Bin: {bin}</span>
        {a ? <span className="text-white/50"> ({SOURCE_NAME[a.source] ?? a.source}{(a as { ms?: number }).ms ? `, ${((a as { ms?: number }).ms! / 1000).toFixed(1)} s` : ""})</span> : null}
        {e.outcome ? (
          <>
            <br />
            <span className="text-white/80">{verdict ? verdict[0] : `Thrown in: ${e.outcome.label}`} </span>
            {verdict && sure ? <span className={verdict[2] ? "font-bold text-green-400" : "font-bold text-red-400"}>{verdict[1]}</span> : null}
          </>
        ) : null}
      </span>
    </li>
  );
}

export default function LivePage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  const [source, setSource] = useState<LiveSource | null>(null);
  const [rate, setRate] = useState(1);
  useEffect(() => setToken(readGuideKey()), []);
  const live = useLiveModel(source, token, videoRef, canvasRef);

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (source?.kind === "file") URL.revokeObjectURL(source.url);
    setSource({ kind: "file", url: URL.createObjectURL(f), name: f.name, rate });
  };
  const button = "min-h-11 rounded-full bg-white/10 px-4 font-mono text-[15px] text-white hover:bg-white/20 disabled:opacity-40";

  return (
    <div className="min-h-dvh bg-[#0b0d0c] text-white">
      <header className="flex items-center justify-between px-4 py-2.5 sm:px-8">
        <Link href="/" className="flex min-h-11 items-center gap-2.5 text-white no-underline">
          <LogoMark tone="dark" />
          <span className="font-display text-xl leading-none font-extrabold">{APP_NAME}</span>
        </Link>
        <span className="font-mono text-[14px] text-white/60">live model · Claude</span>
      </header>

      {!token ? (
        <form
          className="mx-4 flex flex-wrap items-center gap-2 sm:mx-8"
          onSubmit={(e) => {
            e.preventDefault();
            try { localStorage.setItem("guide.token", draft.trim()); } catch { /* private mode: this visit only */ }
            setToken(draft.trim());
          }}
        >
          <label className="font-mono text-[15px]" htmlFor="key">Demo key</label>
          <input id="key" type="password" value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-11 flex-1 rounded-lg bg-white/10 px-3 font-mono" />
          <button className={button} type="submit">Use</button>
        </form>
      ) : (
        <div className="mx-4 flex flex-wrap items-center gap-2 sm:mx-8">
          <button className={button} onClick={() => setSource({ kind: "camera", facing: "environment" })}>Back camera</button>
          <button className={button} onClick={() => setSource({ kind: "camera", facing: "user" })}>Front camera</button>
          <label className={`${button} flex cursor-pointer items-center`}>
            Video file
            <input type="file" accept="video/*" className="sr-only" onChange={(e) => pickFile(e.target.files?.[0])} />
          </label>
          <select aria-label="Video file speed" value={rate} onChange={(e) => setRate(Number(e.target.value))} className={button}>
            <option value={1}>1x</option>
            <option value={0.5}>0.5x</option>
            <option value={0.25}>0.25x</option>
          </select>
          <button className={button} disabled={live.status !== "live"} onClick={() => void live.findBins()}>Find bins again</button>
          <button className={button} aria-pressed={live.sound} onClick={live.toggleSound}>{live.sound ? "🔊 Sound on" : "🔇 Sound off"}</button>
          {source ? <button className={button} onClick={() => setSource(null)}>Stop</button> : null}
        </div>
      )}

      <div className="mt-3 grid gap-4 px-4 pb-6 sm:px-8 lg:grid-cols-[1fr_22rem]">
        {/* video and overlay share object-contain on the same box, so the drawing lines up with the picture */}
        <div className="relative h-[min(72dvh,calc(100vw*1.3))] w-full overflow-hidden rounded-lg bg-black" data-video-box>
          <video ref={videoRef} muted playsInline className="absolute inset-0 h-full w-full object-contain" />
          <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full object-contain" />
        </div>
        <aside className="font-mono text-[14px]">
          <p role="status" className="text-[15px]">
            {statusLine(live.status, live.error, live.progress)}
            {live.status === "live" ? ` · ${live.fps} fps · ${live.backend}` : ""}
          </p>
          <p className="mt-1 text-white/70">
            Bins:{" "}
            {live.bins.state === "looking"
              ? "looking…"
              : live.bins.state === "found"
                ? `${live.openings.map((o) => o.label).join(", ")} (${((live.bins.ms ?? 0) / 1000).toFixed(1)} s)`
                : live.bins.state === "failed"
                  ? `none (${live.bins.note})`
                  : "—"}
          </p>
          <h2 className="mt-4 text-[13px] tracking-wide text-white/50 uppercase">Items</h2>
          <ul aria-live="polite">
            {[...live.events].reverse().map((e, i) => <EventRow key={`${e.t}-${i}`} e={e} />)}
          </ul>
          {!live.events.length ? <p className="text-white/40">Each item appears here when it goes into a bin or leaves view.</p> : null}
        </aside>
      </div>
    </div>
  );
}
