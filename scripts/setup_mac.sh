#!/usr/bin/env bash
# STARGATE Mac setup — voice models, deps, sanity checks.
set -euo pipefail

PROJ="$(cd "$(dirname "$0")/.." && pwd)"
VOICE_DIR="$PROJ/public/brand/voice"
# = PIPER_VOICE_ID (src/lib/voice/piper-speak.ts) — the tier the code picks.
CORI="$VOICE_DIR/en_GB-cori-medium.onnx"
JENNY="$VOICE_DIR/en_GB-jenny_dioco-medium.onnx"

echo "STARGATE setup (Mac)"
echo "Project: $PROJ"

cd "$PROJ"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 required for voice download."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm required."
  exit 1
fi

echo "Installing npm dependencies…"
npm install

echo "Downloading Piper voice models…"
python3 scripts/download_voice.py

if [[ -f "$CORI" ]]; then
  echo "● Cori voice ready: $CORI"
else
  echo "○ Cori voice missing — retry: python3 scripts/download_voice.py"
  exit 1
fi

if [[ -f "$JENNY" ]]; then
  echo "● Jenny rollback present: $JENNY"
else
  echo "○ Jenny rollback not present (optional)"
fi

echo ""
echo "Setup complete. Start with: npm run dev"
echo "Voice test: Settings → STARRA voice → Test voice"
