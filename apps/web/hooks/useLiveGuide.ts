"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Asked, Speak } from "@/lib/guide/assist";
import { GuideEngine, GuideSession, type Backend, type Banner, type GuideFrame, type Progress } from "@/lib/guide/engine";
import { spoken, type GuideMessage } from "@/lib/guide/message";
import { loadFaceFinder, readGuideKey, type FaceFinder } from "@/lib/guide/redact";
import type { ItemAnswer } from "@/lib/live/claude";
import { drawOverlay, itemAndBin } from "@/lib/live/overlay";
import { itemCrop } from "@/lib/live/session";

/**
 * Jolie's live camera model (lib/guide/engine.ts: YOLO11n-pose, her close-up hand scan, CLIP holding check, one steady
 * answer per item, her Assist timing) with three changes for the dashboard's Live camera tab:
 *  - the server answer is ONE Claude Haiku 5.5 call (/api/model/identify: ~1 s, the ~110 product types with
 *    rule-based bins, Jev only for the rest) instead of DeepSeek x2 + Jev;
 *  - CLIP counts an item as possibly held from P(item) >= HOLD_P (0.35, her 0.5): small items and tissues rarely reach
 *    0.5; Claude decides, and an empty hand comes back "nothing held" (no bin shown);
 *  - crops are 224-512 px (small items stay visible) and a mostly blacked-out crop is never sent.
 * Drawn in the worker's look (green skeleton, black box on the item, "identifying…" until answered).
 */
export type LiveStatus = "idle" | "loading" | "starting" | "live" | "ended" | "blocked" | "error";
export type LiveSource = { kind: "camera"; facing: "user" | "environment" } | { kind: "file"; url: string; name: string; rate: number };
/** One answered item, for the session list (what Claude saw, when, how long the answer took). */
export type SeenItem = { at: number; message: GuideMessage; source: string; item?: ItemAnswer["item"]; ms?: number };

const HOLD_P = 0.35;

let engineLoad: Promise<GuideEngine> | null = null;
let faceLoad: Promise<FaceFinder | null> | null = null;

type Answer = Asked & { item?: ItemAnswer["item"]; ms?: number };

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

/** The engine with a lower "possibly held" bar for its CLIP watcher (her files unchanged: a view over the engine). */
function withHoldBar(engine: GuideEngine): GuideEngine {
  const data = { ...engine.data, constants: { ...engine.data.constants, item_p: HOLD_P } };
  return Object.create(engine, { data: { value: data } }) as GuideEngine;
}

export function useLiveGuide(source: LiveSource | null, token: string, videoRef: RefObject<HTMLVideoElement | null>, canvasRef: RefObject<HTMLCanvasElement | null>) {
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [inView, setInView] = useState(false);
  const [checking, setChecking] = useState(false); // true only while Claude is engaged on an item in view
  const [items, setItems] = useState<SeenItem[]>([]);
  const [sound, setSound] = useState(false);
  const soundRef = useRef(false);
  const details = useRef(new Map<string, Answer>()); // explanation -> the server's full answer (material, form, ms)

  const toggleSound = useCallback(() => {
    soundRef.current = !soundRef.current;
    setSound(soundRef.current);
    if (soundRef.current) speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
  }, []);

  useEffect(() => {
    if (!source || !token) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    setItems([]);
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
          video.playbackRate = source.rate;
        }
        await video.play();
        await new Promise<void>((r) => (video.videoWidth ? r() : video.addEventListener("loadeddata", () => r(), { once: true })));
        if (stopped) return;
        setStatus("live");

        // The item box is drawn only while Claude is being asked or has answered: a hand at the face (its crop never
        // leaves the device) or a brief CLIP blip draws nothing (17-18 Oct, holdup2/3: "identifying…" on a hand at the chin).
        let asking = 0, askedAt = -1e9;
        const identify = async (crops: string[]): Promise<Asked> => {
          asking += 1;
          askedAt = performance.now();
          try {
            return await identifyOnce(crops);
          } finally {
            asking -= 1;
          }
        };
        const identifyOnce = async (crops: string[]): Promise<Asked> => {
          const res = await fetch("/api/model/identify", {
            method: "POST", headers: { "content-type": "application/json", "x-guide-token": token }, body: JSON.stringify({ crops }),
          });
          if (!res.ok) throw new Error(`identify ${res.status}`);
          const r = (await res.json()) as ItemAnswer & { sig: string | null; ms?: number };
          const a: Answer = { message: r.message, source: r.source === "error" ? "default" : r.source, sig: r.sig, item: r.item, ms: r.ms };
          if (r.message) details.current.set(r.message.explanation, a);
          return a;
        };
        const session = new GuideSession(withHoldBar(engine), {
          identify,
          capture: (v, box, heads) => itemCrop(v, box, heads, face),
        });
        const say = speaker(token);
        const clock = () => (source.kind === "file" ? video.currentTime : performance.now() / 1000);
        let prev = 0, rate = 0, lastKey = "", lastView = false, lastCheck = false;
        while (!stopped) {
          if (source.kind === "file" && video.ended) break;
          if (video.readyState >= 2 && video.videoWidth) {
            const now = clock();
            const frame: GuideFrame = await session.step(video, now);
            if (stopped) break;
            if (prev && now > prev) rate = rate ? 0.9 * rate + 0.1 / (now - prev) : 1 / (now - prev);
            prev = now;
            const canvas = canvasRef.current;
            if (canvas) {
              if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
              }
              const engaged = asking > 0 || performance.now() - askedAt < 2500 || frame.banner !== null;
              const name = frame.banner ? (details.current.get(frame.banner.message.explanation)?.item?.name ?? itemAndBin(frame.banner.message)[0]) : null;
              drawOverlay(canvas.getContext("2d")!, canvas.width, canvas.height, {
                people: frame.people.map((p) => ({
                  kp: p.kp,
                  item: engaged && p.holding && p.best >= 0 ? (p.hands[p.best] as [number, number, number, number]) : null,
                  label: engaged && p.holding && p.best >= 0 ? (frame.banner && !frame.banner.fallback ? name : frame.unsure ? "not sure" : "identifying…") : null,
                })),
                openings: [], caption: null, cam: "CAM 01", now: new Date(), fps: rate,
              });
            }
            if (soundRef.current) frame.speak.forEach(say);
            const key = frame.banner ? JSON.stringify(frame.banner) : "";
            if (key !== lastKey) {
              lastKey = key;
              setBanner(frame.banner);
              if (frame.banner && !frame.banner.fallback) {
                const d = details.current.get(frame.banner.message.explanation);
                setItems((xs) => [...xs, { at: now, message: frame.banner!.message, source: frame.banner!.source ?? "", item: d?.item, ms: d?.ms }]);
              }
            }
            if (frame.inView !== lastView) setInView((lastView = frame.inView));
            const isChecking = frame.checking && (asking > 0 || performance.now() - askedAt < 2500);
            if (isChecking !== lastCheck) setChecking((lastCheck = isChecking));
            setFps(Math.round(rate));
          }
          await new Promise((r) => requestAnimationFrame(r));
        }
        if (!stopped && source.kind === "file") setStatus("ended");
      } catch (e) {
        if (!stopped) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    })();
    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.srcObject = null;
      }
      setBanner(null);
      setInView(false);
      setChecking(false);
      setStatus("idle");
    };
  }, [source, token, videoRef, canvasRef]);

  return { status, progress, backend, error, fps, banner, inView, checking, items, details: details.current, sound, toggleSound };
}

export { readGuideKey };
