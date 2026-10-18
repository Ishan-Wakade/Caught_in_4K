"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { LogoMark } from "@/components/shell/Logo";
import { PageNav } from "@/components/shell/SiteHeader";
import { usePageVisible, type GuideStatus } from "@/hooks/useBrowserGuide";
import { readGuideKey, useLiveGuide } from "@/hooks/useLiveGuide";
import { APP_NAME } from "@/lib/config";
import { BIN_HEX } from "@/lib/format";
import { shownText } from "@/lib/guide/message";
import type { Banner, Progress } from "@/lib/guide/engine";
import type { BinType } from "@/lib/types";

/** The bin card fades in when an answer is shown and out when the item leaves view, at the same speed. */
const FADE_MS = 200;

const BIN_TYPE: Record<string, BinType> = { recycle: "recycling", compost: "compost", trash: "trash" };
/** Who answered (shown with ?debug only): Claude with a rule-based bin, or Claude + Jev for an item the rules don't settle. */
const SOURCE: Record<string, string> = { clip: "on-device CLIP", llm: "Claude + Jev", catalog: "Claude (rule-based bin)", default: "not sure: trash" };

/**
 * This page's model (18 Oct): Jolie's live camera engine with the improvements of hooks/useLiveGuide.ts (one Claude
 * call per item, ~110 product types with rule-based bins, head-free crops, no on-device catalog guess), drawn in the
 * worker's look (green skeleton, black item box); the page itself (layout, bin card, prompts) is unchanged. Same
 * fields as useBrowserGuide. The server model needs the demo key (#key=…); without it the page says so.
 */
function useImprovedGuide(active: boolean, videoRef: RefObject<HTMLVideoElement | null>, canvasRef: RefObject<HTMLCanvasElement | null>) {
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => setToken(readGuideKey()), []);
  const source = useMemo(() => (active && token ? ({ kind: "camera", facing: "user" } as const) : null), [active, token]);
  const g = useLiveGuide(source, token ?? "", videoRef, canvasRef, { stamp: false, zone: true });
  const noKey = token === "";
  const status: GuideStatus = noKey ? "error" : token === null ? "loading" : g.status === "idle" || g.status === "ended" ? "paused" : g.status;
  return {
    status, progress: g.progress, people: g.people, banner: g.banner, inView: g.inView, checking: g.checking, unsure: g.unsure,
    error: noKey ? "open this page with the demo key link" : g.error, smart: g.status === "live", sound: g.sound, enableSound: g.toggleSound,
  };
}

/** ?debug in the URL: also show which model answered. Read after mounting, so the server render matches. */
function useDebug(): boolean {
  const [debug, setDebug] = useState(false);
  useEffect(() => setDebug(new URLSearchParams(window.location.search).has("debug")), []);
  return debug;
}

/** The last banner shown, kept so the card can fade out with its text still on it. */
function useLastBanner(banner: Banner | null): Banner | null {
  const key = banner ? JSON.stringify(banner) : null;
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    if (key) setLast(key);
  }, [key]);
  return last ? (JSON.parse(last) as Banner) : null;
}

const fade = (shown: boolean) => ({
  opacity: shown ? 1 : 0,
  transition: `opacity ${FADE_MS}ms ease-out, background-color 200ms`,
});

function statusText(status: GuideStatus, people: number, progress: Progress | null): string {
  if (status === "live") return `${people} ${people === 1 ? "person" : "people"} in view`;
  if (status === "loading")
    return progress?.total ? `Loading model ${Math.round((100 * progress.loaded) / progress.total)}%` : "Loading model";
  if (status === "starting") return "Starting camera";
  if (status === "blocked") return "Camera blocked";
  if (status === "error") return "Model failed to load";
  return "Camera off";
}

