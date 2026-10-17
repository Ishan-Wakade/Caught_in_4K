"""The bin's speaker on a second phone: the guide runs on this Mac and every sentence it says also plays on a phone
that opened the speaker page over the same Wi-Fi.

GET /s/<token>/              the page: tap once to allow sound, then it plays each sentence as it is said
GET /s/<token>/events        server-sent events, one per sentence: {"id", "text", "audio"}
GET /s/<token>/a/<key>.m4a   that sentence's audio (the `say` render converted to AAC, which iOS decodes)

Bound to every interface so a phone can reach it; every path carries a random token printed at start, and only
sentences already said can be fetched. Only text and synthetic speech leave the Mac: no camera frames, no crops.
"""

import hmac
import json
import re
import secrets
import socket
import subprocess
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

KEEP = 50  # sentences kept for reconnecting phones
PING_S = 15.0  # keeps idle connections (and Wi-Fi power saving) from closing the stream
KEY = re.compile(r"[0-9a-f]{16}")


def _afconvert(src: Path, dst: Path) -> bool:
    r = subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", str(src), str(dst)], capture_output=True, timeout=30)
    return r.returncode == 0 and dst.exists()


def lan_urls(port: int, token: str) -> list[str]:
    """Addresses a phone on the same network can open: the Wi-Fi IP, then the Bonjour name."""
    urls = []
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("10.255.255.255", 1))  # UDP connect sends nothing; it only picks the outgoing interface
            urls.append(f"http://{s.getsockname()[0]}:{port}/s/{token}/")
        except OSError:
            pass
    host = socket.gethostname()
    urls.append(f"http://{host if host.endswith('.local') else host + '.local'}:{port}/s/{token}/")
    return urls


