"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { Asked, Speak } from "@/lib/guide/assist";
import { GuideEngine, GuideSession, type Backend, type Banner, type GuideFrame, type Progress } from "@/lib/guide/engine";
import { spoken, type GuideMessage } from "@/lib/guide/message";
import { loadFaceFinder, readGuideKey, type FaceFinder } from "@/lib/guide/redact";
import type { ItemAnswer } from "@/lib/live/claude";
import { drawOverlay, itemAndBin } from "@/lib/live/overlay";
import { itemCrop } from "@/lib/live/session";
import { pickPrimary, raisedHands, upperBody, type Found } from "@/lib/live/focus";
import { ZoneSession, loadFarFaceFinder } from "@/lib/live/zone";

/** The "hold it here" zone: a thin rounded frame, so people know where to show the item. */
function drawZone(ctx: CanvasRenderingContext2D, z: number[], w: number) {
  const lw = Math.max(2, Math.round(w / 640));
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.55)";
  ctx.lineWidth = lw;
  ctx.setLineDash([lw * 6, lw * 5]);
  ctx.beginPath();
  ctx.roundRect(z[0], z[1], z[2] - z[0], z[3] - z[1], lw * 10);
  ctx.stroke();
  ctx.restore();
}

/**
 * Jolie's live camera model (lib/guide/engine.ts: YOLO11n-pose, her close-up hand scan, CLIP holding check, one steady
 * answer per item, her Assist timing) with three changes for the public site's Live camera page:
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
export type SeenItem = { at: number; message: GuideMessage; source: string; item?: ItemAnswer["item"]; ms?: number;
  /** Seconds from the item first being seen in the hand to its answer on screen. */
  tookS?: number };

const HOLD_P = 0.35;

let engineLoad: Promise<GuideEngine> | null = null;
let faceLoad: Promise<FaceFinder | null> | null = null;
let farFaceLoad: Promise<FaceFinder | null> | null = null;

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

type Scene = { all: Found[]; primary: number };
/**
 * The engine as the live camera sees a crowded room (focus.ts): people() returns only the person at the camera, with
 * lowered hands removed; `scene` keeps everyone found (for redacting the crop). Plus the lower holding bar below.
 */
function focused(engine: GuideEngine): GuideEngine & { scene: Scene } {
  const view = withHoldBar(engine) as GuideEngine & { scene: Scene };
  view.scene = { all: [], primary: -1 };
  view.people = async (video: HTMLVideoElement) => {
    const all = await engine.people(video);
    const primary = pickPrimary(all, video.videoWidth, video.videoHeight);
    view.scene = { all, primary };
    return primary < 0 ? [] : [{ ...all[primary], kp: raisedHands(all[primary].kp) }];
  };
  return view;
}

/**
 * The engine with a lower "possibly held" bar for its CLIP watcher. Her on-device catalog answer stays on (as in her
 * design): it answers when Claude is unsure (18 Oct: sauce cup and paper coffee cup came back "not sure" from Claude
 * on small webcam crops, and with it off nothing was shown). Her files are unchanged: this is a view over the engine.
 */
function withHoldBar(engine: GuideEngine): GuideEngine {
  const data = { ...engine.data, constants: { ...engine.data.constants, item_p: HOLD_P } };
  return Object.create(engine, { data: { value: data } }) as GuideEngine;
}

