"use client";

import { useEffect, useRef, useState } from "react";
import { UPLOAD_API_URL } from "@/lib/config";
import {
  createJob, errorInfo, getJob, MAX_BYTES, MAX_SECONDS, POLL_MS, STAGES, stageIndex, UploadError, videoUrl, type Box,
  type JobStatus,
} from "@/lib/upload";
import { BinBoxPicker } from "./BinBoxPicker";
import { Recorder } from "./Recorder";

type Clip = { blob: Blob; url: string };
type Step =
  | { kind: "choose" }
  | { kind: "record" }
  | { kind: "review" }
  | { kind: "uploading"; progress: number }
  | { kind: "processing"; id: string; job: JobStatus | null }
  | { kind: "result"; id: string }
  | { kind: "error"; code: string };

const PRIMARY = "flex min-h-11 items-center justify-center rounded-lg bg-forest px-5 font-bold text-card no-underline hover:bg-forest-deep hover:text-card disabled:opacity-50";
const SECONDARY = "flex min-h-11 items-center justify-center rounded-lg border border-forest px-5 font-bold text-forest no-underline hover:bg-forest hover:text-card";

const TIPS = [
  "Keep the bins in the shot the whole time.",
  "Hold the item where the camera can see it as you walk up.",
  "Prop the phone up a few metres away, so your whole body is in view as you walk up.",
  `5 to ${MAX_SECONDS} seconds is plenty.`,
];

function setJobInUrl(id: string | null) {
  window.history.replaceState(null, "", id ? `?job=${encodeURIComponent(id)}` : window.location.pathname);
}

