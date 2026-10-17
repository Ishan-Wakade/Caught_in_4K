"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LogoMark } from "@/components/shell/Logo";
import { PageNav } from "@/components/shell/SiteHeader";
import { usePageVisible, useBrowserGuide, type GuideStatus } from "@/hooks/useBrowserGuide";
import { APP_NAME } from "@/lib/config";
import type { Banner, Progress } from "@/lib/guide/engine";

/** A banner stays up this long after the item leaves view, so it doesn't flicker between frames. */
const HOLD_MS = 800;

/** Who answered: CLIP on this device, or DeepSeek + Jev on the server (the full model). */
const SOURCE: Record<string, string> = { clip: "on-device CLIP", llm: "DeepSeek + Jev", catalog: "DeepSeek", default: "not sure: trash" };

function useHeldBanner(banner: Banner | null): Banner | null {
  const key = banner ? JSON.stringify(banner) : null;
  const [held, setHeld] = useState<string | null>(key);
  useEffect(() => {
    if (key) {
      setHeld(key);
      return;
    }
    const id = setTimeout(() => setHeld(null), HOLD_MS);
    return () => clearTimeout(id);
  }, [key]);
  return held ? (JSON.parse(held) as Banner) : null;
}

function statusText(status: GuideStatus, people: number, progress: Progress | null): string {
  if (status === "live") return `${people} ${people === 1 ? "person" : "people"} in view`;
  if (status === "loading")
    return progress?.total ? `Loading model ${Math.round((100 * progress.loaded) / progress.total)}%` : "Loading model";
  if (status === "starting") return "Starting camera";
  if (status === "blocked") return "Camera blocked";
  if (status === "error") return "Model failed to load";
  return "Camera off";
}

/** What the page is waiting for (the answer itself is drawn on the video, like the worker's videos). */
function WaitLine({ status, error }: { status: GuideStatus; error: string | null }) {
  const line = status === "blocked" ? "Allow camera access in your browser to start" : status === "error" ? `Couldn't start: ${error}` : null;
  if (!line) return null;
  return <div className="absolute inset-x-0 bottom-20 text-center font-display text-[clamp(22px,3vw,40px)] font-bold text-card">{line}</div>;
}

export default function CameraPage() {
  const visible = usePageVisible();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { status, progress, people, banner, error, smart, sound, enableSound } = useBrowserGuide(visible, videoRef, canvasRef);
  const shown = useHeldBanner(status === "live" ? banner : null);
  const dot = status === "live" ? "bg-compost" : status === "loading" || status === "starting" ? "bg-muted-2" : "bg-clay";

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-black">
      {/* Same layout and padding as SiteHeader, as a bar above the picture so nothing covers the camera view. */}
      <header className="flex shrink-0 items-center justify-between gap-x-7 bg-night px-10 py-2.5">
        <Link href="/" aria-label={`${APP_NAME}, overview`} className="flex min-h-11 items-center gap-2.5 text-card no-underline hover:text-card">
          <LogoMark tone="dark" />
          <span className="font-display text-2xl leading-none font-extrabold">{APP_NAME}</span>
        </Link>
        <PageNav tone="dark" />
      </header>

      <div className="relative min-h-0 flex-1">
      {/* The whole frame (object-contain), like the rendered videos; the overlay shares it, so the drawing lines up. */}
      <video ref={videoRef} muted playsInline className="absolute inset-0 h-full w-full object-contain" />
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full object-contain" />

      <span
        role="status"
        className="absolute right-10 bottom-8 z-10 flex items-center gap-2.5 font-mono text-[17px] text-card [text-shadow:0_1px_3px_rgba(0,0,0,0.5)]"
      >
        <span className={`h-3 w-3 rounded-full ${dot}`} />
        {statusText(status, people, progress)}
        {smart ? " · DeepSeek + Jev" : ""}
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

      <WaitLine status={status} error={error} />
      <div aria-live="polite" className="sr-only">
        {shown ? `${shown.message.bin}. ${shown.message.explanation}${shown.source && SOURCE[shown.source] ? ` (${SOURCE[shown.source]})` : ""}` : ""}
      </div>
      </div>
    </div>
  );
}
