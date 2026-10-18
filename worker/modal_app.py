"""The website's "Try your video" backend on Modal: a visitor's upload -> the annotated video with the voice.

    POST /jobs?area=x0,y0,x1,y1   body = the video file (raw bytes, Content-Type video/*); area optional, fractions
                                  of the frame -> {"id"}       (413 too big, 415 not a video, 429 rate limited)
    GET  /jobs/{id}               {"status": queued|running|done|error, "stage"?, "report"?, "code"?}
    GET  /jobs/{id}/video         the result mp4 (seekable); ?download=1 saves it as a file

`process` runs recyclone_worker/job.py on a GPU, one container per job, at most MAX_CONTAINERS at once (the rest
queue). Uploads and results are deleted after RETENTION_H. Provider keys come from the Modal secret "caught-in-4k"
(ANTHROPIC_API_KEY, TYPESAFE_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID); none reach the browser.
Weights come from the team's Hugging Face repo, pinned and checked against its SHA256SUMS, baked into the image.

    modal serve worker/modal_app.py     # development URL, reloads on save
    modal deploy worker/modal_app.py    # the URL the website's NEXT_PUBLIC_UPLOAD_API_URL points at
"""

import os
import time
import uuid
from pathlib import Path

import modal

HERE = Path(__file__).resolve().parent
APP_DIR = "/app/worker"  # same layout as the repo: weights/, rules/ next to the package, contracts/ one level up
JOBS = Path("/jobs")
HF_REPO, HF_REVISION = "eymen160/caught-in-4k", "2d883c54445c8ab3c9aad267800929c6b49ef9b5"
WEIGHTS = ["weights/yolo11n-pose.pt", "weights/clip/ViT-B-32.pt", "weights/face_detection_yunet_2023mar.onnx"]

# all of these are provisional, set at deploy time: UPLOAD_GPU=L4 modal deploy worker/modal_app.py (they are baked
# into the image's environment below, so the containers read the same values)
SETTINGS = {k: v for k, v in os.environ.items() if k.startswith("UPLOAD_")}
GPU = os.environ.get("UPLOAD_GPU", "T4")  # "cpu": no GPU (Modal needs a payment method on file for GPU functions)
COMPUTE = {"cpu": 8.0, "memory": 8192} if GPU.lower() in ("cpu", "none", "") else {"gpu": GPU}
MAX_CONTAINERS = int(os.environ.get("UPLOAD_MAX_CONTAINERS", "3"))
MAX_BYTES = int(os.environ.get("UPLOAD_MAX_MB", "150")) * 1024 * 1024
PER_IP_PER_HOUR = int(os.environ.get("UPLOAD_PER_IP_PER_HOUR", "20"))  # one venue Wi-Fi = one address
PER_DAY = int(os.environ.get("UPLOAD_PER_DAY", "200"))  # all visitors together: bounds the GPU and API spend
RETENTION_H = 24
ORIGINS = os.environ.get("UPLOAD_ALLOWED_ORIGINS", "https://caught-in-4k-app.vercel.app,http://localhost:3000").split(",")


def download_weights():
    import hashlib

    from huggingface_hub import hf_hub_download

    sums = {}
    for line in Path(hf_hub_download(HF_REPO, "SHA256SUMS", revision=HF_REVISION)).read_text().splitlines():
        digest, _, name = line.partition("  ")
        sums[name.removeprefix("./")] = digest
    for rel in WEIGHTS:
        path = Path(hf_hub_download(HF_REPO, rel, revision=HF_REVISION, local_dir=APP_DIR))
        if hashlib.sha256(path.read_bytes()).hexdigest() != sums.get(rel):
            raise RuntimeError(f"{rel}: checksum does not match {HF_REPO}@{HF_REVISION[:7]} SHA256SUMS")


image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg", "git", "libgl1", "libglib2.0-0")
    .pip_install(  # the versions in worker/uv.lock
        "torch==2.14.1", "ultralytics==8.4.181", "opencv-python==5.0.0.93", "numpy==2.5.4", "jsonschema==4.26.0",
        "lap==0.5.13", "setuptools==84.0.0", "git+https://github.com/openai/CLIP@d05afc436d78f1c48dc0dbf8e5980a9d471f35f6",
        "huggingface_hub", "fastapi[standard]",
    )
    .env({"PYTHONPATH": APP_DIR, "PYTHONUNBUFFERED": "1", **SETTINGS})
    .run_function(download_weights)
    .add_local_dir(HERE / "recyclone_worker", f"{APP_DIR}/recyclone_worker", ignore=["**/__pycache__"])
    .add_local_dir(HERE / "rules", f"{APP_DIR}/rules")
    .add_local_dir(HERE.parent / "contracts", "/app/contracts", ignore=["node_modules", "**/*.ts", "test", "scripts"])
)

app = modal.App("caught-in-4k", image=image)
volume = modal.Volume.from_name("caught-in-4k-jobs", create_if_missing=True)
state = modal.Dict.from_name("caught-in-4k-state", create_if_missing=True)  # "job:<id>" -> status, "ip:<addr>" -> times
secrets = [modal.Secret.from_name("caught-in-4k")]


def _set(job_id: str, **fields) -> None:
    state[f"job:{job_id}"] = {**state.get(f"job:{job_id}", {}), **fields}


