#!/bin/bash
# Render seeds in chunks of 10, pack each clip, then delete its raw PNG frames (disk is tight).
#   sim/unity-mac/run_batch.sh <split> <seed_start> <seed_end>
set -euo pipefail
cd "$(dirname "$0")"
U=/Applications/Unity/Hub/Editor/6000.6.6f1/Unity.app/Contents/MacOS/Unity
PY=../../worker/.venv/bin/python
split=$1; s=$2; e=$3
while [ "$s" -le "$e" ]; do
  t=$(( s + 9 < e ? s + 9 : e ))
  "$U" -batchmode -quit -projectPath "$PWD" -executeMethod Recyclone.SimRunner.Render \
       -seedStart "$s" -seedEnd "$t" -split "$split" -out Output -logFile "Output/render_${split}_${s}.log" > /dev/null 2>&1
  for seed in $(seq "$s" "$t"); do
    c=$(printf "Output/%s/sim_%s_%04d" "$split" "$split" "$seed")
    [ -f "$c/unity.json" ] || { echo "MISSING $c"; continue; }
    $PY pack.py "$c" 2>&1 | grep -v -i warn
    rm -rf "$c/frames"
  done
  s=$(( t + 1 ))
done
echo "BATCH_DONE $split"
