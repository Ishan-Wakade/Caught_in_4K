"use client";
/**
 * Voice guide on a phone: the phone is the "surveillance camera", runs the skeleton and face models itself
 * (MediaPipe, in the browser), and speaks "<Bin>. <explanation>" when a person with waste walks up to the bins.
 * Item naming runs on the server (/api/guide/identify: DeepSeek + Jev); speech via /api/guide/speak (ElevenLabs),
 * falling back to the phone's own voice. Hand crops leave the phone only with every head and face blacked out.
 */
import { FaceDetector, FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { useCallback, useEffect, useRef, useState } from "react";
import { distanceM, Tracker, type Box } from "@/lib/guide/approach";
import { spoken, type GuideMessage } from "@/lib/guide/message";
import { fromMediaPipe, GuideSession } from "@/lib/guide/session";

const WASM = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.1/wasm";
const POSE_MODEL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.task";
const SILENCE = "data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA//tQxAADB8AhSmxhIIEVCSiJrDCQBTcu3UrAIwUdkRgQbFAZC1CQEwTJ9mjRvBA4UOLD8nKVOWfh+UlK3z/177OXrfOdKl7pyn3Xf//WreyTRUoAWgBgkOAGbZHBgG1OF6zM82DWbZaUmMBptgQhGjsyYqc9ae9XFz280948NMBWInljyzsNRFLPWdnZGWrddDsjK1unuSrVN9jJsK8KuQtQCtMBjCEtImISdNKJOopIpBFpNSMbIHCSRpRR5iakjTiyzLhchUUBwCgyKiweBv/7UsQbg8isVNoMPMjAAAA0gAAABEVFGmgqK////9bP/6XCykxBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

type LogLine = { t: number; text: string; source: string; ms?: number };

function useStored(key: string, initial: string): [string, (v: string) => void] {
  const [v, setV] = useState(initial);
  useEffect(() => {
    try {
      const s = localStorage.getItem(key);
      if (s) setV(s);
    } catch {}
  }, [key]);
  return [v, (nv: string) => { setV(nv); try { localStorage.setItem(key, nv); } catch {} }];
}

export default function GuideCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [token, setToken] = useStored("guide.token", "");
  const [areaText, setAreaText] = useStored("guide.area", "");
  const [camName, setCamName] = useStored("guide.cam", "CAM 01");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Tap Start. Then draw ONE box around all the bins.");
  const [drawing, setDrawing] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const areaRef = useRef<Box | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const sessionRef = useRef<GuideSession | null>(null);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const faceRef = useRef<FaceDetector | null>(null);

  useEffect(() => {
    const k = new URLSearchParams(window.location.search).get("key");
    if (k) setToken(k);
    try { areaRef.current = areaText ? JSON.parse(areaText) : null; } catch { areaRef.current = null; }
  }, [areaText]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = useCallback((m: GuideMessage, sig: string | null, source: string) => {
    const text = spoken(m);
    const started = performance.now();
    queue.current = queue.current.then(async () => {
      try {
        const res = await fetch("/api/guide/speak", {
          method: "POST", headers: { "content-type": "application/json", "x-guide-token": token },
          body: JSON.stringify(sig ? { message: m, sig } : { kind: "default" }),
        });
        if (!res.ok) throw new Error(String(res.status));
        const audio = audioRef.current!;
        audio.src = URL.createObjectURL(await res.blob());
        await audio.play();
        await new Promise((r) => { audio.onended = r; audio.onerror = r; });
      } catch {
        await new Promise<void>((r) => {  // the phone's own voice when ElevenLabs is unavailable
          const u = new SpeechSynthesisUtterance(text);
          u.onend = () => r();
          u.onerror = () => r();
          speechSynthesis.speak(u);
        });
      }
    });
    setLog((l) => [{ t: Date.now(), text, source, ms: Math.round(performance.now() - started) }, ...l].slice(0, 6));
  }, [token]);

  const capture = useCallback((box: Box, heads: Array<{ box: Box; reliable: boolean }>): string | null => {
    const video = videoRef.current, face = faceRef.current;
    if (!video || !face) return null;  // no face detector: nothing may leave the phone (fail closed)
    const w = box.x1 - box.x0, h = box.y1 - box.y0;
    const s = Math.min(1, 320 / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.round(w * s);
    c.height = Math.round(h * s);
    const g = c.getContext("2d")!;
    g.drawImage(video, box.x0, box.y0, w, h, 0, 0, c.width, c.height);
    g.fillStyle = "#000";
    for (const hd of heads) {
      const b = hd.box;
      const touches = b.x1 > box.x0 && b.y1 > box.y0 && b.x0 < box.x1 && b.y0 < box.y1;
      if (!touches) continue;
      if (!hd.reliable) return null;  // a head we cannot size touches the crop: drop it
      g.fillRect((b.x0 - box.x0) * s, (b.y0 - box.y0) * s, (b.x1 - b.x0) * s, (b.y1 - b.y0) * s);
    }
    for (const d of face.detect(c).detections) {
      const bb = d.boundingBox;
      if (bb) g.fillRect(bb.originX - 4, bb.originY - 4, bb.width + 8, bb.height + 8);
    }
    return c.toDataURL("image/jpeg", 0.8);
  }, []);

  const start = useCallback(async () => {
    if (!token) { setStatus("Add the demo key first (…/guide?key=…)."); return; }
    const audio = audioRef.current!;
    audio.src = SILENCE;
    audio.play().catch(() => {});                        // unlock audio on iOS (needs this tap)
    speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
    setStatus("Starting the camera…");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    const video = videoRef.current!;
    video.srcObject = stream;
    await video.play();
    setStatus("Loading the models…");
    const files = await FilesetResolver.forVisionTasks(WASM);
    const pose = await PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" }, runningMode: "VIDEO", numPoses: 3,
    });
    try {
      faceRef.current = await FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: "IMAGE" });
    } catch {
      faceRef.current = null;
      setStatus("Face detector unavailable: crops will NOT be sent (no identification).");
    }
    const tracker = new Tracker();
    const canvas = canvasRef.current!;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    let fps = 0, lastT = performance.now(), lastVideoT = -1;
    const t0 = performance.now();
    setRunning(true);
    setStatus(areaRef.current ? "Running." : "Running. Tap 'Set bins' and draw one box around all the bins.");
    const loop = () => {
      const now = performance.now();
      if (video.currentTime !== lastVideoT) {
        lastVideoT = video.currentTime;
        const t = (now - t0) / 1000;
        const res = pose.detectForVideo(video, now);
        const people = tracker.update(res.landmarks.map((lm) => fromMediaPipe(lm, video.videoWidth, video.videoHeight)), t);
        if (areaRef.current) {
          if (!sessionRef.current || sessionRef.current.area !== areaRef.current) {
            sessionRef.current = new GuideSession(areaRef.current, {
              identify: async (crops) => {
                const r = await fetch("/api/guide/identify", {
                  method: "POST", headers: { "content-type": "application/json", "x-guide-token": token }, body: JSON.stringify({ crops }),
                });
                if (!r.ok) throw new Error(String(r.status));
                return r.json();
              },
              speak: (m, _t, _id, source, sig) => say(m, sig, source),
              capture,
            });
          }
          sessionRef.current.step(t, people, { w: video.videoWidth, h: video.videoHeight });
        }
        fps = 0.9 * fps + 0.1 * (1000 / Math.max(1, now - lastT));
        lastT = now;
        draw(canvas, video, people, areaRef.current, sessionRef.current, camName, fps);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }, [token, capture, say, camName]);

  const toVideo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * e.currentTarget.width, y: ((e.clientY - r.top) / r.height) * e.currentTarget.height };
  };

  return (
    <main style={{ background: "#000", color: "#fff", minHeight: "100dvh", fontFamily: "system-ui, sans-serif" }}>
      <video ref={videoRef} playsInline muted style={{ display: "none" }} />
      <audio ref={audioRef} playsInline />
      <canvas
        ref={canvasRef}
        style={{ width: "100%", maxHeight: "82dvh", objectFit: "contain", display: running ? "block" : "none", touchAction: drawing ? "none" : "auto" }}
        onPointerDown={(e) => { if (drawing) dragRef.current = toVideo(e); }}
        onPointerMove={(e) => {
          if (!drawing || !dragRef.current) return;
          const p = toVideo(e), a = dragRef.current;
          areaRef.current = { x0: Math.min(a.x, p.x), y0: Math.min(a.y, p.y), x1: Math.max(a.x, p.x), y1: Math.max(a.y, p.y) };
        }}
        onPointerUp={() => {
          if (!drawing || !areaRef.current) return;
          dragRef.current = null;
          setDrawing(false);
          setAreaText(JSON.stringify(areaRef.current));
          sessionRef.current = null;
          setStatus("Running.");
        }}
      />
      <div style={{ padding: 12, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!running && <button onClick={() => start().catch((e) => setStatus(`Could not start: ${e?.message ?? e}`))} style={btn}>Start</button>}
        {running && <button onClick={() => { setDrawing(true); setStatus("Drag one box around all the bins."); }} style={btn}>Set bins</button>}
        {!running && (
          <>
            <input placeholder="demo key" value={token} onChange={(e) => setToken(e.target.value)} style={inp} />
            <input placeholder="camera name" value={camName} onChange={(e) => setCamName(e.target.value)} style={inp} />
          </>
        )}
        <span style={{ opacity: 0.8, fontSize: 14 }}>{status}</span>
      </div>
      <ul style={{ listStyle: "none", padding: "0 12px", margin: 0, fontSize: 15 }}>
        {log.map((l) => (
          <li key={l.t}>🔊 {l.text} <span style={{ opacity: 0.6 }}>({l.source})</span></li>
        ))}
      </ul>
    </main>
  );
}

