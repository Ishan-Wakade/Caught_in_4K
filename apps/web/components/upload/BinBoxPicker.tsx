"use client";

import { useRef, useState } from "react";
import type { Box } from "@/lib/upload";

const MIN = 0.02; // a smaller drag is a tap, not a box (the worker refuses boxes under 2% of the frame)

/**
 * The clip, and in "draw" mode its first frame with one box dragged around the bins (fractions of the frame, so it
 * lands in the same place on the worker's normalised copy). The wrapper has the video's aspect ratio, so the overlay
 * covers exactly the picture.
 */
export function BinBoxPicker({ url, box, drawing, onBox, onDuration }: {
  url: string;
  box: Box | null;
  drawing: boolean;
  onBox: (box: Box | null) => void;
  onDuration: (seconds: number) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const [drag, setDrag] = useState<{ x: number; y: number; box: Box } | null>(null);

  const at = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), y: Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1) };
  };
  const shown = drag?.box ?? box;

  return (
    <div className="relative mx-auto overflow-hidden rounded-[10px] bg-night" style={{ aspectRatio: aspect, width: `min(100%, calc(62vh * ${aspect}))` }}>
      <video
        ref={video}
        src={`${url}#t=0.1`}
        controls={!drawing}
        muted
        playsInline
        preload="auto"
        className="absolute inset-0 h-full w-full"
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight);
          onDuration(v.duration); // Infinity for some browser recordings: checked again on the server
        }}
      />
      {drawing && (
        <div
          role="application"
          aria-label="Drag a box around the bins"
          className="absolute inset-0 cursor-crosshair touch-none"
          onPointerDown={(e) => {
            if (video.current) {
              video.current.pause();
              video.current.currentTime = 0.1; // the first frame, where the worker looks for the bins
            }
            e.currentTarget.setPointerCapture(e.pointerId);
            const p = at(e);
            setDrag({ ...p, box: { x0: p.x, y0: p.y, x1: p.x, y1: p.y } });
          }}
          onPointerMove={(e) => {
            if (!drag) return;
            const p = at(e);
            setDrag({ ...drag, box: { x0: Math.min(drag.x, p.x), y0: Math.min(drag.y, p.y), x1: Math.max(drag.x, p.x), y1: Math.max(drag.y, p.y) } });
          }}
          onPointerUp={() => {
            if (!drag) return;
            const b = drag.box;
            onBox(b.x1 - b.x0 >= MIN && b.y1 - b.y0 >= MIN ? b : null);
            setDrag(null);
          }}
        />
      )}
      {shown && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute border-2 border-leaf bg-leaf/15 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
          style={{ left: `${shown.x0 * 100}%`, top: `${shown.y0 * 100}%`, width: `${(shown.x1 - shown.x0) * 100}%`, height: `${(shown.y1 - shown.y0) * 100}%` }}
        >
          <span className="absolute top-0 left-0 rounded-br bg-leaf px-1.5 text-xs font-bold text-night">bins</span>
        </div>
      )}
    </div>
  );
}
