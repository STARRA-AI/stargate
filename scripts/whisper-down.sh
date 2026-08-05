#!/usr/bin/env bash
# Stop the whisper.cpp server started by scripts/whisper-up.sh.
# Pattern: scripts/private-gpt-down.sh (kill by pid file).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/data/whisper.pid"

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "→ Stopping whisper-server (pid ${pid})…"
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.5
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  else
    echo "◆ Stale pid file (process not running)."
  fi
  rm -f "$PID_FILE"
  echo "● whisper-server stopped."
else
  echo "○ whisper-server is not running (no pid file)."
fi
