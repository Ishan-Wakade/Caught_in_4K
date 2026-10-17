#!/usr/bin/env bash
# Give the worker's Live stream and evidence crops a public https URL, so the
# deployed dashboard (and teammates' browsers) can load them. See docs/deploy.md.
#
#   worker/scripts/share-stream.sh        # then copy the https://….trycloudflare.com URL
#
# The stream server refuses any Host other than localhost (DNS-rebinding guard,
# stream.py), so the tunnel rewrites Host to localhost instead of loosening that check.
# The URL changes every time this starts; update NEXT_PUBLIC_WORKER_URL and redeploy.
set -euo pipefail

port="${WORKER_PORT:-8765}"
command -v cloudflared >/dev/null || { echo "install cloudflared first: brew install cloudflared" >&2; exit 1; }
exec cloudflared tunnel --no-autoupdate --url "http://localhost:${port}" --http-host-header localhost
