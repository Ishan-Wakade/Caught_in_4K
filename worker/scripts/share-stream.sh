#!/usr/bin/env bash
# Give the worker's Live stream and evidence crops a public https URL, so the
# deployed dashboard (and teammates' browsers) can load them. See docs/deploy.md.
#
#   export WORKER_STREAM_TOKEN=$(openssl rand -hex 24)   # same value in the worker's shell
#   worker/scripts/share-stream.sh
#   NEXT_PUBLIC_WORKER_URL=https://<printed>.trycloudflare.com/s/$WORKER_STREAM_TOKEN
#
# The camera can show people, so the tunnel refuses to start without a token: the worker
# then serves only /s/<token>/... and 404s everything else, so knowing the hostname is not
# enough. The token still reaches every dashboard visitor's browser, so keep the dashboard
# itself private (Vercel Deployment Protection) and stop this when you are not demoing.
#
# The stream server refuses any Host other than localhost (DNS-rebinding guard for your
# own browser, stream.py), so cloudflared rewrites Host to localhost for tunnel traffic.
# The URL changes every time this starts; update NEXT_PUBLIC_WORKER_URL and redeploy.
set -euo pipefail

port="${WORKER_PORT:-8765}"
WORKER_STREAM_TOKEN_VALUE="${WORKER_STREAM_TOKEN:-}"
command -v cloudflared >/dev/null || { echo "install cloudflared first: brew install cloudflared" >&2; exit 1; }
if [ "${#WORKER_STREAM_TOKEN_VALUE}" -lt 24 ]; then
  echo 'set WORKER_STREAM_TOKEN (24+ chars, e.g. export WORKER_STREAM_TOKEN=$(openssl rand -hex 24))' >&2
  echo 'and start the worker with the same value, or the stream is public to anyone with the URL' >&2
  exit 1
fi
echo "NEXT_PUBLIC_WORKER_URL = <https URL printed below>/s/\$WORKER_STREAM_TOKEN" >&2
exec cloudflared tunnel --no-autoupdate --url "http://localhost:${port}" --http-host-header localhost
