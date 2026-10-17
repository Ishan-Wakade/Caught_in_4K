"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Asked, Speak } from "@/lib/guide/assist";
import { GuideEngine, GuideSession, type AssistDeps, type Backend, type Banner, type GuideFrame, type Progress } from "@/lib/guide/engine";
import { spoken } from "@/lib/guide/message";
import { loadFaceFinder, readGuideKey, redactCrop, type FaceFinder } from "@/lib/guide/redact";

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

/** The debug view is on with `?debug=1` (kept in the address bar) or `#debug` / `#key=…&debug=1`. */
export function isDebugView(): boolean {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(window.location.search).get("debug");
  const h = new URLSearchParams(window.location.hash.slice(1));
  return (q !== null && q !== "0") || h.has("debug");
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
    capture: (video, box, heads) => redactCrop(video, box, heads, face),
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

/** Debug view (/camera?debug=1): what gets blacked out, and each hand's CLIP verdict and crop fate, on the video. */
function drawDebug(canvas: HTMLCanvasElement, frame: GuideFrame, itemP: number) {
  const ctx = canvas.getContext("2d")!;
  const line = Math.max(2, canvas.width / 400);
  const font = Math.max(14, Math.round(canvas.width / 70));
  ctx.font = `${font}px ui-monospace, monospace`;
  ctx.lineWidth = line;
  for (const h of frame.heads) {
    ctx.setLineDash([line * 3, line * 2]);
    ctx.strokeStyle = h.reliable ? "rgba(255,255,255,0.7)" : "rgba(255,80,80,0.9)";
    ctx.strokeRect(h.box.x0, h.box.y0, h.box.x1 - h.box.x0, h.box.y1 - h.box.y0);
    ctx.setLineDash([]);
  }
  for (const p of frame.debug) {
    for (const h of p.hands) {
      const [x0, y0] = h.box;
      const parts = [h.pItem == null ? "p=…" : `p=${h.pItem.toFixed(2)}`, (h.top ?? "").replace(/^item_(generic_)?/, "")];
      if (h.crop) parts.push(h.crop.sent ? `sent${h.crop.black > 0.01 ? ` blk ${Math.round(100 * h.crop.black)}%` : ""}` : `DROP ${h.crop.reason}`);
      const text = parts.join(" ");
      const w = ctx.measureText(text).width + 8;
      const y = Math.max(font + 4, y0 - 4);
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(x0, y - font - 2, w, font + 6);
      ctx.fillStyle = h.pItem != null && h.pItem >= itemP ? "#9BE58A" : "#F2F2F2";
      ctx.fillText(text, x0 + 4, y);
    }
  }
}

/** One line per person for the debug panel. */
export function debugLines(frame: GuideFrame): string[] {
  return frame.debug.map((p) => {
    const a = p.assist;
    const server = !a ? "" : a.result
      ? ` · server ${a.result.source}${a.result.message ? `: ${a.result.message.bin} (${a.result.message.explanation})` : ""}${a.latencyMs != null ? ` ${Math.round(a.latencyMs)}ms` : ""}${a.gaveUp ? " (gave up)" : ""}`
      : ` · ${a.state} crops=${a.crops}${a.asked ? " asked" : ""}`;
    return `#${p.id} ${p.holding ? `HOLDING ${p.heldFor.toFixed(1)}s` : "empty hands"}${p.clip ? ` · clip ${p.clip}` : ""}${server}`;
  });
}

declare global {
  interface Window {
    /** Debug mode only: every processed frame's debug record (for tuning and automated measurement). */
    __guideDebug?: Array<{ t: number; poseMs: number; clipMs: number; banner: Banner | null; people: GuideFrame["debug"] }>;
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
  debug = false,
) {
  const [status, setStatus] = useState<GuideStatus>("loading");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [people, setPeople] = useState(0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [smart, setSmart] = useState(false);
  const [sound, setSound] = useState(false);
  const [debugInfo, setDebugInfo] = useState<{ lines: string[]; ms: string } | null>(null);
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
        if (debug) window.__guideDebug = [];
        let lastPanel = 0;
        while (!stopped) {
          if (video.readyState >= 2 && video.videoWidth) {
            // Always the newest frame: while a step runs, the camera keeps going and the frames in between are skipped.
            const now = performance.now() / 1000;
            const frame = await session.step(video, now);
            if (stopped) break;
            if (canvasRef.current) draw(canvasRef.current, video, frame);
            if (debug) {
              if (canvasRef.current) drawDebug(canvasRef.current, frame, engine.data.constants.item_p);
              const log = (window.__guideDebug ??= []);
              log.push({ t: now, poseMs: frame.poseMs, clipMs: frame.clipMs, banner: frame.banner, people: frame.debug });
              if (log.length > 20000) log.splice(0, log.length - 20000);
              if (now - lastPanel > 0.2) {
                lastPanel = now;
                setDebugInfo({ lines: debugLines(frame), ms: `pose ${Math.round(frame.poseMs)} ms · clip ${Math.round(frame.clipMs)} ms` });
              }
            }
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
      setDebugInfo(null);
      last.current = { people: -1, banner: "" };
    };
  }, [active, videoRef, canvasRef, debug]);

  return { status, progress, people, banner, backend, error, smart, sound, enableSound, debugInfo };
}
