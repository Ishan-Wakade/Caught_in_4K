#!/usr/bin/env bash
# Prerecorded, store-tuned demo video: ./scripts/demo.sh <clip> [extra guide options, e.g. --item item_generic_can]
# Draw the bin box on the first frame, press Enter; the result goes to $DEMO_OUT (default ~/Downloads/recyclone-demo)
# as <clip>_demo.mp4 (voice mixed in) + <clip>_demo.json (items, announcements, sources). Keys: docs/voice-guide.md.
set -euo pipefail
clip="${1:?usage: scripts/demo.sh <clip.mov> [--item <catalog id>] [--area x0,y0,x1,y1]}"
shift
out_dir="${DEMO_OUT:-$HOME/Downloads/recyclone-demo}"
mkdir -p "$out_dir"
name="$(basename "${clip%.*}")"
area="pick"
for a in "$@"; do [[ "$a" == --area ]] && area=""; done
cd "$(dirname "$0")/.."
exec uv run recyclone-worker guide --source "$clip" ${area:+--area "$area"} --prepared --cctv --no-stream \
  --render "$out_dir/${name}_demo.mp4" "$@"
