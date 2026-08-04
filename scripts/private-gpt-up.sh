#!/usr/bin/env bash
# Start the private-gpt service — STARGATE's private lane, backed EXCLUSIVELY
# by the local Ollama (http://127.0.0.1:11434). No hosted endpoint may ever
# appear in this config; privacy is the spec.
# Pattern: scripts/starra-up.sh (detached start, own pid file, refuse
# double-start). Does NOT wire into starra-up.sh or the watchdog — autostart
# is Classic's call, later.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/data/logs"
LOG="$LOG_DIR/private-gpt.log"
PID_FILE="$ROOT/data/private-gpt.pid"
mkdir -p "$LOG_DIR" "$ROOT/data"

# ── Config: LLM + embeddings both point at Ollama's OpenAI-compat surface ──
# Source: vendor/private-gpt fern/docs/pages/providers/ollama.mdx:63,74
export OPENAI_API_BASE="http://127.0.0.1:11434/v1"
# Source: vendor/private-gpt fern/docs/pages/installation/package.mdx:123
export OPENAI_EMBEDDING_API_BASE="http://127.0.0.1:11434/v1"
# Source: vendor/private-gpt settings.yaml:107 (PGPT_LLM_DEFAULT)
export PGPT_LLM_DEFAULT="qwen2.5:3b"
# Source: vendor/private-gpt settings.yaml:114 (PGPT_EMBEDDING_DEFAULT).
# Must match Ollama's OpenAI-compat /v1/models id exactly, including the
# ":latest" tag Ollama attaches to models pulled without an explicit tag
# (verified live: curl :11434/v1/models -> "id":"nomic-embed-text:latest") —
# a bare "nomic-embed-text" default fails PrivateGPT's model-registry lookup
# at startup (private_gpt/components/embedding/embedding_component.py:91-97,
# "Default model 'nomic-embed-text' not found in registered models").
export PGPT_EMBEDDING_DEFAULT="nomic-embed-text:latest"
# Keep all local data (vector store, ingested docs, caches) inside the repo's
# own data/ dir instead of the vendor default ~/.local/share/private-gpt
# (vendor/private-gpt fern/docs/pages/installation/package.mdx:103-115).
export PGPT_HOME="$ROOT/data/private-gpt"
# This is an 8GB machine that can be under heavy contention from other local
# processes; the vendor's default chat-scheduler timeout (300s) can be too
# short for qwen2.5:3b's first-token latency under load. Give it more room.
# Source: vendor/private-gpt settings.yaml:324 (PGPT_CHAT_CALLBACK_TIMEOUT_SECONDS)
export PGPT_CHAT_CALLBACK_TIMEOUT_SECONDS="900"

PORT="${PRIVATE_GPT_PORT:-8080}"
HOST="127.0.0.1"
# Bind loopback ONLY. The vendor's own default is host=0.0.0.0 with auth
# disabled (vendor/private-gpt private_gpt/settings/settings.py:323-326,
# settings.yaml:14) — that combination would publish an unauthenticated
# document/RAG API to the whole LAN. --host/--port flags verified at
# vendor/private-gpt private_gpt/cli/commands/serve.py:19-21,58-66.

if [[ -f "$PID_FILE" ]]; then
  old="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    echo "● private-gpt already running (pid ${old}) on port ${PORT}"
    exit 0
  fi
  echo "◆ Stale pid file (process ${old} not running). Cleaning up."
  rm -f "$PID_FILE"
fi

if ! command -v private-gpt >/dev/null 2>&1; then
  echo "◆ private-gpt CLI not found. Run scripts/bootstrap-private-gpt.sh first."
  exit 1
fi

echo "→ Starting private-gpt on ${HOST}:${PORT} (Ollama-only: ${OPENAI_API_BASE})…"
# Same trap-HUP detached form as scripts/starra (macOS nohup dies under launchd).
( trap '' HUP; exec private-gpt serve --host "$HOST" --port "$PORT" ) </dev/null >>"$LOG" 2>&1 &
echo $! >"$PID_FILE"

for _ in $(seq 1 60); do
  if curl -fsS "http://${HOST}:${PORT}/v1/models" >/dev/null 2>&1; then
    echo "● private-gpt online at http://${HOST}:${PORT}"
    exit 0
  fi
  sleep 1
done

echo "◆ private-gpt did not come up. Check $LOG"
exit 1
