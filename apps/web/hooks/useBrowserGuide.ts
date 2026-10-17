"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Asked, Speak } from "@/lib/guide/assist";
import { GuideEngine, GuideSession, type AssistDeps, type Backend, type Banner, type GuideFrame, type Progress } from "@/lib/guide/engine";
import { spoken, type GuideMessage } from "@/lib/guide/message";
import { BAR_S, drawOverlay } from "@/lib/guide/overlay";
import { loadFaceFinder, readGuideKey, redactedCrop, type FaceFinder } from "@/lib/guide/redact";

export type GuideStatus = "loading" | "starting" | "live" | "paused" | "blocked" | "error";

/** True while this tab is visible. The camera is on only then. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

// Loaded once per page load and reused when the tab comes back, so the camera restarts without a reload.
let engineLoad: Promise<GuideEngine> | null = null;
let faceLoad: Promise<FaceFinder | null> | null = null;

/** The server path, with the demo key: DeepSeek + Jev identify the held item (from face-redacted crops only). */
function serverModel(token: string, face: FaceFinder): AssistDeps {
  return {
    identify: async (crops) => {
      const res = await fetch("/api/guide/identify", {
        method: "POST", headers: { "content-type": "application/json", "x-guide-token": token }, body: JSON.stringify({ crops }),
      });
      if (!res.ok) throw new Error(`identify ${res.status}`);
      return (await res.json()) as Asked;
    },
    capture: (video, box, heads) => redactedCrop(video, box, heads, face),
  };
}

/** One sentence at a time: the ElevenLabs voice from the server, else this browser's own voice. */
function speaker(token: string) {
  const audio = typeof Audio === "undefined" ? null : new Audio();
  let queue = Promise.resolve();
  return (s: Speak) => {
    queue = queue.then(async () => {
      try {
        const res = await fetch("/api/guide/speak", {
          method: "POST", headers: { "content-type": "application/json", "x-guide-token": token }, body: JSON.stringify(s.body),
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

/** Same picture as the worker's rendered videos (lib/guide/overlay.ts), on the video's own pixels. */
function draw(canvas: HTMLCanvasElement, video: HTMLVideoElement, frame: GuideFrame, caption: GuideMessage | null, fps: number) {
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  drawOverlay(canvas.getContext("2d")!, canvas.width, canvas.height, {
    people: frame.people, answer: frame.banner?.message ?? null, caption, cam: "CAM 01", now: new Date(), fps,
  });
}

/**
 * The webcam, E's voice-guide model running on it in this browser, and what to show. The camera stream is stopped
 * whenever the tab is hidden or the page is left.
 */
export function useBrowserGuide(
  active: boolean,
  videoRef: RefObject<HTMLVideoElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>,
) {
  const [status, setStatus] = useState<GuideStatus>("loading");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [people, setPeople] = useState(0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [smart, setSmart] = useState(false);
  const [sound, setSound] = useState(false);
  const soundRef = useRef(false);
  const last = useRef({ people: -1, banner: "" });

  /** Browsers only play sound after a click on the page: the "Sound on" button calls this. */
  const enableSound = useCallback(() => {
    soundRef.current = !soundRef.current;
    setSound(soundRef.current);
    if (soundRef.current) speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
  }, []);

  useEffect(() => {
    if (!active) {
      setStatus((s) => (s === "live" || s === "starting" ? "paused" : s));
      return;
    }
    let stopped = false;
    let stream: MediaStream | null = null;
    const token = readGuideKey();

    (async () => {
      try {
        engineLoad ??= GuideEngine.load(setProgress);
        const engine = await engineLoad.catch((e) => {
          engineLoad = null; // let a later visit try again
          throw e;
        });
        if (stopped) return;
        setBackend(engine.backend);
        // With the demo key, also the server model; without a face detector nothing may leave the device: CLIP only.
        const face = token ? await (faceLoad ??= loadFaceFinder()) : null;
        if (stopped) return;
        setSmart(Boolean(token && face));
        const say = token ? speaker(token) : null;
        setStatus("starting");
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        } catch {
          if (!stopped) setStatus("blocked");
          return;
        }
        const video = videoRef.current;
        if (stopped || !video) {
          stream.getTracks().forEach((t) => t.stop()); // left while the camera was starting
          return;
        }
        video.srcObject = stream;
        await video.play();
        setStatus("live");

        const session = new GuideSession(engine, token && face ? serverModel(token, face) : undefined);
        let caption: { message: GuideMessage; at: number } | null = null;
        let fps = 0, prev = 0;
        while (!stopped) {
          if (video.readyState >= 2 && video.videoWidth) {
            // Always the newest frame: while a step runs, the camera keeps going and the frames in between are skipped.
            const now = performance.now() / 1000;
            const frame = await session.step(video, now);
            if (stopped) break;
            if (prev) fps = fps ? 0.9 * fps + 0.1 / (now - prev) : 1 / (now - prev);  // frames the model processed per second
            prev = now;
            if (frame.banner) caption = { message: frame.banner.message, at: now };  // the bottom bar, like the worker's
            if (caption && now - caption.at > BAR_S) caption = null;
            if (canvasRef.current) draw(canvasRef.current, video, frame, caption?.message ?? null, fps);
            if (say && soundRef.current) frame.speak.forEach(say);
            const key = frame.banner ? JSON.stringify(frame.banner) : "";
            if (frame.people.length !== last.current.people) setPeople((last.current.people = frame.people.length));
            if (key !== last.current.banner) {
              last.current.banner = key;
              setBanner(frame.banner);
            }
          }
          await new Promise((r) => requestAnimationFrame(r));
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
      stream?.getTracks().forEach((t) => t.stop()); // turns the camera (and its light) off
      if (videoRef.current) videoRef.current.srcObject = null;
      canvasRef.current?.getContext("2d")?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
      setBanner(null);
      last.current = { people: -1, banner: "" };
    };
  }, [active, videoRef, canvasRef]);

  return { status, progress, people, banner, backend, error, smart, sound, enableSound };
}
