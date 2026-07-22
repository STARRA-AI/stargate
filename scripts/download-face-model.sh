#!/usr/bin/env bash
# Provision MediaPipe face-detector assets locally for offline camera gaze.
# Copies the tasks-vision WASM out of node_modules and downloads the BlazeFace
# short-range model. Skip-if-exists, same pattern as the Piper voice downloader.
# Nothing here is committed — public/vendor/mediapipe/ is gitignored.
set -euo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$PROJ/public/vendor/mediapipe"
WASM_SRC="$PROJ/node_modules/@mediapipe/tasks-vision/wasm"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
MODEL="$DEST/blaze_face_short_range.tflite"

mkdir -p "$DEST/wasm"

if [[ ! -d "$WASM_SRC" ]]; then
  echo "◆ @mediapipe/tasks-vision not installed. Run: npm install" >&2
  exit 1
fi

for f in vision_wasm_internal.js vision_wasm_internal.wasm \
         vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  if [[ -f "$DEST/wasm/$f" ]]; then
    echo "● wasm present: $f"
  else
    cp "$WASM_SRC/$f" "$DEST/wasm/$f"
    echo "→ copied: $f"
  fi
done

if [[ -f "$MODEL" ]]; then
  echo "● model present: blaze_face_short_range.tflite"
else
  echo "→ downloading BlazeFace model…"
  if ! curl -fsSL --max-time 120 -o "$MODEL" "$MODEL_URL"; then
    echo "◆ Download failed for blaze_face_short_range.tflite" >&2
    rm -f "$MODEL"
    exit 1
  fi
  echo "● model downloaded"
fi

echo "✅ MediaPipe face assets ready in $DEST"
