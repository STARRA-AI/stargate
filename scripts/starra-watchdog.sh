#!/usr/bin/env bash
# ── STARRA HEALTH WATCHDOG ───────────────────────────────────────────────────
# Runs in the FOREGROUND forever and is supervised by launchd
# (scripts/macos/com.starra.deck.plist, label com.starra.deck).
#
# Why a foreground looping watchdog instead of pointing launchd straight at
# `starra up`: `starra up` starts the deck with nohup and then EXITS. launchd
# would see the job exit, and with KeepAlive=true it would relaunch it forever
# in a tight loop. So launchd supervises THIS process (which never exits), and
# this process supervises the deck. launchd covers "the watchdog died";
# the watchdog covers "the deck died".
#
# Guarantees:
#   • deck answering        → do nothing
#   • deck down             → run `starra up`
#   • Classic ran `starra stop` (pause sentinel present) → stay down, no fight
#   • deck repeatedly fails → back off, so a broken build can't thrash npm
#     (and burn CPU/battery) every 20 seconds all day
#
# Every decision is written to the log with a timestamp, so a silent death is
# never silent again.

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STARRA="$SELF_DIR/starra"

if [[ ! -x "$STARRA" && ! -f "$STARRA" ]]; then
  echo "FATAL: launcher not found at $STARRA" >&2
  exit 1
fi

# Reuse the launcher's OWN health checks and paths instead of re-implementing
# them — if `starra` changes what "up" means, the watchdog changes with it.
# Safe because scripts/starra only runs main() when executed, not when sourced.
# shellcheck source=/dev/null
source "$STARRA"

# The launcher is written with `set -euo pipefail`, which sourcing just applied
# to this shell. That is exactly wrong for a supervisor: a single non-zero
# command (a failed curl, a missing file) would kill the watchdog. Drop it and
# handle errors explicitly from here on.
set +e
set +u
set +o pipefail

INTERVAL="${STARRA_WATCH_INTERVAL:-20}"     # seconds between health checks
BACKOFF_AFTER="${STARRA_WATCH_BACKOFF_AFTER:-3}"  # consecutive failed revivals
BACKOFF_INTERVAL="${STARRA_WATCH_BACKOFF_INTERVAL:-300}"  # then check this slowly
WATCHLOG="$PROJ/data/logs/starra-watchdog.log"

mkdir -p "$(dirname "$WATCHLOG")" 2>/dev/null

log() {
  printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$WATCHLOG" 2>/dev/null
}

# ── SINGLE INSTANCE ──────────────────────────────────────────────────────────
# Two watchdogs would both see the deck down, both run `starra up`, race for the
# port, and each overwrite the other's pid file — so `status` would report a pid
# that is not the one doing the guarding. That stopped being hypothetical when
# the guard became something a shell can arm (`starra up` / `starra guard`) in
# addition to launchd. `mkdir` is the atomic test-and-set available on every
# macOS; the pid file beside it names the owner, so a stale lock left by a crash
# or a reboot can be told apart from a live one instead of blocking forever.
LOCK_DIR="$PROJ/data/starra-watchdog.lock"
GUARD_PID_FILE="${GUARD_PID_FILE:-$PROJ/data/starra-watchdog.pid}"

