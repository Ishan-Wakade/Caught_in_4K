#!/usr/bin/env bash
# Prerecorded, store-tuned demo video: ./scripts/demo.sh <clip> [extra guide options, e.g. --item item_generic_can]
# Draw the bin box on the first frame, press Enter; the result goes to ~/Downloads/recyclone-demo/<clip>_demo.mp4 (+ .json).
set -euo pipefail
clip="${1:?usage: scripts/demo.sh <clip.mov> [--item <catalog id>] [--area x0,y0,x1,y1]}"
shift
out_dir="$HOME/Downloads/recyclone-demo"
mkdir -p "$out_dir"
name="$(basename "${clip%.*}")"
area="pick"
for a in "$@"; do [[ "$a" == --area ]] && area=""; done
cd "$(dirname "$0")/.."
exec uv run recyclone-worker guide --source "$clip" ${area:+--area "$area"} --prepared --cctv --no-stream \
  --render "$out_dir/${name}_demo.mp4" "$@"
