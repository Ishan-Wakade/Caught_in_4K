"use client";

import { useEffect, useState } from "react";

/** Drop processed clips in apps/web/public/footage/ and list them here — a CCTV-style wall */
const CAMERAS = [
  { file: "IMG_9117_demo.mp4", label: "CAM 01" },
  { file: "IMG_9118_demo.mp4", label: "CAM 02" },
  { file: "IMG_9119_demo.mp4", label: "CAM 03" },
  { file: "IMG_9120_demo.mp4", label: "CAM 04" },
  { file: "IMG_9121_demo.mp4", label: "CAM 05" },
];

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  // Rendered empty on the server, filled in after mount: a clock can't match between server and client.
  return <span className="font-mono text-xs tabular-nums text-[#D9DCD0]">{now ? now.toLocaleTimeString("en-US", { hour12: false }) : ""}</span>;
}

function CameraTile({ file, label, onExpand }: { file: string; label: string; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      aria-label={`Expand ${label}`}
      className="group relative aspect-video overflow-hidden rounded-md border border-[#3A3C38] bg-night text-left"
    >
      <video
        src={`/footage/${file}`}
        autoPlay
        loop
        muted
        playsInline
        preload="metadata"
        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.02]"
      />
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-2.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 rounded bg-black/50 px-1.5 py-0.5 text-xs font-bold tracking-wide text-[#D9DCD0]">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-clay" />
            {label}
          </span>
          <span className="rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-clay-light">REC</span>
        </div>
        <div className="self-end rounded bg-black/50 px-1.5 py-0.5">
          <Clock />
        </div>
      </div>
    </button>
  );
}

function ExpandedCamera({ file, label, onClose }: { file: string; label: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${label} expanded`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
    >
      <div onClick={(e) => e.stopPropagation()} className="relative flex max-h-[85vh] max-w-[90vw]">
        <video
          src={`/footage/${file}`}
          autoPlay
          loop
          muted
          playsInline
          className="max-h-[85vh] max-w-[90vw] rounded-md border border-[#3A3C38] bg-night object-contain"
        />
        <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-3.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 rounded bg-black/50 px-2 py-1 text-sm font-bold tracking-wide text-[#D9DCD0]">
              <span className="h-2 w-2 animate-pulse rounded-full bg-clay" />
              {label}
            </span>
            <span className="rounded bg-black/50 px-2 py-1 text-xs font-bold tracking-widest text-clay-light">REC</span>
          </div>
          <div className="self-end rounded bg-black/50 px-2 py-1">
            <Clock />
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="pointer-events-auto absolute -top-10 right-0 text-sm font-bold text-[#D9DCD0] hover:text-white"
        >
          Close ✕
        </button>
      </div>
    </div>
  );
}

export default function LiveFootagePage() {
  const [expanded, setExpanded] = useState<string | null>(null);
  const active = CAMERAS.find((c) => c.file === expanded) ?? null;

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-[40px] leading-none font-bold">Live footage</h1>
        <span className="text-[15px] text-ink-2">Recorded demo clips, played back as a camera wall. Click a camera to expand it.</span>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CAMERAS.map((c) => (
          <CameraTile key={c.file} {...c} onExpand={() => setExpanded(c.file)} />
        ))}
      </div>
      {active && <ExpandedCamera file={active.file} label={active.label} onClose={() => setExpanded(null)} />}
    </>
  );
}
