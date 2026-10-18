"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { GuideEngine, type Backend, type Progress } from "@/lib/guide/engine";
import { spoken } from "@/lib/guide/message";
import { loadFaceFinder, readGuideKey, type FaceFinder } from "@/lib/guide/redact";
import type { Opening } from "@/lib/live/claude";
import { drawOverlay } from "@/lib/live/overlay";
import { LiveSession, type LiveAnswer, type Say } from "@/lib/live/session";
import type { Event } from "@/lib/live/watch";

export type LiveSource = { kind: "camera"; facing: "user" | "environment" } | { kind: "file"; url: string; name: string; rate: number };
export type LiveStatus = "idle" | "loading" | "starting" | "live" | "ended" | "blocked" | "error";
export type BinsState = { state: "none" | "looking" | "found" | "failed"; ms?: number; note?: string };

let engineLoad: Promise<GuideEngine> | null = null;
let faceLoad: Promise<FaceFinder | null> | null = null;

function api(token: string) {
  const post = async (path: string, body: object) => {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-guide-token": token }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  };
  return {
    identify: (crops: string[]) => post("/api/model/identify", { crops }) as Promise<LiveAnswer>,
    bins: (frame: string, width: number, height: number) => post("/api/model/bins", { frame, width, height }) as Promise<{ openings: Opening[]; ms: number }>,
  };
}

/** One sentence at a time: the ElevenLabs voice from the server (signed messages only), else this browser's voice. */
function speaker(token: string) {
  const audio = typeof Audio === "undefined" ? null : new Audio();
  let queue = Promise.resolve();
  return (s: Say) => {
    queue = queue.then(async () => {
      try {
        const res = await fetch("/api/guide/speak", {
          method: "POST", headers: { "content-type": "application/json", "x-guide-token": token }, body: JSON.stringify({ message: s.message, sig: s.sig }),
        });
        if (!res.ok || !audio) throw new Error(`speak ${res.status}`);
        const url = URL.createObjectURL(await res.blob());
        audio.src = url;
        await audio.play();
        await new Promise((r) => { audio.onended = r; audio.onerror = r; });
        URL.revokeObjectURL(url);
      } catch {
        await new Promise<void>((r) => {
          const u = new SpeechSynthesisUtterance(spoken(s.message));
          u.onend = () => r();
          u.onerror = () => r();
          speechSynthesis.speak(u);
        });
      }
    });
  };
}

/**
 * The demo model, live in this browser: a camera or a video file, pose + CLIP here, Claude on the server. The video
 * is never uploaded; only face-redacted item crops (identification) and one face-redacted frame (bin openings) are.
 */
export function useLiveModel(source: LiveSource | null, token: string, videoRef: RefObject<HTMLVideoElement | null>, canvasRef: RefObject<HTMLCanvasElement | null>) {
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [openings, setOpenings] = useState<Opening[]>([]);
  const [bins, setBins] = useState<BinsState>({ state: "none" });
  const [fps, setFps] = useState(0);
  const [current, setCurrent] = useState<ReturnType<LiveSession["current"]>>(null);
  const currentKey = useRef("");
  const [sound, setSound] = useState(false);
  const soundRef = useRef(false);
  const sessionRef = useRef<LiveSession | null>(null);

  const toggleSound = useCallback(() => {
    soundRef.current = !soundRef.current;
    setSound(soundRef.current);
    if (soundRef.current) speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
  }, []);

  /** Ask Claude for the bin openings in the current frame (faces blacked out first). */
  const findBins = useCallback(async () => {
    const session = sessionRef.current, video = videoRef.current;
    if (!session || !video || !video.videoWidth) return;
    setBins({ state: "looking" });
    try {
      const pic = session.binsFrame(video);
      if (!pic) {
        setBins({ state: "failed", note: "not ready: the frame may not leave the device yet" });
        return;
      }
      const r = await api(token).bins(pic.frame, pic.width, pic.height);
      const found = r.openings.map((o) => ({ ...o, box: o.box.map((v) => Math.round(v / pic.scale)) as Opening["box"] }));
      session.openings = found;
      setOpenings(found);
      setBins({ state: found.length ? "found" : "failed", ms: r.ms, note: found.length ? undefined : "no bin openings seen" });
    } catch (e) {
      setBins({ state: "failed", note: e instanceof Error ? e.message : String(e) });
    }
  }, [token, videoRef]);

  useEffect(() => {
    if (!source || !token) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    setEvents([]);
    setOpenings([]);
    setBins({ state: "none" });
    setError(null);
    (async () => {
      try {
        setStatus("loading");
        engineLoad ??= GuideEngine.load(setProgress);
        const engine = await engineLoad.catch((e) => {
          engineLoad = null;
          throw e;
        });
        const face = await (faceLoad ??= loadFaceFinder());
        if (stopped) return;
        setBackend(engine.backend);
        if (!face) throw new Error("face detector unavailable: nothing may leave the device");
        setStatus("starting");
        const video = videoRef.current!;
        if (source.kind === "camera") {
          try {
            stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: source.facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
          } catch {
            if (!stopped) setStatus("blocked");
            return;
          }
          if (stopped) return;
          video.srcObject = stream;
        } else {
          video.srcObject = null;
          video.src = source.url;
          video.playbackRate = source.rate;  // slower than real time: the model sees more of each second
        }
        await video.play();
        await new Promise<void>((r) => (video.videoWidth ? r() : video.addEventListener("loadeddata", () => r(), { once: true })));
        if (stopped) return;
        const say = speaker(token);
        const server = api(token);
        const session = new LiveSession(engine, face, server.identify, () => {
          setEvents([...session.events]);
          setOpenings([...session.openings]);
        }, async (frame, w, h) => (await server.bins(frame, w, h)).openings);
        sessionRef.current = session;
        setStatus("live");

        let prev = 0, rate = 0, binsAsked = false;
        const clock = () => (source.kind === "file" ? video.currentTime : performance.now() / 1000);
        while (!stopped) {
          if (source.kind === "file" && video.ended) break;
          if (video.readyState >= 2 && video.videoWidth) {
            const now = clock();
            const frame = await session.step(video, now);
            if (stopped) break;
            if (!binsAsked) {  // after the first step: the people in view are known and blacked out of the frame
              binsAsked = true;
              void findBins();
            }
            if (prev && now > prev) rate = rate ? 0.9 * rate + 0.1 / (now - prev) : 1 / (now - prev);
            prev = now;
            const canvas = canvasRef.current;
            if (canvas) {
              if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
              }
              drawOverlay(canvas.getContext("2d")!, canvas.width, canvas.height, {
                people: frame.people, openings: session.openings, caption: frame.caption, cam: "CAM 01", now: new Date(), fps: rate,
              });
            }
            const said = session.takeSay();
            if (soundRef.current) said.forEach(say);
            setFps(Math.round(rate));
            const cur = session.current(now);
            const key = JSON.stringify([cur?.label, cur?.answer?.source, cur?.asking]);
            if (key !== currentKey.current) {
              currentKey.current = key;
              setCurrent(cur);
            }
          }
          await new Promise((r) => requestAnimationFrame(r));
        }
        if (!stopped && source.kind === "file") {
          session.flush(clock());
          setEvents([...session.events]);
          setStatus("ended");
        }
      } catch (e) {
        if (!stopped) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    })();
    return () => {
      stopped = true;
      sessionRef.current = null;
      setCurrent(null);
      currentKey.current = "";
      setStatus("idle");
      stream?.getTracks().forEach((t) => t.stop());
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.srcObject = null;
      }
    };
  }, [source, token, videoRef, canvasRef, findBins]);

  return { status, progress, backend, error, events, openings, bins, fps, current, sound, toggleSound, findBins };
}

export { readGuideKey };
