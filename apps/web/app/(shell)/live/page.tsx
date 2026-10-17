"use client";

import { useState } from "react";
import { useDisposals, type Disposal } from "@/hooks/useDisposals";
import { WORKER_URL } from "@/lib/config";
import { BIN_HEX, BIN_LABEL, time } from "@/lib/format";
import { SITE } from "@/lib/site";

/** Painted stand-in for the patio when no worker stream is available. Clearly labeled as such. */
function PatioIllustration() {
  const bins = SITE.bins.slice(0, 3);
  return (
    <div
      aria-hidden="true"
      className="absolute inset-0"
      style={{
        background:
          "repeating-linear-gradient(90deg, rgba(255,253,248,0) 0 118px, rgba(255,253,248,0.05) 118px 120px), linear-gradient(180deg, #3A4136 0 46%, #4A5044 46% 100%)",
      }}
    >
      <div className="absolute inset-x-0 top-[46%] h-1.5 bg-[#545A4C]" />
      <div className="absolute top-[58%] left-[5%] h-[5%] w-[27%] rounded-[10px] bg-[#5C6253]" />
      <div className="absolute top-[63%] left-[7%] h-[12%] w-[2%] rounded bg-[#545A4C]" />
      <div className="absolute top-[63%] left-[28%] h-[12%] w-[2%] rounded bg-[#545A4C]" />
      {bins.map((b, i) => (
        <div key={b.bin_id} className="absolute bottom-[22%] h-[34%] w-[10.5%]" style={{ left: `${50 + i * 13.5}%` }}>
          <div className="flex h-full flex-col overflow-hidden rounded-[10px] bg-[#343A31]">
            <div className="h-4" style={{ background: BIN_HEX[b.type].onDark }} />
          </div>
          <span className="absolute -top-8 left-0.5 flex items-center gap-2 text-lg font-bold whitespace-nowrap text-card">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: BIN_HEX[b.type].onDark }} />
            {BIN_LABEL[b.type]}
          </span>
        </div>
      ))}
    </div>
  );
}

function Headline({ d }: { d: Disposal | undefined }) {
  if (!d) {
    return (
      <>
        <span className="font-display text-[56px] leading-[1.02] font-bold tracking-[-0.01em] text-balance">Watching the patio bins</span>
        <span className="text-[21px] leading-snug text-ink-2">Each drop the camera sees will show up here.</span>
      </>
    );
  }
  const bin = d.bin ? BIN_LABEL[d.bin] : "a bin";
  let title: string;
  let line: string;
  if (d.outcome === "unassessable" || !d.identified) {
    title = "Couldn't tell what that was";
    line = `Something went into ${bin}. Items we can't identify don't count as mistakes.`;
  } else if (d.outcome === "incorrect") {
    title = `${d.item_name} went into ${bin}`;
    line = d.belongs_in ? `Here, this belongs in ${BIN_LABEL[d.belongs_in]}.` : "That's not its bin here.";
  } else {
    title = `${d.item_name} went into ${bin}`;
    line = "Right bin.";
  }
  const credit = d.in_review
    ? "not sure whose it is · the area manager will check"
    : d.business_name
      ? `counted toward ${d.business_name}`
      : d.identified
        ? "no restaurant attached to this item"
        : null;
  return (
    <>
      <span className="font-display text-[56px] leading-[1.02] font-bold tracking-[-0.01em] text-balance">{title}</span>
      <span className={`text-[21px] leading-snug ${d.outcome === "incorrect" ? "font-bold text-clay-deep" : "text-ink-2"}`}>{line}</span>
      {credit && <span className="text-[15px] text-muted">{credit}</span>}
    </>
  );
}

function Verdict({ d }: { d: Disposal }) {
  if (d.in_review) return <span className="text-muted italic">· we&apos;ll double-check</span>;
  if (d.outcome === "incorrect")
    return <span className="font-bold text-clay-deep">· should be {d.belongs_in ? BIN_LABEL[d.belongs_in] : "elsewhere"}</span>;
  if (d.outcome === "correct") return <span className="text-forest">· right bin</span>;
  return <span className="text-muted italic">· couldn&apos;t tell</span>;
}