lock_owner_alive() {
  local p
  p="$(cat "$GUARD_PID_FILE" 2>/dev/null)"
  [[ "$p" =~ ^[0-9]+$ ]] || return 1
  [[ "$p" == "$$" ]] && return 1
  kill -0 "$p" 2>/dev/null || return 1
  # A bare `kill -0` is not enough: after a reboot that number belongs to some
  # unrelated process, and standing down for it would leave her unguarded.
  ps -o command= -p "$p" 2>/dev/null | grep -q 'starra-watchdog' || return 1
  return 0
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  if lock_owner_alive; then
    log "another watchdog is already guarding her (pid $(cat "$GUARD_PID_FILE" 2>/dev/null)) — this one is standing down"
    exit 0
  fi
  rm -rf "$LOCK_DIR" 2>/dev/null
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "could not take the watchdog lock at $LOCK_DIR — standing down rather than running blind"
    exit 0
  fi
  log "cleared a stale watchdog lock (its owner is gone)"
fi
echo "$$" >"$GUARD_PID_FILE"

# Never leave a pid file behind: `starra status` reads it, and a stale one would
# claim a guard that is not there — the exact lie this whole pass exists to end.
# Registered only AFTER the lock is ours, so the stand-down path above can never
# delete the live owner's files.
cleanup_lock() {
  if [[ "$(cat "$GUARD_PID_FILE" 2>/dev/null)" == "$$" ]]; then
    rm -f "$GUARD_PID_FILE" 2>/dev/null
    rm -rf "$LOCK_DIR" 2>/dev/null
  fi
}
trap 'cleanup_lock' EXIT

# `bash starra up` below is a CHILD of this process. Without this it would arm a
# second guard on every revival — a watchdog fork bomb. cmd_up checks this.
export STARRA_WATCHDOG=$$

fails=0
last_state=""
log "watchdog started (pid $$) — proj=$PROJ port=$PORT scheme=$SCHEME interval=${INTERVAL}s"
log "guarding ${SCHEME}://127.0.0.1:${PORT} ; pause sentinel = $PAUSE_FILE"

# INTERRUPTIBLE SLEEP. A plain `sleep 20` in the foreground makes bash DEFER the
# TERM trap until the sleep finishes — proved on this Mac 2026-07-28: a script
# doing `sleep 20` was still alive 3 seconds after SIGTERM. That is not cosmetic:
# `starra guard stop` would return while the watchdog was still running, its pid
# file already deleted, and the next `starra up` would arm a SECOND watchdog —
# two supervisors racing to restart the same deck. Backgrounding the sleep and
# `wait`ing on it makes the signal land immediately, because `wait` is a trap
# cancellation point and `sleep` is not.
NAP_PID=""
nap() {
  sleep "$1" &
  NAP_PID=$!
  wait "$NAP_PID" 2>/dev/null
  NAP_PID=""
}

# Clean shutdown when launchd (or `starra guard stop`) stops the job, so the log
# shows an intentional exit rather than a mystery gap.
trap 'log "watchdog stopping (signal received)"; [[ -n "$NAP_PID" ]] && kill "$NAP_PID" 2>/dev/null; exit 0' TERM INT

while true; do
  if [[ -f "$PAUSE_FILE" ]]; then
    # Deliberate `starra stop`. Do NOT revive her — that would make the stop
    # command look broken. `starra up` deletes this file.
    [[ "$last_state" != "paused" ]] && log "paused by $PAUSE_FILE (starra stop) — standing down"
    last_state="paused"
    fails=0
    nap "$INTERVAL"
    continue
  fi

  if deck_up; then
    if [[ "$last_state" != "up" ]]; then
      log "deck healthy at ${SCHEME}://127.0.0.1:${PORT}"
    fi
    last_state="up"
    fails=0
    nap "$INTERVAL"
    continue
  fi

  # Deck is not answering. Revive her.
  last_state="down"
  fails=$((fails + 1))
  log "deck NOT answering (consecutive failures: $fails) — running \`starra up\`"

  # `up` brings Ollama back too, and waits for health itself. Its output goes to
  # the watchdog log so a failed revival leaves evidence.
  bash "$STARRA" up >>"$WATCHLOG" 2>&1
  rc=$?

  if deck_up; then
    log "revived — deck answering again (starra up rc=$rc)"
    last_state="up"
    fails=0
    nap "$INTERVAL"
    continue
  fi

  log "revival FAILED (starra up rc=$rc); deck still not answering"

  if [[ "$fails" -ge "$BACKOFF_AFTER" ]]; then
    # Something is genuinely broken (bad build, port taken, no node). Stop
    # hammering npm every 20s; check slowly until it's fixed.
    log "backing off to ${BACKOFF_INTERVAL}s after $fails failed revivals — fix the build, the watchdog will pick her up"
    nap "$BACKOFF_INTERVAL"
  else
    nap "$INTERVAL"
  fi
done