export function useLiveGuide(source: LiveSource | null, token: string, videoRef: RefObject<HTMLVideoElement | null>,
  canvasRef: RefObject<HTMLCanvasElement | null>, opts: { stamp?: boolean; zone?: boolean } = {}) {
  const stamp = opts.stamp ?? true;
  const zoneMode = opts.zone ?? false;
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [backend, setBackend] = useState<Backend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [inView, setInView] = useState(false);
  const [checking, setChecking] = useState(false); // true only while Claude is engaged on an item in view
  const [unsure, setUnsure] = useState(false);
  const [people, setPeople] = useState(0);
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
        const identify = async (crops: string[], mode?: "holdup"): Promise<Asked> => {
          asking += 1;
          askedAt = performance.now();
          try {
            return await identifyOnce(crops, mode);
          } finally {
            asking -= 1;
          }
        };
        const identifyOnce = async (crops: string[], mode?: "holdup"): Promise<Asked> => {
          const res = await fetch("/api/model/identify", {
            method: "POST", headers: { "content-type": "application/json", "x-guide-token": token }, body: JSON.stringify({ crops, mode }),
          });
          if (!res.ok) throw new Error(`identify ${res.status}`);
          const r = (await res.json()) as ItemAnswer & { sig: string | null; ms?: number };
          const a: Answer = { message: r.message, source: r.source === "error" ? "default" : r.source, sig: r.sig, item: r.item, ms: r.ms };
          if (r.message) details.current.set(r.message.explanation, a);
          return a;
        };
        if (zoneMode) {
          // "Hold it up to the camera" (zone.ts): the item in the middle of the picture, whoever holds it.
          const far = await (farFaceLoad ??= loadFarFaceFinder());
          const zs = new ZoneSession(engine, [face, ...(far ? [far] : [])], (crops) => identify(crops, "holdup"));
          const say = speaker(token);
          let prev = 0, rate = 0, lastKey = "", lastView = false, lastCheck = false, lastUnsure = false, since = 0;
          while (!stopped) {
            if (video.readyState >= 2 && video.videoWidth) {
              const now = performance.now() / 1000;
              const f = await zs.step(video, now);
              if (stopped) break;
              if (prev && now > prev) rate = rate ? 0.9 * rate + 0.1 / (now - prev) : 1 / (now - prev);
              prev = now;
              const canvas = canvasRef.current;
              if (canvas) {
                if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                  canvas.width = video.videoWidth;
                  canvas.height = video.videoHeight;
                }
                // the skeleton of the nearest person only (a room full of skeletons hides the item)
                const near = f.people.reduce<(typeof f.people)[number] | null>((a, p) => (!a || (p.box[3] - p.box[1]) > (a.box[3] - a.box[1]) ? p : a), null);
                const name = f.banner ? (f.label ?? itemAndBin(f.banner.message)[0]) : f.label;
                const ctx = canvas.getContext("2d")!;
                drawOverlay(ctx, canvas.width, canvas.height, {
                  people: [...(near ? [{ kp: near.kp, item: null, label: null }] : []), ...(f.item ? [{ kp: [], item: f.item as [number, number, number, number], label: name }] : [])],
                  openings: [], caption: null, cam: "CAM 01", now: new Date(), fps: rate, stamp,
                });
                drawZone(ctx, f.zone, canvas.width);
              }
              if (soundRef.current) f.speak.forEach(say);
              if (f.item && !since) since = now;
              if (!f.item && !f.banner) since = 0;
              const key = f.banner ? JSON.stringify(f.banner) : "";
              if (key !== lastKey) {
                lastKey = key;
                setBanner(f.banner);
                if (f.banner) {
                  const d = details.current.get(f.banner.message.explanation);
                  setItems((xs) => [...xs, { at: now, message: f.banner!.message, source: f.banner!.source, item: d?.item, ms: d?.ms, tookS: since ? now - since : undefined }]);
                }
              }
              if (f.inView !== lastView) setInView((lastView = f.inView));
              if (f.checking !== lastCheck) setChecking((lastCheck = f.checking));
              if (f.unsure !== lastUnsure) setUnsure((lastUnsure = f.unsure));
              setFps(Math.round(rate));
              setPeople(f.people.length);
            }
            await new Promise((r) => requestAnimationFrame(r));
          }
          return;
        }
        const view = focused(engine);
        const session = new GuideSession(view, {
          identify,
          capture: (v, box, heads) => {
            const { all, primary } = view.scene;
            if (primary < 0) return null;
            const [x0, y0, x1, y1] = upperBody(all[primary], [box.x0, box.y0, box.x1, box.y1], v.videoWidth, v.videoHeight);
            return itemCrop(v, { x0, y0, x1, y1 }, heads, face, view.scene, true);
          },
        });
        const say = speaker(token);
        const clock = () => (source.kind === "file" ? video.currentTime : performance.now() / 1000);
        let prev = 0, rate = 0, lastKey = "", lastView = false, lastCheck = false;
        const seenSince = new Map<number, number>(); // person id -> when their current item was first seen held
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
                openings: [], caption: null, cam: "CAM 01", now: new Date(), fps: rate, stamp,
              });
            }
            if (soundRef.current) frame.speak.forEach(say);
            for (const p of frame.people) {
              if (p.holding && !seenSince.has(p.id)) seenSince.set(p.id, now);
              if (!p.holding && !frame.banner) seenSince.delete(p.id);
            }
            const key = frame.banner ? JSON.stringify(frame.banner) : "";
            if (key !== lastKey) {
              lastKey = key;
              setBanner(frame.banner);
              if (frame.banner && !frame.banner.fallback) {
                const d = details.current.get(frame.banner.message.explanation);
                const firstSeen = Math.min(...frame.people.filter((p) => p.holding).map((p) => seenSince.get(p.id) ?? now), now);
                setItems((xs) => [...xs, { at: now, message: frame.banner!.message, source: frame.banner!.source ?? "", item: d?.item, ms: d?.ms, tookS: now - firstSeen }]);
              }
            }
            if (frame.inView !== lastView) setInView((lastView = frame.inView));
            const isChecking = frame.checking && (asking > 0 || performance.now() - askedAt < 2500);
            if (isChecking !== lastCheck) setChecking((lastCheck = isChecking));
            setFps(Math.round(rate));
            setUnsure(frame.unsure);
            setPeople(frame.people.length);
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
  }, [source, token, videoRef, canvasRef, stamp]);

  return { status, progress, backend, error, fps, banner, inView, checking, unsure, people, items, details: details.current, sound, toggleSound };
}

export { readGuideKey };