/** Record or choose a clip → optional bin box → upload → processing on the GPU → the annotated video with the voice. */
export function UploadFlow() {
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [clip, setClip] = useState<Clip | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [drawing, setDrawing] = useState(false);
  const duration = useRef<number>(NaN);
  const abort = useRef<(() => void) | null>(null);

  // a shared or reopened link (?job=...) goes straight to that job
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("job");
    if (id) setStep({ kind: "processing", id, job: null });
  }, []);

  useEffect(() => () => abort.current?.(), []);

  function takeClip(blob: Blob) {
    if (clip) URL.revokeObjectURL(clip.url);
    setClip({ blob, url: URL.createObjectURL(blob) });
    setBox(null);
    setDrawing(false);
    duration.current = NaN;
    setStep({ kind: "review" });
  }

  function startOver() {
    abort.current?.();
    if (clip) URL.revokeObjectURL(clip.url);
    setClip(null);
    setBox(null);
    setJobInUrl(null);
    setStep({ kind: "choose" });
  }

  async function upload() {
    if (!clip) return;
    if (clip.blob.size > MAX_BYTES) return setStep({ kind: "error", code: "too_large" });
    if (Number.isFinite(duration.current) && duration.current > MAX_SECONDS + 0.5) return setStep({ kind: "error", code: "too_long" });
    setDrawing(false);
    setStep({ kind: "uploading", progress: 0 });
    const job = createJob(clip.blob, box, (progress) => setStep({ kind: "uploading", progress }));
    abort.current = job.abort;
    try {
      const id = await job.done;
      setJobInUrl(id);
      setStep({ kind: "processing", id, job: null });
    } catch (e) {
      const code = e instanceof UploadError ? e.code : "failed";
      if (code !== "aborted") setStep({ kind: "error", code });
    } finally {
      abort.current = null;
    }
  }

  // poll the job while it runs
  const pollingId = step.kind === "processing" ? step.id : null;
  useEffect(() => {
    if (!pollingId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const job = await getJob(pollingId);
        if (stopped) return;
        if (job.status === "done") return setStep({ kind: "result", id: pollingId });
        if (job.status === "error") return setStep({ kind: "error", code: job.code ?? "failed" });
        setStep({ kind: "processing", id: pollingId, job });
      } catch (e) {
        if (stopped) return;
        const code = e instanceof UploadError ? e.code : "failed";
        if (code !== "network") return setStep({ kind: "error", code }); // a dropped poll is retried
      }
      timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pollingId]);

  if (!UPLOAD_API_URL) {
    return (
      <Shell>
        <p className="m-0 text-center text-[15px] text-muted">Video uploads aren&apos;t switched on for this site yet.</p>
      </Shell>
    );
  }

  return (
    <Shell>
      {step.kind === "choose" && (
        <div className="flex flex-col items-center gap-8">
          <div className="flex flex-wrap justify-center gap-3">
            <button type="button" className={PRIMARY} onClick={() => setStep({ kind: "record" })}>
              Record a video
            </button>
            <label className={`${SECONDARY} cursor-pointer`}>
              Choose a video
              <input type="file" accept="video/*" className="sr-only" onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) takeClip(f);
              }} />
            </label>
          </div>
          <ul className="m-0 grid max-w-xl list-none gap-2 p-0 text-[15px] text-muted sm:grid-cols-2">
            {TIPS.map((t) => (
              <li key={t} className="flex gap-2">
                <span aria-hidden="true" className="text-forest">✓</span>
                {t}
              </li>
            ))}
          </ul>
        </div>
      )}

      {step.kind === "record" && <Recorder onDone={takeClip} onCancel={() => setStep({ kind: "choose" })} />}

      {step.kind === "review" && clip && (
        <div className="flex flex-col gap-5">
          <BinBoxPicker url={clip.url} box={box} drawing={drawing} onBox={setBox} onDuration={(d) => (duration.current = d)} />
          <p className="m-0 text-center text-[15px] text-muted">
            {drawing
              ? "Drag one box around all the bins (and the floor just in front of them)."
              : box
                ? "Bins marked. We'll use your box."
                : "Optional: we find the bins automatically. If we can't, mark them yourself."}
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <button type="button" className="min-h-11 rounded-lg px-4 font-medium text-ink-2 hover:text-ink" onClick={startOver}>
              Start over
            </button>
            <button type="button" className={SECONDARY} onClick={() => setDrawing(!drawing)}>
              {drawing ? "Done marking" : box ? "Redraw bins" : "Mark the bins"}
            </button>
            {box && !drawing && (
              <button type="button" className="min-h-11 rounded-lg px-4 font-medium text-ink-2 hover:text-ink" onClick={() => setBox(null)}>
                Clear box
              </button>
            )}
            <button type="button" className={PRIMARY} onClick={upload}>
              Process video
            </button>
          </div>
        </div>
      )}

      {step.kind === "uploading" && (
        <div className="mx-auto flex w-full max-w-md flex-col gap-3 py-10 text-center">
          <span className="font-display text-2xl font-bold">Uploading…</span>
          <div className="h-2 overflow-hidden rounded-full bg-rule-soft" role="progressbar" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(step.progress * 100)}>
            <div className="h-full bg-forest transition-[width]" style={{ width: `${step.progress * 100}%` }} />
          </div>
          <span className="font-mono text-sm text-muted">{Math.round(step.progress * 100)}%</span>
        </div>
      )}

      {step.kind === "processing" && <Processing job={step.job} />}

      {step.kind === "result" && <Result id={step.id} onAgain={startOver} />}

      {step.kind === "error" && (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <span className="font-display text-2xl font-bold">{errorInfo(step.code).title}</span>
          <span className="max-w-md text-[15px] text-muted">{errorInfo(step.code).body}</span>
          <div className="mt-2 flex gap-3">
            {errorInfo(step.code).retry === "review" && clip ? (
              <button type="button" className={PRIMARY} onClick={() => {
                setDrawing(step.code === "no_bins" || step.code === "bad_area");
                setStep({ kind: "review" });
              }}>
                {step.code === "no_bins" ? "Mark the bins" : "Try again"}
              </button>
            ) : (
              <button type="button" className={PRIMARY} onClick={startOver}>
                Try another video
              </button>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-10 px-6 pt-12 pb-24 sm:px-10">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="m-0 font-display text-[clamp(28px,4vw,40px)] leading-tight font-bold">Try it on your own video</h1>
        <span className="max-w-xl text-[15px] text-muted">
          Film yourself walking up to a bin and throwing something away. You&apos;ll get your video back with our overlay
          and the voice telling you which bin it goes in.
        </span>
      </div>
      {children}
      <p className="m-0 text-center text-[13px] text-muted-2">
        Your video is processed on our cloud GPU and deleted after 24 hours. Only cropped pictures of the item, with faces
        blanked out, are sent to the AI that names it.
      </p>
    </div>
  );
}

function Processing({ job }: { job: JobStatus | null }) {
  const current = job ? stageIndex(job) : 0;
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-5 py-6">
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {STAGES.map((s, i) => (
          <li key={s.key} className={`flex items-center gap-3 text-[16px] ${i < current ? "text-muted" : i === current ? "font-bold text-ink" : "text-muted-2"}`}>
            <span aria-hidden="true" className="flex w-5 justify-center">
              {i < current ? <span className="text-forest">✓</span> : i === current ? <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-forest" /> : <span className="h-1.5 w-1.5 rounded-full bg-rule" />}
            </span>
            {s.label}
          </li>
        ))}
      </ol>
      <p className="m-0 text-[14px] text-muted">
        This takes a few minutes. You can keep this page open, or come back to this link later: results are kept for 24 hours.
      </p>
    </div>
  );
}

function Result({ id, onAgain }: { id: string; onAgain: () => void }) {
  return (
    <div className="flex flex-col gap-8">
      <video src={videoUrl(id)} controls playsInline preload="metadata" className="mx-auto max-h-[70vh] w-full rounded-[10px] bg-night object-contain" />
      <div className="flex flex-wrap justify-center gap-3">
        <a href={videoUrl(id, true)} className={PRIMARY}>
          Download video
        </a>
        <button type="button" className={SECONDARY} onClick={onAgain}>
          Try another video
        </button>
      </div>
    </div>
  );
}
