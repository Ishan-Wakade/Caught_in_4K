/**
 * Client for the "Try your video" backend (worker/modal_app.py on Modal). The browser sends the video straight there:
 * an upload never passes through this app's own server, whose requests are capped at a few MB.
 */
import { UPLOAD_API_URL } from "./config";

export const MAX_SECONDS = 60;
export const MAX_BYTES = 150 * 1024 * 1024;
export const POLL_MS = 3000;

export type JobStatus = {
  status: "queued" | "running" | "done" | "error";
  stage?: string;
  report?: unknown; // the guide's <render>.json; the page only shows the video
  code?: string;
};

/** A box around the bins, as fractions of the frame (0..1), x0 < x1 and y0 < y1. */
export type Box = { x0: number; y0: number; x1: number; y1: number };

export class UploadError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export function areaParam(box: Box | null): string {
  if (!box) return "";
  return [box.x0, box.y0, box.x1, box.y1].map((v) => Math.min(Math.max(v, 0), 1).toFixed(4)).join(",");
}

export function videoUrl(id: string, download = false, base = UPLOAD_API_URL): string {
  return `${base}/jobs/${encodeURIComponent(id)}/video${download ? "?download=1" : ""}`;
}

/** The server's error code ({"detail": "rate_limited"}) or one for the HTTP status. */
async function errorCode(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string") return body.detail;
  } catch {
    // not JSON (a proxy's error page)
  }
  return res.status === 429 ? "rate_limited" : res.status === 413 ? "too_large" : res.status === 404 ? "expired" : "failed";
}

export async function getJob(id: string, fetchFn: typeof fetch = fetch, base = UPLOAD_API_URL): Promise<JobStatus> {
  let res: Response;
  try {
    res = await fetchFn(`${base}/jobs/${encodeURIComponent(id)}`, { cache: "no-store" });
  } catch {
    throw new UploadError("network");
  }
  if (!res.ok) throw new UploadError(await errorCode(res));
  return res.json();
}

/** Upload with progress (fetch has none for request bodies). Resolves to the job id. */
export function createJob(
  file: Blob,
  box: Box | null,
  onProgress: (fraction: number) => void,
  base = UPLOAD_API_URL,
): { done: Promise<string>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<string>((resolve, reject) => {
    const area = areaParam(box);
    xhr.open("POST", `${base}/jobs${area ? `?area=${area}` : ""}`);
    xhr.setRequestHeader("Content-Type", file.type.startsWith("video/") ? file.type : "video/mp4");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onerror = () => reject(new UploadError("network"));
    xhr.onabort = () => reject(new UploadError("aborted"));
    xhr.onload = async () => {
      const res = new Response(xhr.responseText, { status: xhr.status });
      if (xhr.status >= 200 && xhr.status < 300) resolve((await res.json()).id);
      else reject(new UploadError(await errorCode(res)));
    };
    xhr.send(file);
  });
  return { done, abort: () => xhr.abort() };
}

/** Progress text for the backend's stages (job.py's on_stage, plus the queue). */
export const STAGES: Array<{ key: string; label: string }> = [
  { key: "queued", label: "Waiting for a free GPU" },
  { key: "starting", label: "Starting the GPU" },
  { key: "preparing video", label: "Preparing your video" },
  { key: "finding bins", label: "Finding the bins" },
  { key: "identifying", label: "Identifying what you're carrying" },
  { key: "rendering", label: "Making your video, with the voice" },
];

export function stageIndex(job: Pick<JobStatus, "status" | "stage">): number {
  if (job.status === "queued") return 0;
  const i = STAGES.findIndex((s) => s.key === job.stage);
  return i < 0 ? 1 : i;
}

/** What the page says for each error code, and where "Try again" goes. */
export const ERRORS: Record<string, { title: string; body: string; retry: "review" | "choose" }> = {
  no_bins: { title: "We couldn't find the bins", body: "Drag a box around the bins on the first frame, then process it again.", retry: "review" },
  too_long: { title: "That video is too long", body: `Keep it under ${MAX_SECONDS} seconds: walk up, throw the item away, done.`, retry: "choose" },
  too_large: { title: "That file is too big", body: "Try a shorter clip, or record at 1080p instead of 4K.", retry: "choose" },
  not_video: { title: "That isn't a video", body: "Choose a video file (MP4, MOV or WebM).", retry: "choose" },
  unreadable: { title: "We couldn't read that video", body: "Try recording it again, or choose a different file.", retry: "choose" },
  empty: { title: "That file is empty", body: "Try recording it again.", retry: "choose" },
  bad_area: { title: "That box didn't work", body: "Drag a larger box around the bins, or leave it out.", retry: "review" },
  rate_limited: { title: "That's a lot of videos", body: "You've hit the limit for now. Try again in an hour.", retry: "review" },
  expired: { title: "This result has expired", body: "Results are deleted after 24 hours. Upload your video again.", retry: "choose" },
  network: { title: "Connection lost", body: "Check your internet connection and try again.", retry: "review" },
  failed: { title: "Something went wrong", body: "We couldn't process this video. Try again, or try a different clip.", retry: "review" },
};

export function errorInfo(code: string) {
  return ERRORS[code] ?? ERRORS.failed;
}
