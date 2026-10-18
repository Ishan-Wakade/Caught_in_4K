import type { Metadata } from "next";

export const metadata: Metadata = { title: "Install", description: "How a store sets up the voice guide" };

const NEEDS = [
  ["Your security camera", "The one that already sees your bins. No new camera needed."],
  ["A computer", "Sits in the back office. We tell you which one to get."],
  ["A speaker", "Placed by the bins, plugged into the computer."],
];

const STEPS = [
  ["Download Caught in 4K", "Download and install Caught in 4K on your restaurant's computer."],
  ["Connect your speaker and cameras", "Connect your speaker and existing surveillance cameras to the computer."],
  ["Show it what you serve", "Hold each cup, container, wrapper or other item you serve in front of the camera for a few seconds so Caught in 4K can recognize it."],
];

export default function InstallPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-14 px-6 pt-16 pb-24 sm:px-10">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h1 className="m-0 font-display text-[clamp(28px,4vw,40px)] leading-tight font-bold">Set it up in your store</h1>
        <span className="text-[15px] text-muted-2">Coming soon.</span>
      </div>

      <section aria-labelledby="needs-h" className="flex flex-col gap-4">
        <h2 id="needs-h" className="m-0 text-sm font-medium text-muted-2">what you need</h2>
        <ul className="m-0 grid list-none gap-6 p-0 sm:grid-cols-3">
          {NEEDS.map(([what, detail]) => (
            <li key={what} className="flex flex-col gap-1">
              <span className="text-[17px] font-bold text-ink">{what}</span>
              <span className="text-[15px] leading-snug text-muted">{detail}</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="steps-h" className="flex flex-col gap-4">
        <h2 id="steps-h" className="m-0 text-sm font-medium text-muted-2">steps</h2>
        <ol className="m-0 flex list-none flex-col gap-6 p-0">
          {STEPS.map(([title, detail], i) => (
            <li key={title} className="grid grid-cols-[2rem_1fr] gap-x-3">
              <span className="font-mono text-[17px] text-forest">{i + 1}</span>
              <div className="flex flex-col gap-1">
                <span className="text-[17px] font-bold text-ink">{title}</span>
                <span className="text-[15px] leading-snug text-muted">{detail}</span>
              </div>
            </li>
          ))}
        </ol>
        <p className="m-0 pl-[2.75rem] text-[15px] text-ink">That&apos;s it. Anyone walking up to your bins now hears which one their item goes in.</p>
      </section>

      <details className="text-[15px]">
        <summary className="w-max cursor-pointer text-sm text-muted-2 hover:text-ink">for your IT team</summary>
        <ul className="mt-3 flex list-disc flex-col gap-1 pl-5 text-muted">
          <li>Runs as one Docker container per store, on Linux with an NVIDIA GPU.</li>
          <li>Connects to network cameras over RTSP / ONVIF.</li>
          <li>Footage, logs and your catalog stay on the store&apos;s computer.</li>
          <li>Items not in your catalog are identified by a cloud AI service: only a crop of the item is sent, with faces blacked out.</li>
        </ul>
      </details>
    </div>
  );
}