class PhoneSpeaker:
    def __init__(self, port: int, token: str | None = None, convert=_afconvert, host: str = "0.0.0.0"):
        self.port, self.host, self.convert = port, host, convert
        self.token = token or secrets.token_urlsafe(9)
        self.messages: list[dict] = []
        self.audio: dict[str, Path] = {}  # key -> .m4a, only for sentences already said
        self._next = 1
        self._cond = threading.Condition()
        self._httpd: ThreadingHTTPServer | None = None

    def announce(self, text: str, file: Path | None) -> None:
        """SayVoice's on_say: called on the voice thread as the sentence starts, after it was rendered."""
        audio = m4a = None
        if file is not None and KEY.fullmatch(Path(file).stem) and Path(file).exists():
            m4a = Path(file).with_suffix(".m4a")
            try:
                if m4a.exists() or self.convert(Path(file), m4a):
                    audio = Path(file).stem
            except Exception:  # noqa: BLE001 - without audio the phone reads the text with its own voice
                audio = None
        with self._cond:
            if audio and m4a:
                self.audio[audio] = m4a
            self.messages.append({"id": self._next, "text": text, "audio": audio, "at": time.monotonic()})
            self._next += 1
            del self.messages[:-KEEP]
            self._cond.notify_all()

    def after(self, last_id: int, timeout: float) -> list[dict]:
        with self._cond:
            if not any(m["id"] > last_id for m in self.messages):
                self._cond.wait(timeout)
            return [m for m in self.messages if m["id"] > last_id]

    def last_id(self) -> int:
        with self._cond:
            return self._next - 1

    def start(self) -> None:
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                path = urllib.parse.urlparse(self.path).path
                parts = path.split("/")  # "", "s", token, rest...
                if len(parts) < 4 or parts[1] != "s" or not hmac.compare_digest(parts[2], server.token):
                    return self.send_error(404)
                rest = "/".join(parts[3:])
                if rest == "":
                    return self._send(200, "text/html; charset=utf-8", PAGE.encode())
                if rest == "events":
                    return self._events()
                if rest.startswith("a/") and rest.endswith(".m4a"):
                    f = server.audio.get(rest[2:-4])
                    if f is not None and f.is_file():
                        return self._send(200, "audio/mp4", f.read_bytes())
                self.send_error(404)

            def _send(self, code: int, kind: str, body: bytes):
                self.send_response(code)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)

            def _events(self):
                # a reconnect resumes after the last sentence it got; a new phone hears only what is said from now on
                header = self.headers.get("Last-Event-ID", "")
                last = int(header) if header.isdigit() else server.last_id()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    self.wfile.write(b"retry: 1000\n\n")
                    while True:
                        new = server.after(last, PING_S)
                        for m in new:
                            data = {"id": m["id"], "text": m["text"], "audio": m["audio"],
                                    "age_s": round(time.monotonic() - m["at"], 2)}
                            self.wfile.write(f"id: {m['id']}\ndata: {json.dumps(data)}\n\n".encode())
                            last = m["id"]
                        if not new:
                            self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return

            def log_message(self, *args):
                pass

        self._httpd = ThreadingHTTPServer((self.host, self.port), Handler)
        self._httpd.daemon_threads = True
        threading.Thread(target=self._httpd.serve_forever, daemon=True).start()

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0b0d10">
<title>Bin speaker</title>
<style>
  :root { --bg:#0b0d10; --fg:#f2f4f7; --dim:#8a93a0; --recycle:#2f7de1; --compost:#2e9e4f; --trash:#8b939e; --none:#e8590c;
          --accent:var(--dim); }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:17px/1.4 -apple-system,system-ui,sans-serif;
              -webkit-user-select:none; user-select:none; overflow:hidden; }
  main { height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:18px;
         padding:max(20px,env(safe-area-inset-top)) 16px max(20px,env(safe-area-inset-bottom)); box-sizing:border-box;
         text-align:center; background:radial-gradient(120% 70% at 50% 50%, color-mix(in srgb, var(--accent) 22%, var(--bg)), var(--bg));
         transition:background .4s; }
  header { position:fixed; top:max(14px,env(safe-area-inset-top)); left:0; right:0; display:flex; justify-content:center;
           align-items:center; gap:10px; font:600 15px/1 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dim); }
  #dot { width:10px; height:10px; border-radius:50%; background:#ff3b30; opacity:.35; }
  body.on #dot { animation:pulse 1.6s ease-in-out infinite; }
  body.talking #dot { opacity:1; animation:none; }
  @keyframes pulse { 50% { opacity:1; } }
  button { font:inherit; font-size:22px; font-weight:600; padding:22px 30px; border-radius:999px; border:0;
           background:var(--fg); color:var(--bg); }
  #bin { font-size:min(20vw,112px); font-weight:800; letter-spacing:-.02em; line-height:1; color:var(--accent);
         transition:color .3s; min-height:1em; }
  #wave { width:100%; height:min(34vh,260px); display:block; }
  #why { font-size:22px; max-width:30ch; min-height:2.8em; }
  #state { color:var(--dim); font-size:14px; position:fixed; bottom:max(12px,env(safe-area-inset-bottom)); left:0; right:0; }
</style></head>
<body><main id="m">
  <header><span id="dot"></span><span id="clock">00:00</span></header>
  <button id="go">Tap to turn on the speaker</button>
  <div id="bin"></div>
  <canvas id="wave" aria-hidden="true"></canvas>
  <div id="why"></div>
  <div id="state">Keep this page open and the screen on.</div>
</main>
<script>
const STALE_S = 3;  // same rule as the Mac: a sentence that could not start within 3 s is skipped
const BAR_EVERY_MS = 45;  // one waveform bar per 45 ms, scrolling left like a voice memo
const $ = (id) => document.getElementById(id);
let ctx = null, analyser = null, samples = null, lock = null, queue = Promise.resolve();
let talking = false, synthetic = false, startedAt = 0;
const bars = [];