export default function LivePage() {
  const disposals = useDisposals();
  const [streamFailed, setStreamFailed] = useState(false);
  const stream = WORKER_URL && !streamFailed ? `${WORKER_URL}/stream.mjpg` : null;
  const latest = disposals[0];
  const recent = disposals.slice(0, 5);
  const dot = latest?.outcome === "incorrect" ? "bg-clay" : latest?.outcome === "correct" ? "bg-compost" : "bg-muted-2";

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex flex-1 flex-wrap items-center gap-x-14 gap-y-6 px-10 pt-5 pb-6">
        <div role="status" className="flex max-w-[560px] min-w-0 flex-[1_1_380px] flex-col gap-3.5">
          <span className="flex items-center gap-2.5 font-mono text-base text-muted">
            {latest ? (
              <>
                <span className={`h-3 w-3 rounded-full ${dot}`} />
                Latest drop · {time(latest.at)}
              </>
            ) : (
              "No drops yet"
            )}
          </span>
          <Headline d={latest} />
        </div>

        <figure aria-label="Camera footage with detections" className="m-0 flex min-w-0 flex-[1.7_1_620px] flex-col gap-2">
          <div className="relative h-[min(560px,58vh)] min-h-[380px] overflow-hidden rounded-[28px] shadow-[0_16px_40px_rgba(50,45,25,0.14)]">
            {stream ? (
              // MJPEG must be a plain <img>; next/image can't stream it.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={stream} alt="Annotated camera footage from the CV worker" className="absolute inset-0 h-full w-full object-cover" onError={() => setStreamFailed(true)} />
            ) : (
              <PatioIllustration />
            )}
            <span className="absolute top-[18px] left-5 font-mono text-sm text-[#E6E8DE]">{SITE.cameras[0]?.name ?? "Camera"}</span>
          </div>
          <figcaption className="text-xs text-muted-2">
            {stream
              ? "Recorded footage · processed live by the CV worker"
              : WORKER_URL
                ? "Camera stream unavailable · this is a drawing of the patio, not footage"
                : "No camera connected · this is a drawing of the patio, not footage"}
          </figcaption>
        </figure>
      </div>

      <section aria-labelledby="drops-h" className="bg-paper-deep px-10 pt-4 pb-[18px]">
        <h2 id="drops-h" className="m-0 mb-2 font-display text-xl font-bold">Recent drops</h2>
        {recent.length === 0 && <span className="text-base text-muted">Nothing yet.</span>}
        <div className="flex flex-wrap items-stretch gap-y-4">
          {recent.map((d, i) => (
            <div
              key={d.cursor}
              className={`flex min-w-0 flex-col gap-1 ${i === 0 ? "flex-[1.6_1_300px] pr-7" : "flex-[1_1_200px] border-l border-rule px-6"} ${i === recent.length - 1 && i > 0 ? "pr-0" : ""}`}
            >
              <span className="font-mono text-[13px] text-muted">{time(d.at)}</span>
              <span className={`${i === 0 ? "text-[24px] leading-[1.15]" : "text-[18px] leading-[1.2]"}`}>
                {d.business_name ? (
                  <>
                    <strong>{d.business_name}</strong> {d.item_name.replace(new RegExp(`^${d.business_name}\\s*`), "")}
                  </>
                ) : (
                  d.item_name
                )}
              </span>
              <span className={`flex flex-wrap items-center gap-x-2 ${i === 0 ? "text-[16px]" : "text-[15px]"} text-ink-2`}>
                {d.bin && <span className="inline-block h-[9px] w-[9px] rounded-full" style={{ background: BIN_HEX[d.bin].fill }} />}
                {d.bin ? BIN_LABEL[d.bin] : "Unknown bin"} <Verdict d={d} />
                {d.labeled && <span className="text-xs text-clay-deep">· labeled backup input</span>}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
