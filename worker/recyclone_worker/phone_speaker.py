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
<title>Bin speaker</title>
<style>
  :root { --bg:#0b0d10; --fg:#f2f4f7; --dim:#8a93a0; --recycle:#2f7de1; --compost:#2e9e4f; --trash:#6b7280; --none:#d9480f; }
  html,body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:17px/1.4 -apple-system,system-ui,sans-serif; }
  main { min-height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:20px;
         padding:24px 16px; box-sizing:border-box; text-align:center; transition:background .2s; }
  button { font:inherit; font-size:22px; font-weight:600; padding:22px 30px; border-radius:16px; border:0;
           background:var(--fg); color:var(--bg); }
  #bin { font-size:min(22vw,120px); font-weight:800; letter-spacing:-.02em; line-height:1; }
  #why { font-size:22px; max-width:30ch; }
  #state { color:var(--dim); font-size:14px; position:fixed; bottom:max(12px,env(safe-area-inset-bottom)); left:0; right:0; }
</style></head>
<body><main id="m">
  <button id="go">Tap to turn on the speaker</button>
  <div id="bin" hidden></div><div id="why" hidden></div>
  <div id="state">Keep this page open and the screen on.</div>
</main>
<script>
const STALE_S = 3;  // same rule as the Mac: a sentence that could not start within 3 s is skipped
const $ = (id) => document.getElementById(id);
let ctx = null, lock = null, queue = Promise.resolve();

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
  const kind = bin.toLowerCase().replace(/[^a-z]/g, "");
  $("bin").textContent = kind === "none" ? "No bin" : bin.replace(/\\.$/, ""); $("why").textContent = why.join(". ");
  $("bin").hidden = $("why").hidden = false;
  $("m").style.background = `color-mix(in srgb, var(--${kind in {recycle:1,compost:1,trash:1,none:1} ? kind : "trash"}) 35%, var(--bg))`;
}
function speakText(text) {
  return new Promise((done) => {
    const u = new SpeechSynthesisUtterance(text);
    u.onend = u.onerror = done; speechSynthesis.speak(u);
  });
}
async function play(m) {
  show(m.text);
  if (m.audio) {
    try {
      const buf = await (await fetch(`a/${m.audio}.m4a`)).arrayBuffer();
      const audio = await ctx.decodeAudioData(buf);
      const src = ctx.createBufferSource(); src.buffer = audio; src.connect(ctx.destination);
      await new Promise((done) => { src.onended = done; src.start(); });
      return;
    } catch (e) { /* fall back to the phone's own voice */ }
  }
  await speakText(m.text);
}
function listen() {
  const es = new EventSource("events");
  es.onopen = () => { $("state").textContent = "Connected. Waiting for the guide…"; };
  es.onerror = () => { $("state").textContent = "Reconnecting to the Mac…"; };
  es.onmessage = (ev) => {
    const m = JSON.parse(ev.data), got = performance.now() / 1000 - m.age_s;
    queue = queue.then(() => (performance.now() / 1000 - got > STALE_S ? null : play(m)));
  };
}
$("go").onclick = async () => {
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume(); beep();                     // the tap is what lets iOS play sound later
  speechSynthesis.speak(new SpeechSynthesisUtterance(" "));
  $("go").hidden = true; keepAwake(); listen();
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { keepAwake(); if (ctx) ctx.resume(); }
});
</script></body></html>
"""
