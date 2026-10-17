"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LogoMark } from "@/components/shell/Logo";
import { PageNav } from "@/components/shell/SiteHeader";
import { usePageVisible, useBrowserGuide, type GuideStatus } from "@/hooks/useBrowserGuide";
import { APP_NAME } from "@/lib/config";
import { BIN_HEX } from "@/lib/format";
import type { Banner, Progress } from "@/lib/guide/engine";
import type { BinType } from "@/lib/types";

/** A banner stays up this long after the item leaves view, so it doesn't flicker between frames. */
const HOLD_MS = 800;

const BIN_TYPE: Record<string, BinType> = { recycle: "recycling", compost: "compost", trash: "trash" };

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

/** The bottom band: the bin in huge type, or what the page is waiting for. */
function BinBanner({ banner, status, error }: { banner: Banner | null; status: GuideStatus; error: string | null }) {
  if (!banner) {
    // While loading, the progress is in the status at the bottom right; nothing else competes with it.
    const line =
      status === "blocked"
        ? "Allow camera access in your browser to start"
        : status === "error"
          ? `Couldn't start: ${error}`
          : status === "live"
            ? "Hold an item up to the camera"
            : null;
    if (!line) return null;
    return (
      <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/60 to-transparent px-10 pt-24 pb-10">
        <span className="font-display text-[clamp(32px,4vw,56px)] leading-none font-bold text-card">{line}</span>
      </div>
    );
  }
  const bin = BIN_TYPE[banner.message.bin];
  const background = banner.fallback || !bin ? "#A4502F" : BIN_HEX[bin].fill;
  const explanation = banner.message.explanation;
  return (
    <div className="absolute inset-x-0 bottom-0 px-10 pt-5 pb-8 transition-colors duration-200" style={{ background }}>
      <div className="font-display text-[clamp(88px,15vw,220px)] leading-[0.9] font-extrabold tracking-[-0.02em] text-card">
        {banner.message.bin.toUpperCase()}
      </div>
      <div className="mt-2 text-[clamp(22px,2.4vw,34px)] leading-snug text-card">
        {explanation.charAt(0).toUpperCase() + explanation.slice(1)}.
      </div>
    </div>
  );
}

export default function CameraPage() {
  const visible = usePageVisible();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { status, progress, people, banner, error } = useBrowserGuide(visible, videoRef, canvasRef);
  const shown = useHeldBanner(status === "live" ? banner : null);
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
      </span>

      <div aria-live="polite">
        <BinBanner banner={shown} status={status} error={error} />
      </div>
    </div>
  );
}
