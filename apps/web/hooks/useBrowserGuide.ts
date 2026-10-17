"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { GuideEngine, GuideSession, type Backend, type Banner, type GuideFrame, type Progress } from "@/lib/guide/engine";

export type GuideStatus = "loading" | "starting" | "live" | "paused" | "blocked" | "error";

const SKELETON = [[5, 7], [7, 9], [6, 8], [8, 10], [5, 6], [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [0, 5], [0, 6]];
// Bin colours from lib/format.ts BIN_HEX (fill); clay for "not sure" and for dangerous items.
const BOX_COLOR = { recycle: "#4A77A3", compost: "#4A8539", trash: "#5A5C58", none: "#A4502F", fallback: "#A4502F" };

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

function draw(canvas: HTMLCanvasElement, video: HTMLVideoElement, frame: GuideFrame) {
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const line = Math.max(2, canvas.width / 400);
  for (const p of frame.people) {
    ctx.strokeStyle = "rgba(230,240,225,0.9)";
    ctx.lineWidth = line;
    for (const [a, b] of SKELETON) {
      if (p.kp[a][2] > 0.3 && p.kp[b][2] > 0.3) {
        ctx.beginPath();
        ctx.moveTo(p.kp[a][0], p.kp[a][1]);
        ctx.lineTo(p.kp[b][0], p.kp[b][1]);
        ctx.stroke();
      }
    }
    const color = p.holding && frame.banner ? BOX_COLOR[frame.banner.fallback ? "fallback" : frame.banner.message.bin] : "rgba(200,200,200,0.8)";
    ctx.strokeStyle = color;
    ctx.lineWidth = p.holding ? line * 2 : line / 2;
    for (const [x0, y0, x1, y1] of p.hands) ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }
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
  const last = useRef({ people: -1, banner: "" });

  useEffect(() => {
    if (!active) {
      setStatus((s) => (s === "live" || s === "starting" ? "paused" : s));
      return;
    }
    let stopped = false;
    let stream: MediaStream | null = null;

    (async () => {
      try {
        engineLoad ??= GuideEngine.load(setProgress);
        const engine = await engineLoad.catch((e) => {
          engineLoad = null; // let a later visit try again
          throw e;
        });
        if (stopped) return;
        setBackend(engine.backend);
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

        const session = new GuideSession(engine);
        while (!stopped) {
          if (video.readyState >= 2 && video.videoWidth) {
            // Always the newest frame: while a step runs, the camera keeps going and the frames in between are skipped.
            const frame = await session.step(video, performance.now() / 1000);
            if (stopped) break;
            if (canvasRef.current) draw(canvasRef.current, video, frame);
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

  return { status, progress, people, banner, backend, error };
}