/** What the page is waiting for, under the bin card (hidden while the card is shown). */
function PromptLine({ status, error, checking, unsure, hidden }: {
  status: GuideStatus; error: string | null; checking: boolean; unsure: boolean; hidden: boolean;
}) {
  // While loading, the progress is in the status at the bottom right; nothing else competes with it.
  const line =
    status === "blocked"
      ? "Allow camera access in your browser to start"
      : status === "error"
        ? `Couldn't start: ${error}`
        : status === "live"
          ? unsure
            ? "Not sure what this is"
            : checking
              ? "Looking at your item…"
              : "Hold an item up to the camera"
          : null;
  if (!line) return null;
  return (
    <div
      aria-hidden={hidden}
      className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/60 to-transparent px-10 pt-24 pb-10 motion-reduce:transition-none!"
      style={fade(!hidden)}
    >
      <span className="font-display text-[clamp(32px,4vw,56px)] leading-none font-bold text-card">{line}</span>
    </div>
  );
}

/** The bottom band: the bin in huge type. It fades out as soon as the item leaves view, and back in if it returns. */
function BinCard({ banner, shown, debug }: { banner: Banner; shown: boolean; debug: boolean }) {
  const bin = BIN_TYPE[banner.message.bin];
  const background = banner.fallback || !bin ? "#A4502F" : BIN_HEX[bin].fill;
  return (
    <div
      aria-hidden={!shown}
      className="absolute inset-x-0 bottom-0 px-10 pt-5 pb-8 motion-reduce:transition-none!"
      style={{ background, ...fade(shown) }}
    >
      <div className="font-display text-[clamp(88px,15vw,220px)] leading-[0.9] font-extrabold tracking-[-0.02em] text-card">
        {banner.message.bin.toUpperCase()}
      </div>
      <div className="mt-2 text-[clamp(22px,2.4vw,34px)] leading-snug text-card">
        {shownText(banner.message)}.
      </div>
      {debug && banner.source && SOURCE[banner.source] ? (
        <div className="mt-1 font-mono text-[15px] text-card/75">{SOURCE[banner.source]}</div>
      ) : null}
    </div>
  );
}

export default function CameraPage() {
  const visible = usePageVisible();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { status, progress, people, banner, inView, checking, unsure, error, smart, sound, enableSound } = useImprovedGuide(visible, videoRef, canvasRef);
  const debug = useDebug();
  const last = useLastBanner(status === "live" ? banner : null);
  const cardShown = status === "live" && banner !== null && inView;
  const dot = status === "live" ? "bg-compost" : status === "loading" || status === "starting" ? "bg-muted-2" : "bg-clay";

  return (
    <div className="fixed inset-0 overflow-hidden bg-night">
      {/* The video and its overlay share object-cover, so the drawing lines up with the picture. */}
      <video ref={videoRef} muted playsInline className="absolute inset-0 h-full w-full object-cover" />
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full object-cover" />

      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-32 bg-linear-to-b from-black/55 to-transparent" />
      {/* Same layout and padding as SiteHeader, so the page links sit exactly where they do on every page. */}
      <header className="absolute inset-x-0 top-0 flex items-center justify-between gap-x-7 border-b border-transparent px-10 py-2.5">
        <Link href="/" aria-label={`${APP_NAME}, overview`} className="flex min-h-11 items-center gap-2.5 text-card no-underline hover:text-card">
          <LogoMark tone="dark" />
          <span className="font-display text-2xl leading-none font-extrabold">{APP_NAME}</span>
        </Link>
        <PageNav tone="dark" />
      </header>

      <span
        role="status"
        className="absolute right-10 bottom-8 z-10 flex items-center gap-2.5 font-mono text-[17px] text-card [text-shadow:0_1px_3px_rgba(0,0,0,0.5)]"
      >
        <span className={`h-3 w-3 rounded-full ${dot}`} />
        {statusText(status, people, progress)}
        {debug && smart ? " · Claude" : ""}
      </span>
      {smart ? (
        <button
          type="button"
          onClick={enableSound}
          aria-pressed={sound}
          className="absolute top-20 right-10 z-10 min-h-11 rounded-full bg-black/45 px-5 font-mono text-[17px] text-card"
        >
          {sound ? "🔊 Sound on" : "🔇 Sound off"}
        </button>
      ) : null}

      <div aria-live="polite">
        <PromptLine status={status} error={error} checking={checking} unsure={unsure} hidden={cardShown} />
        {last ? <BinCard banner={last} shown={cardShown} debug={debug} /> : null}
      </div>
    </div>
  );
}
