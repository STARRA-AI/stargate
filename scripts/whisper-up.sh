#!/usr/bin/env bash
# Start whisper.cpp's server example — STARGATE's local ears for the private
# call. Loopback only, no hosted STT, no LAN exposure.
# Pattern: scripts/private-gpt-up.sh (detached start, own pid file, refuse
# double-start, poll a health endpoint before reporting ready).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_DIR="$ROOT/data/logs"
LOG="$LOG_DIR/whisper.log"
PID_FILE="$ROOT/data/whisper.pid"
mkdir -p "$LOG_DIR" "$ROOT/data"

BIN="$ROOT/vendor/whisper.cpp/build/bin/whisper-server"
# Default model: base.en, quantized (q5_1) — per Task 2 brief, and the shipped
# default (measured RTF 0.246 vs tiny.en's 0.127; base.en's accuracy wins for
# the ~1.6s it costs on a real turn). Override with WHISPER_MODEL — and note it
# is substituted as a FULL PATH, not a short name:
#   WHISPER_MODEL="$PWD/data/models/whisper/ggml-tiny.en-q5_1.bin" scripts/whisper-up.sh
# (tiny.en-q5_1 is also fetched by bootstrap-whisper.sh.)
MODEL="${WHISPER_MODEL:-$ROOT/data/models/whisper/ggml-base.en-q5_1.bin}"

# Loopback + fixed port, no env override — this is the privacy boundary, not
# a tunable. Vendor's own default bind is already 127.0.0.1
# (vendor/whisper.cpp examples/server/server.cpp:59) but --host/--port are
# passed explicitly so the posture is self-documenting here too, not merely
# inherited from upstream's default (which could change).
HOST="127.0.0.1"
PORT="8178"

if [[ -f "$PID_FILE" ]]; then
  old="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    echo "● whisper-server already running (pid ${old}) on port ${PORT}"
    exit 0
  fi
  echo "◆ Stale pid file (process ${old} not running). Cleaning up."
  rm -f "$PID_FILE"
fi

if [[ ! -x "$BIN" ]]; then
  echo "◆ whisper-server binary not found at $BIN. Run scripts/bootstrap-whisper.sh first."
  exit 1
fi

if [[ ! -f "$MODEL" ]]; then
  echo "◆ Model not found at $MODEL. Run scripts/bootstrap-whisper.sh first."
  exit 1
fi

# Transcription API (verified from vendor source, not web summaries):
#   POST /inference  — multipart/form-data, field "file" (audio) required;
#     optional fields temperature, temperature_inc, no_speech_thold,
#     response_format ("json" default -> {"text":...}; "verbose_json" ->
#     task/language/duration/text/segments[]; also "text"/"srt"/"vtt").
#     Source: examples/server/server.cpp:817-830 (route + required "file"
#     field), :1153-1161 (default "json" response shape), :1056-1150
#     (verbose_json response shape), :117 (response_format defaults to "json").
#   GET  /health — 200 {"status":"ok"} once model is loaded, else 503
#     {"status":"loading model"}. Source: server.cpp:1206-1215.
echo "→ Starting whisper-server on ${HOST}:${PORT} (model: $(basename "$MODEL"))…"
# Same trap-HUP detached form as scripts/starra / private-gpt-up.sh (macOS
# nohup dies under launchd).
# cd /private/var/empty: never leave the server's cwd inside TCC-shielded
# ~/Desktop — launchd-context revivals get EPERM on getcwd/reads there (the
# 2026-08-05 outage class; see private-gpt-up.sh). $MODEL is absolute.
( trap '' HUP; cd /private/var/empty; exec "$BIN" --host "$HOST" --port "$PORT" -m "$MODEL" ) </dev/null >>"$LOG" 2>&1 &
echo $! >"$PID_FILE"

for _ in $(seq 1 60); do
  if curl -fsS "http://${HOST}:${PORT}/health" >/dev/null 2>&1; then
    echo "● whisper-server online at http://${HOST}:${PORT} (POST /inference to transcribe)"
    exit 0
  fi
  sleep 1
done

echo "◆ whisper-server did not come up. Check $LOG"
exit 1