async function keepAwake() {
  try { if ("wakeLock" in navigator) lock = await navigator.wakeLock.request("screen"); } catch (e) {}
}
function beep() {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(ctx.destination);
  o.start(); o.stop(ctx.currentTime + 0.15);
}
function show(text) {
  const [bin, ...why] = text.split(". ");
  const raw = bin.toLowerCase().replace(/[^a-z]/g, "");
  const kind = raw in {recycle:1, compost:1, trash:1, none:1} ? raw : "trash";
  $("bin").textContent = raw === "none" ? "No bin" : bin.replace(/[.]$/, "");
  $("why").textContent = why.join(". ");
  document.documentElement.style.setProperty("--accent", `var(--${kind})`);
}
function setTalking(on, fake) {
  talking = on; synthetic = on && fake;
  document.body.classList.toggle("talking", on);
}
function speakText(text) {
  return new Promise((done) => {
    const u = new SpeechSynthesisUtterance(text);
    setTalking(true, true);  // the phone's own voice cannot be measured: draw a speech-like waveform instead
    u.onend = u.onerror = () => { setTalking(false); done(); };
    speechSynthesis.speak(u);
  });
}
async function play(m) {
  show(m.text);
  if (m.audio) {
    try {
      const buf = await (await fetch(`a/${m.audio}.m4a`)).arrayBuffer();
      const audio = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource(); src.buffer = audio;
      src.connect(analyser);  // analyser -> speaker; the waveform is the sentence's real loudness
      setTalking(true, false);
      await new Promise((done) => { src.onended = done; src.start(); });
      setTalking(false);
      return;
    } catch (e) { setTalking(false); /* fall back to the phone's own voice */ }
  }
  await speakText(m.text);
}

// Loudness right now, 0..1.
function level(t) {
  if (!talking) return 0;
  if (synthetic) {  // syllable-like bursts
    const s = Math.abs(Math.sin(t * 11)) * (0.55 + 0.45 * Math.sin(t * 2.7)) * (0.6 + 0.4 * Math.random());
    return Math.min(1, 0.15 + s);
  }
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(sum / samples.length) * 4.5);
}
let lastBar = 0;
function frame(now) {
  const c = $("wave"), dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  if (now - lastBar >= BAR_EVERY_MS) { bars.push(level(now / 1000)); lastBar = now; if (bars.length > 400) bars.shift(); }

  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const color = getComputedStyle($("bin")).color || accent;
  const step = 7, bw = 4, mid = h / 2, head = w * 0.62;  // newest bar at the playhead, older ones scroll left
  const breathe = 1.5 + 1.2 * (0.5 + 0.5 * Math.sin(now / 600));
  for (let i = bars.length - 1, x = head; i >= 0 && x > -step; i--, x -= step) {
    const a = bars[i], bh = Math.max(breathe, a * (h * 0.92));
    g.globalAlpha = a > 0 ? 0.35 + 0.65 * Math.min(1, a * 1.6) * (0.4 + 0.6 * x / head) : 0.35;
    g.fillStyle = color;
    g.beginPath(); g.roundRect(x - bw / 2, mid - bh / 2, bw, bh, bw / 2); g.fill();
  }
  g.globalAlpha = 0.25; g.fillStyle = color;  // the empty track ahead of the playhead
  for (let x = head + step; x < w; x += step) { g.beginPath(); g.arc(x, mid, 1.2, 0, 7); g.fill(); }
  g.globalAlpha = 1; g.fillStyle = "#ff3b30";  // the playhead
  g.fillRect(head + 4, mid - h * 0.48, 2, h * 0.96);
  g.beginPath(); g.arc(head + 5, mid - h * 0.48, 4.5, 0, 7); g.fill(); g.beginPath(); g.arc(head + 5, mid + h * 0.48, 4.5, 0, 7); g.fill();

  if (startedAt) {
    const s = Math.floor((now - startedAt) / 1000);
    $("clock").textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

function listen() {
  const es = new EventSource("events");
  es.onopen = () => { $("state").textContent = "Connected. Listening for the guide…"; };
  es.onerror = () => { $("state").textContent = "Reconnecting to the Mac…"; };
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data), got = performance.now() / 1000 - m.age_s;
    queue = queue.then(() => (performance.now() / 1000 - got > STALE_S ? null : play(m)));
  };
}
$("go").onclick = async () => {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume(); beep();                     // the tap is what lets iOS play sound later
  analyser = ctx.createAnalyser(); analyser.fftSize = 1024; analyser.connect(ctx.destination);
  samples = new Float32Array(analyser.fftSize);
  speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
  $("go").hidden = true; document.body.classList.add("on"); startedAt = performance.now();
  keepAwake(); listen();
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { keepAwake(); if (ctx) ctx.resume(); }
});
</script></body></html>
"""
