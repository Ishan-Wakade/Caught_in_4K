import { existsSync } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Demo video", description: "How the voice guide works in a store" };

/** Drop the processed video (annotations + voice mixed in, from `recyclone-worker guide --render`) here. */
const VIDEO = "/demo/recording.mp4";

/** 16:9, as large as the space under the header allows (container units), never wider than 1200 px. */
const FIT = "aspect-video w-[min(100cqw,calc(100cqh*16/9),1200px)] rounded-[10px] bg-night";

export default function DemoPage() {
  const ready = existsSync(path.join(process.cwd(), "public", VIDEO));

  return (
    <div className="flex min-h-0 flex-1 p-6 sm:p-10">
      <div className="flex min-h-0 flex-1 items-center justify-center [container-type:size]">
        {ready ? (
          <video src={VIDEO} controls playsInline preload="metadata" className={`${FIT} object-contain`} />
        ) : (
          <div className={`${FIT} flex items-center justify-center`}>
            <span className="text-[15px] text-[#D9DCD0]">Video coming soon</span>
          </div>
        )}
      </div>
    </div>
  );
}
