"""Annotated video for the dashboard's Live scene, plus evidence crops (contracts §4).

GET /stream.mjpg      multipart JPEG of the latest published frame
GET /evidence/<path>  files under evidence_dir only

Camera frames can show people, so: bound to 127.0.0.1, no CORS header (the dashboard uses
<img src>, which needs none), and requests whose Host is not localhost are refused (DNS rebinding).
"""

import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

COLORS = {"trash": (60, 60, 60), "recycling": (200, 120, 0), "compost": (40, 140, 40)}


def annotate(frame: np.ndarray, tracks, regions) -> np.ndarray:
    out = frame.copy()
    h, w = out.shape[:2]
    for r in regions:
        x, y, rw, rh = r.to_pixels(w, h)
        kind = next((k for k in COLORS if k in r.bin_id), "trash")
        cv2.rectangle(out, (x, y), (x + rw, y + rh), COLORS[kind], 2)
        cv2.putText(out, r.bin_id.split("_")[-1], (x, y - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, COLORS[kind], 2)
    for t in tracks:
        x1, y1, x2, y2 = map(int, t.box)
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 200, 255), 2)
        cv2.putText(out, f"#{t.track_id}", (x1, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 255), 1)
    return out


class StreamServer:
    def __init__(self, port: int, evidence_dir: Path, fps: float = 15.0):
        self.port, self.evidence_dir, self.interval = port, Path(evidence_dir).resolve(), 1 / fps
        self._jpeg: bytes | None = None
        self._lock = threading.Lock()
        self._httpd: ThreadingHTTPServer | None = None

    def publish(self, frame: np.ndarray) -> None:
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if ok:
            with self._lock:
                self._jpeg = buf.tobytes()

    def latest(self) -> bytes | None:
        with self._lock:
            return self._jpeg

    def start(self) -> None:
        server = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                host = (self.headers.get("Host") or "").rsplit(":", 1)[0].strip("[]")
                if host not in ("localhost", "127.0.0.1", "::1"):
                    return self.send_error(403)
                path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
                if path == "/stream.mjpg":
                    return self._stream()
                if path.startswith("/evidence/"):
                    return self._evidence(path[len("/evidence/"):])
                self.send_error(404)

            def _stream(self):
                self.send_response(200)
                self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                try:
                    while True:
                        jpeg = server.latest()
                        if jpeg:
                            self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(jpeg))
                            self.wfile.write(jpeg + b"\r\n")
                            self.wfile.flush()
                        time.sleep(server.interval)
                except (BrokenPipeError, ConnectionResetError):
                    return

            def _evidence(self, rel: str):
                target = (server.evidence_dir / rel).resolve()
                if not target.is_relative_to(server.evidence_dir) or not target.is_file():
                    return self.send_error(404)
                data = target.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self._httpd = ThreadingHTTPServer(("127.0.0.1", self.port), Handler)
        self._httpd.daemon_threads = True
        threading.Thread(target=self._httpd.serve_forever, daemon=True).start()

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()
