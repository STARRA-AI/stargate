#!/usr/bin/env bash
# STARGATE daily start — keeps HUD on SSD, models on the 1TB Storage drive.
set -euo pipefail

STORAGE="/Volumes/Storage"
MODELS="$STORAGE/STARRA/ollama/models"
PROJ="/Users/work/Projects/stargate"
LOG="$STORAGE/STARRA/logs/starra-up.log"

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

if [[ ! -d "$STORAGE/STARRA" ]]; then
  echo "Storage drive not mounted."
  echo "Plug in the 1TB drive (should appear as /Volumes/Storage), then run this again."
  exit 1
fi

export OLLAMA_MODELS="$MODELS"
export OLLAMA_HOST="127.0.0.1:11434"

# Start Ollama if not already listening
if ! curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
  echo "Starting Ollama (models on Storage)…"
  nohup /usr/local/bin/ollama serve >>"$LOG" 2>&1 &
  sleep 2
fi

if ! curl -sf "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
  echo "Ollama did not start. Open Terminal and run: ollama serve"
  exit 1
fi

echo "Ollama online. Models dir: $OLLAMA_MODELS"
cd "$PROJ"
echo "Starting STARGATE at http://localhost:3000 …"
exec npm run dev