@app.function(**COMPUTE, timeout=1800, max_containers=MAX_CONTAINERS, volumes={JOBS: volume}, secrets=secrets)
def process(job_id: str, area: list[float] | None) -> None:
    os.chdir(APP_DIR)
    from recyclone_worker.job import run_job

    volume.reload()  # the upload was committed by the api container
    folder = JOBS / job_id
    _set(job_id, status="running", stage="starting")
    try:
        result = run_job(folder / "input", folder, tuple(area) if area else None,
                         on_stage=lambda s: _set(job_id, stage=s))
    except Exception as e:  # noqa: BLE001 - the page gets "failed"; the trace stays in Modal's log
        print(f"job {job_id} crashed: {type(e).__name__}: {e}")
        result = {"status": "error", "code": "failed"}
    finally:
        (folder / "input").unlink(missing_ok=True)  # only the result is kept, and only for RETENTION_H
        volume.commit()
    if result["status"] == "done":
        _set(job_id, status="done", stage=None, report=result["report"])
    else:
        _set(job_id, status="error", stage=None, code=result["code"])


@app.function(volumes={JOBS: volume}, schedule=modal.Period(hours=6))
def cleanup() -> None:
    import shutil

    cutoff = time.time() - RETENTION_H * 3600
    for key, value in list(state.items()):
        if key.startswith("job:") and value.get("created", 0) < cutoff:
            shutil.rmtree(JOBS / key[4:], ignore_errors=True)
            state.pop(key)
        elif key.startswith("ip:") and all(t < time.time() - 3600 for t in value):
            state.pop(key)
    volume.commit()


@app.function(volumes={JOBS: volume}, secrets=secrets)
@modal.concurrent(max_inputs=50)
@modal.asgi_app()
def api():
    from fastapi import FastAPI, HTTPException, Request
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse

    web = FastAPI(title="Caught in 4K uploads", docs_url=None, redoc_url=None)
    web.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"], allow_headers=["Content-Type"])

    def client_ip(request: Request) -> str:
        # Modal's proxy puts the visitor first in X-Forwarded-For (TODO: confirm on the deployed URL)
        forwarded = request.headers.get("x-forwarded-for", "")
        return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")

    async def rate_limit(ip: str) -> None:
        now = time.time()
        recent = [t for t in await state.get.aio(f"ip:{ip}", []) if now - t < 3600]
        day = [t for t in await state.get.aio("all", []) if now - t < 86400]
        if len(recent) >= PER_IP_PER_HOUR or len(day) >= PER_DAY:
            raise HTTPException(429, "rate_limited")
        await state.put.aio(f"ip:{ip}", recent + [now])
        await state.put.aio("all", day + [now])

    def parse_area(area: str | None) -> list[float] | None:
        if not area:
            return None
        try:
            vals = [float(v) for v in area.split(",")]
        except ValueError:
            vals = []
        if len(vals) != 4 or not all(0 <= v <= 1 for v in vals) or vals[2] <= vals[0] or vals[3] <= vals[1]:
            raise HTTPException(400, "bad_area")
        return vals

    def job_or_404(job_id: str) -> dict:
        try:
            uuid.UUID(job_id)
        except ValueError:
            raise HTTPException(404, "expired") from None
        job = state.get(f"job:{job_id}")
        if job is None:
            raise HTTPException(404, "expired")
        return job

    @web.post("/jobs")
    async def create(request: Request, area: str | None = None):
        if not request.headers.get("content-type", "").startswith("video/"):
            raise HTTPException(415, "not_video")
        if int(request.headers.get("content-length") or 0) > MAX_BYTES:
            raise HTTPException(413, "too_large")
        box = parse_area(area)
        await rate_limit(client_ip(request))
        job_id = str(uuid.uuid4())
        folder = JOBS / job_id
        folder.mkdir(parents=True)
        size = 0
        with open(folder / "input", "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > MAX_BYTES:
                    f.close()
                    (folder / "input").unlink()
                    folder.rmdir()
                    raise HTTPException(413, "too_large")
                f.write(chunk)
        if size == 0:
            (folder / "input").unlink()
            folder.rmdir()
            raise HTTPException(400, "empty")
        await volume.commit.aio()
        await state.put.aio(f"job:{job_id}", {"status": "queued", "stage": None, "created": time.time()})
        await process.spawn.aio(job_id, box)
        return {"id": job_id}

    # plain functions: FastAPI runs them on a thread, so Modal's blocking calls never hold up the uploads
    @web.get("/jobs/{job_id}")
    def status(job_id: str):
        job = job_or_404(job_id)
        return {k: job.get(k) for k in ("status", "stage", "report", "code") if job.get(k) is not None}

    @web.get("/jobs/{job_id}/video")
    def video(job_id: str, download: int = 0):
        if job_or_404(job_id).get("status") != "done":
            raise HTTPException(404, "not_ready")
        path = JOBS / job_id / "result.mp4"
        if not path.exists():
            try:
                volume.reload()  # written by the GPU container after this one started
            except Exception:  # noqa: BLE001 - a reload refused while another response streams a file: try again later
                pass
        if not path.exists():
            raise HTTPException(404, "not_ready")
        name = f"caught-in-4k-{time.strftime('%Y-%m-%d')}.mp4"
        return FileResponse(path, media_type="video/mp4", filename=name if download else None,
                            content_disposition_type="attachment" if download else "inline",
                            headers={"Cache-Control": "private, max-age=3600"})

    return web
