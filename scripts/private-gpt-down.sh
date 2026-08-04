#!/usr/bin/env bash
# Stop the private-gpt service started by scripts/private-gpt-up.sh.
# Pattern: scripts/starra-up.sh's stop path (kill by pid file).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$ROOT/data/private-gpt.pid"

if [[ -f "$PID_FILE" ]]; then
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "→ Stopping private-gpt (pid ${pid})…"
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
  echo "● private-gpt stopped."
else
  echo "○ private-gpt is not running (no pid file)."
fi
