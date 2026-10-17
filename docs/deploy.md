# Deploying Recyclone so the whole team can use it

Code is shared through GitHub already. This page is about the **running system**:
one shared dashboard + API, one shared database, and the CV worker's Live stream.

```
[laptop: CV worker + camera] --POST /api/events--> [Vercel: apps/web (UI + API)] <--> [Neon Postgres]
            |                                                  ^
            +-- /stream.mjpg, /evidence/* via Cloudflare Tunnel (https) --+-- every teammate's browser
```

Why the split:

- **Web + API on Vercel.** Stateless Next.js, cheap, preview URL per PR.
- **Worker stays on a laptop, not in Docker.** On macOS, Docker runs Linux in a VM with
  no access to the Apple GPU (MPS), so the worker would drop to CPU. It already runs at
  only ~2–3 fps *with* MPS for `--tracker items`. Docker only makes sense on a Linux box
  with an NVIDIA GPU.
- **Postgres, not `CORE_STORAGE=memory`.** Every Vercel function instance has its own
  memory, so in-memory events would vanish or split between instances.

## 1. Vercel project (Ishan, project `iw9/caught-in-4k-app`)

**Deploys are currently blocked** ("Deployment was blocked", even on `main`). On the
Hobby plan Vercel only builds commits whose author is a team member, and most merge
commits are authored by other teammates. Pick one:

- Start the Pro trial and add teammates to the team (simplest for a hackathon), or
- create a **Deploy Hook** for `main` (Project → Settings → Git) and share its URL so
  anyone can trigger a build with `curl -X POST <hook>`, or
- Ishan deploys from his machine with `vercel --prod`.

Project settings to check:

| Setting | Value |
|---|---|
| Root Directory | `apps/web` (include files outside it: on) |
| Framework | Next.js |
| Install command | default (pnpm is detected from the lockfile) |
| Build command | default (`pnpm build`, which runs `next build --webpack`) |

`apps/web/next.config.ts` bundles `contracts/fixtures/demo-site.json` into every API
function (`outputFileTracingIncludes`). The API reads that file at runtime and Vercel's
file tracing cannot see it otherwise.

## 2. Database (Ishan)

Vercel → Storage → **Neon** (Marketplace, free). Connecting it to the project sets
`DATABASE_URL`. Use the **pooled** connection string (`-pooler` host): each function
instance opens up to 3 connections. Tables are created automatically on the first API
request (`connectPostgres` → `migrate()`); there is no manual migration step.

One database (or Neon branch) per `CONFIG_PROFILE`: core refuses to start if the stored
configuration differs from the runtime one.

## 3. Environment variables (Vercel → Settings → Environment Variables)

| Variable | Value |
|---|---|
| `DATABASE_URL` | set by the Neon integration |
| `CORE_STORAGE` | `postgres` |
| `CONFIG_PROFILE` | `demo` |
| `WORKER_INGEST_TOKEN` | random, e.g. `openssl rand -hex 24`; share privately with E |
| `MANAGER_API_TOKEN` | random; protects manager writes and mock replies |
| `MESSENGER_MODE` | `mock` (until S's live Photon setup is ready) |
| `ILLUSTRATOR_MODE` | `mock` |
| `ENABLE_MOCK_REPLY` | `true` for the demo |
| `NEXT_PUBLIC_WORKER_URL` | the tunnel URL from step 4 (no trailing slash) |

`NEXT_PUBLIC_*` values are baked in at build time, so **redeploy after changing
`NEXT_PUBLIC_WORKER_URL`**. Tokens and phone numbers go only in Vercel, never in git.

## 4. Live stream from the worker laptop (E)

The dashboard is served over https and loads `NEXT_PUBLIC_WORKER_URL/stream.mjpg`
directly in the browser. A browser will not load `http://localhost` from an https page,
and teammates cannot reach your laptop at all, so the stream needs a public https URL:

```sh
worker/scripts/share-stream.sh     # prints https://<random>.trycloudflare.com
```

The worker's stream server rejects requests whose `Host` is not localhost (DNS-rebinding
guard in `worker/recyclone_worker/stream.py`). The script makes cloudflared rewrite
`Host` to localhost instead of loosening that check. A quick-tunnel URL changes on
every start; a named Cloudflare tunnel gives a fixed one if this gets annoying.

Then run the worker against the deployed API:

```sh
export API_BASE_URL=https://<vercel-url> WORKER_INGEST_TOKEN=<from Vercel>
recyclone-worker run --tracker items --realtime --clip <clip> --clip-id <id>
```

The Live page only shows video while this laptop is running the worker.

## 5. Seed data so teammates can work any time

Without the worker running, the shared dashboard can still have realistic data.
Post the 11 synthetic events (alerts, messages, a review item) once:

```sh
cd worker
API_BASE_URL=https://<vercel-url> WORKER_INGEST_TOKEN=<token> \
  .venv/bin/recyclone-worker replay-labeled --file ../contracts/fixtures/synthetic-events.jsonl --no-wait
```

Replays are deduplicated by `event_id`, so running it twice adds nothing. Verified
locally against the production build (`pnpm build && pnpm start`): 11 created,
22 feed entries, wrong token → 401.

## Day-to-day development

Everyone keeps developing locally on their own branch; the deployment is the shared
demo, not a dev box.

```sh
pnpm install --frozen-lockfile
CORE_STORAGE=memory CONFIG_PROFILE=demo WORKER_INGEST_TOKEN=dev MANAGER_API_TOKEN=dev \
  pnpm --filter @recyclone/web dev
```

If someone needs Postgres behavior, give them their own Neon branch instead of the
shared database.
