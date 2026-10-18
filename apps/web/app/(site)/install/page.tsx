import type { Metadata } from "next";

export const metadata: Metadata = { title: "Install", description: "How a store sets up the voice guide" };

const NEEDS = [
  ["Your security camera", "One that sees your bins and the walkway up to them, and can stream video over RTSP."],
  ["A computer", "A small one with a graphics card, kept in the back office. We'll tell you which one to get."],
  ["A speaker", "Placed by the bins and connected to the computer."],
  ["Internet", "To identify items Caught in 4K hasn't seen before."],
];

const STEPS = [
  ["Install Caught in 4K", "Install Caught in 4K on that computer."],
  ["Connect your camera and speaker", "Connect your existing security camera and the speaker to the computer."],
  ["Calibrate your camera", "A one-off setup that shows Caught in 4K where your bins are."],
  ["Pick your city's rules", "Caught in 4K decides each bin using your local recycling and compost rules."],
  ["Approve new items", "Items it learns appear in your dashboard's New items list for you to approve."],
];

export default function InstallPage() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-14 px-6 pt-16 pb-24 sm:px-10">
      <div className="flex flex-col items-center gap-1.5 text-center">
        <h1 className="m-0 font-display text-[clamp(28px,4vw,40px)] leading-tight font-bold">Set it up in your store</h1>
      </div>

      <section aria-labelledby="needs-h" className="flex flex-col gap-4">
        <h2 id="needs-h" className="m-0 text-sm font-medium text-muted-2">what you need</h2>
        <ul className="m-0 grid list-none gap-6 p-0 sm:grid-cols-2">
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
          <li>Planned: one Docker container per store, on Linux with an NVIDIA GPU.</li>
          <li>Works with network cameras that stream over RTSP, including ONVIF cameras.</li>
          <li>Footage, logs and your catalog stay on the store&apos;s computer.</li>
          <li>Items not in your catalog are identified by a cloud AI service: only a crop of the item is sent, with faces blacked out.</li>
          <li>With the ElevenLabs voice, the text of each spoken sentence is sent to ElevenLabs.</li>
        </ul>
      </details>
    </div>
  );
}
