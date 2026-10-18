"use client";

import { useEffect, useRef, useState } from "react";
import { MAX_SECONDS } from "@/lib/upload";

/** The first recording format this browser supports: Safari records MP4, Chrome and Firefox WebM. */
function pickMime(): string | undefined {
  const types = ["video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return types.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

/** Record a clip with the device's camera (back camera on a phone), stopping by itself at MAX_SECONDS. */
export function Recorder({ onDone, onCancel }: { onDone: (clip: Blob) => void; onCancel: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const [state, setState] = useState<"starting" | "ready" | "recording" | "denied">("starting");
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        if (video.current) video.current.srcObject = s;
        setState("ready");
      })
      .catch(() => !cancelled && setState("denied"));
    return () => {
      cancelled = true;
      recorder.current?.state === "recording" && recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    if (state !== "recording") return;
    const started = Date.now();
    const timer = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setSeconds(s);
      if (s >= MAX_SECONDS) recorder.current?.stop();
    }, 250);
    return () => clearInterval(timer);
  }, [state]);

  function start() {
    if (!stream.current) return;
    const mime = pickMime();
    const rec = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    rec.onstop = () => {
      stream.current?.getTracks().forEach((t) => t.stop());
      onDone(new Blob(chunks, { type: rec.mimeType || mime || "video/webm" }));
    };
    recorder.current = rec;
    rec.start(1000);
    setSeconds(0);
    setState("recording");
  }

  if (state === "denied") {
    return (
      <div className="flex flex-col items-center gap-4 py-16 text-center">
        <span className="font-display text-2xl font-bold">We can&apos;t use your camera</span>
        <span className="max-w-md text-[15px] text-muted">Allow camera access in your browser settings, or record with your camera app and choose the video instead.</span>
        <button type="button" onClick={onCancel} className="min-h-11 rounded-lg border border-forest px-4 font-bold text-forest hover:bg-forest hover:text-card">
          Back
        </button>
      </div>
    );
  }

  const left = Math.max(0, Math.ceil(MAX_SECONDS - seconds));
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative w-full overflow-hidden rounded-[10px] bg-night">
        <video ref={video} autoPlay muted playsInline className="block max-h-[65vh] w-full object-contain" />
        {state === "recording" && (
          <span className="absolute top-3 left-3 flex items-center gap-2 rounded-md bg-night/80 px-2.5 py-1 font-mono text-sm text-card">
            <span aria-hidden="true" className="h-2.5 w-2.5 animate-pulse rounded-full bg-clay" />
            REC {Math.floor(seconds)}s · {left}s left
          </span>
        )}
      </div>
      <div className="flex gap-3">
        {state === "recording" ? (
          <button type="button" onClick={() => recorder.current?.stop()} className="min-h-11 rounded-lg bg-clay-deep px-5 font-bold text-card hover:bg-clay">
            Stop recording
          </button>
        ) : (
          <>
            <button type="button" onClick={onCancel} className="min-h-11 rounded-lg px-4 font-medium text-ink-2 hover:text-ink">
              Cancel
            </button>
            <button type="button" disabled={state !== "ready"} onClick={start}
              className="min-h-11 rounded-lg bg-forest px-5 font-bold text-card hover:bg-forest-deep disabled:opacity-50">
              {state === "starting" ? "Starting camera…" : "Start recording"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
