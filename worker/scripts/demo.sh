#!/usr/bin/env bash
# Prerecorded demo through Claude Sonnet + Jev on Chalk: ./scripts/demo.sh <clip> [extra guide options]
# Draw the bin box on the first frame, press Enter; the result goes to $DEMO_OUT (default ~/Downloads/recyclone-demo)
# as <clip>_demo.mp4 (voice mixed in) + <clip>_demo.json (items, announcements, sources). Setup: docs/chalk.md.
set -euo pipefail
clip="${1:?usage: scripts/demo.sh <clip.mov> [--area x0,y0,x1,y1]}"
shift
out_dir="${DEMO_OUT:-$HOME/Downloads/recyclone-demo}"
mkdir -p "$out_dir"
name="$(basename "${clip%.*}")"
area="pick"  # mark the bins locally; Chalk receives item crops, never whole frames
for a in "$@"; do [[ "$a" == --area ]] && area=""; done
cd "$(dirname "$0")/.."
exec uv run recyclone-worker guide --source "$clip" ${area:+--area "$area"} --prepared --chalk --namer claude --claude-model claude-sonnet-5-5 --cctv --no-stream \
  --render "$out_dir/${name}_demo.mp4" "$@"