const btn: React.CSSProperties = { background: "#16a34a", color: "#fff", border: 0, borderRadius: 8, padding: "10px 18px", fontSize: 16 };
const inp: React.CSSProperties = { background: "#111", color: "#fff", border: "1px solid #444", borderRadius: 8, padding: "8px 10px", fontSize: 15 };

const BONES: Array<[string, string]> = [
  ["leftShoulder", "rightShoulder"], ["leftShoulder", "leftElbow"], ["leftElbow", "leftWrist"], ["rightShoulder", "rightElbow"],
  ["rightElbow", "rightWrist"], ["leftShoulder", "leftHip"], ["rightShoulder", "rightHip"], ["leftHip", "rightHip"],
  ["leftHip", "leftAnkle"], ["rightHip", "rightAnkle"],
];

function draw(canvas: HTMLCanvasElement, video: HTMLVideoElement, people: Array<{ id: number; pose: Record<string, { x: number; y: number; v: number } | undefined> }>,
  area: Box | null, session: GuideSession | null, cam: string, fps: number) {
  const g = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height, k = Math.max(W, H) / 1280;
  g.drawImage(video, 0, 0, W, H);
  g.lineWidth = 3 * k;
  if (area) {
    g.strokeStyle = "#22c55e";
    g.strokeRect(area.x0, area.y0, area.x1 - area.x0, area.y1 - area.y0);
    g.fillStyle = "#22c55e";
    g.font = `${22 * k}px system-ui`;
    g.fillText("bins", area.x0 + 8 * k, area.y0 + 26 * k);
  }
  for (const { id, pose } of people) {
    g.strokeStyle = "#facc15";
    for (const [a, b] of BONES) {
      const p = pose[a], q = pose[b];
      if (p && q && p.v > 0.3 && q.v > 0.3) { g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); }
    }
    const d = area ? distanceM(pose as never, area) : null;
    const n = pose.nose ?? pose.leftShoulder;
    if (n) {
      g.fillStyle = "#fb923c";
      g.font = `${20 * k}px system-ui`;
      g.fillText(`#${id}${d != null ? ` ${d.toFixed(1)} m` : ""}`, n.x, Math.max(20 * k, n.y - 30 * k));
    }
  }
  const last = session?.said.at(-1);
  if (last && session && performance.now() / 1000 - 0 < Infinity) {
    const text = spoken(last.message);
    g.font = `bold ${30 * k}px system-ui`;
    g.lineWidth = 8 * k;
    g.strokeStyle = "#000";
    g.strokeText(text, 20 * k, H - 30 * k);
    g.fillStyle = last.message.bin === "recycle" ? "#60a5fa" : last.message.bin === "compost" ? "#4ade80" : last.message.bin === "none" ? "#f87171" : "#e5e7eb";
    g.fillText(text, 20 * k, H - 30 * k);
  }
  g.font = `${22 * k}px ui-monospace, monospace`;
  g.lineWidth = 6 * k;
  const stamp = `${cam}  ${new Date().toLocaleString()}`;
  g.strokeStyle = "#000";
  g.strokeText(stamp, 20 * k, 36 * k);
  g.fillStyle = "#fff";
  g.fillText(stamp, 20 * k, 36 * k);
  g.fillStyle = "#ef4444";
  g.beginPath();
  g.arc(W - 40 * k, 30 * k, 10 * k, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#fff";
  g.fillText(`${fps.toFixed(0)} fps`, W - 160 * k, 36 * k);
}
