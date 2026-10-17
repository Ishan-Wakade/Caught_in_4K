import { existsSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Demo video", description: "How the voice guide works in a store" };

/** Drop the processed video (annotations + voice mixed in, from `recyclone-worker guide --render`) here. */
const VIDEO = "/demo/recording.mp4";

export default function DemoPage() {
  const ready = existsSync(path.join(process.cwd(), "public", VIDEO));

  return (
    <div className="flex flex-col items-center gap-6">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h1 className="m-0 font-display text-[clamp(28px,4vw,40px)] leading-tight font-bold">How it works in a store</h1>
        <span className="text-[15px] text-muted-2">Sound on to hear the speaker.</span>
      </div>

      {ready ? (
        <video src={VIDEO} controls playsInline preload="metadata" className="w-full rounded-[10px] bg-night" />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded-[10px] bg-night">
          <span className="text-[15px] text-[#D9DCD0]">Video coming soon</span>
        </div>
      )}
    </div>
  );
}
