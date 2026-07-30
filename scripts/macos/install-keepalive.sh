#!/usr/bin/env bash
# Install (or remove) the STARRA keepalive LaunchAgent.
#
#   bash scripts/macos/install-keepalive.sh            # install + start now
#   bash scripts/macos/install-keepalive.sh uninstall  # remove it
#
# What this buys: launchd keeps scripts/starra-watchdog.sh alive, and the
# watchdog keeps the deck alive. A crash is revived within ~20s; a reboot brings
# her back at login. Nothing here costs money, needs an account, or needs sudo —
# it is a per-user LaunchAgent using tools already on the Mac.
set -euo pipefail

# Symlink-safe path resolution — same reason as scripts/starra: this file may be
# invoked through a link, and `dirname "$0"` would then point somewhere else.
_src="${BASH_SOURCE[0]}"
_hops=0
while [[ -L "$_src" && $_hops -lt 20 ]]; do
  _t="$(readlink "$_src")"
  if [[ "$_t" == /* ]]; then _src="$_t"; else _src="$(dirname "$_src")/$_t"; fi
  _hops=$((_hops + 1))
done
HERE="$(cd "$(dirname "$_src")" && pwd)"
# This file lives at scripts/macos/, so the repo root is TWO levels up, not one.
PROJ="$(cd "$HERE/../.." && pwd)"
[[ -f "$PROJ/package.json" ]] || { echo "◆ Repo root not found (looked at $PROJ) — refusing to install a keepalive pointing at the wrong place."; exit 1; }

LABEL="com.starra.deck"
TEMPLATE="$HERE/com.starra.deck.plist"
AGENTS="$HOME/Library/LaunchAgents"
TARGET="$AGENTS/${LABEL}.plist"
DOMAIN="gui/$(id -u)"

# Stop the job whichever launchctl dialect this macOS prefers. Both are tried
# because `bootout` is the modern form and `unload` the legacy one; a failure
# here just means it wasn't loaded, which is fine.
stop_job() {
  launchctl bootout "${DOMAIN}/${LABEL}" 2>/dev/null || true
  launchctl unload -w "$TARGET" 2>/dev/null || true
}

if [[ "${1:-}" == "uninstall" ]]; then
  stop_job
  if [[ -f "$TARGET" ]]; then
    mkdir -p "$PROJ/data/backups"
    cp -p "$TARGET" "$PROJ/data/backups/${LABEL}.plist.removed-$(date +%Y%m%d)" 2>/dev/null || true
    rm -f "$TARGET"
  fi
  echo "● Keepalive removed. She will no longer restart herself."
  echo "  A copy of the removed agent is in data/backups/ if you want it back."
  exit 0
fi

[[ -f "$TEMPLATE" ]] || { echo "◆ Missing template: $TEMPLATE"; exit 1; }
[[ -f "$PROJ/scripts/starra-watchdog.sh" ]] || { echo "◆ Missing watchdog: $PROJ/scripts/starra-watchdog.sh"; exit 1; }

chmod +x "$PROJ/scripts/starra-watchdog.sh" 2>/dev/null || true
mkdir -p "$AGENTS" "$PROJ/data/logs" "$PROJ/data/backups"

# Never clobber an existing agent without keeping a copy.
if [[ -f "$TARGET" ]]; then
  cp -p "$TARGET" "$PROJ/data/backups/${LABEL}.plist.bak-$(date +%Y%m%d)" 2>/dev/null || true
fi

# Build the real plist from the template. `|` as the sed delimiter so a path
# containing `/` (every path) is safe. Written to a temp file and validated
# BEFORE it replaces anything — an invalid plist that launchd refuses would
# otherwise leave her with no keepalive at all.
TMP="$(mktemp -t starra-keepalive)"
trap 'rm -f "$TMP"' EXIT
sed "s|__PROJ__|${PROJ}|g" "$TEMPLATE" >"$TMP"

if ! plutil -lint "$TMP" >/dev/null 2>&1; then
  echo "◆ Generated plist failed validation — nothing installed. Detail:"
  plutil -lint "$TMP" || true
  exit 1
fi

if grep -q '__PROJ__' "$TMP"; then
  echo "◆ Path substitution failed (placeholder still present) — nothing installed."
  exit 1
fi

# ── macOS PRIVACY PRE-FLIGHT ────────────────────────────────────────────────
# Measured on this Mac 2026-07-28: a launchd-spawned process can chdir into
# ~/Desktop and can curl the deck, but CANNOT read file contents there —
# `head -1 scripts/starra-watchdog.sh` returns "Operation not permitted" (EPERM),
# so bash exits 126 and launchd respawns it forever. That is macOS TCC shielding
# ~/Desktop from background jobs, and this repo lives under ~/Desktop.
#
# So: actually TEST it with a throwaway agent before promising protection.
# Installing a keepalive that silently dies is worse than not installing one —
# it is the exact "she was down and nothing said so" failure this is meant to end.
probe_launchd_can_read_repo() {
  local plabel="com.starra.keepalive.probe"
  local pout="/tmp/${plabel}.out"
  local pplist="$AGENTS/${plabel}.plist"
  rm -f "$pout"
  cat >"$pplist" <<PROBE
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${plabel}</string>
<key>ProgramArguments</key><array>
<string>/bin/bash</string><string>-c</string>
<string>head -c 1 '${PROJ}/package.json' &gt; '${pout}' 2&gt;&amp;1</string>
</array>
<key>RunAtLoad</key><true/>
</dict></plist>
PROBE
  launchctl bootout "${DOMAIN}/${plabel}" 2>/dev/null || true
  launchctl bootstrap "$DOMAIN" "$pplist" 2>/dev/null || launchctl load -w "$pplist" 2>/dev/null || true
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [[ -s "$pout" ]] && break
    sleep 0.5
  done
  launchctl bootout "${DOMAIN}/${plabel}" 2>/dev/null || true
  rm -f "$pplist"
  local res=1
  if [[ -s "$pout" ]] && ! grep -qi "not permitted\|denied" "$pout"; then res=0; fi
  rm -f "$pout"
  return $res
}

echo "→ Checking whether macOS will let a background job read this folder…"
if ! probe_launchd_can_read_repo; then
  # Clear out any agent from a previous install. Leaving one behind would let
  # launchd load a watchdog at next login that instantly dies and respawns
  # forever — the worst outcome: burning CPU while looking protected.
  stop_job
  if [[ -f "$TARGET" ]]; then
    rm -f "$TARGET"
    echo "→ Removed a previously installed keepalive agent so it cannot thrash at login."
  fi
  # launchd cannot do this job here — but that is not a reason to leave her
  # unguarded. Measured on this Mac 2026-07-28: a process started from a SHELL
  # (which already has Desktop access) keeps that access after it detaches and
  # is reparented to launchd — probe pid ran with ppid=1 and kept reading
  # package.json every 2s long after its launcher exited — while a launchd-
  # spawned job reading the same file gets EPERM even when its script lives
  # outside ~/Desktop. So arm the shell-spawned guard right now, and be exact
  # about what it does and does not cover.
  guard_line="◆ Crash guard could NOT be started either — see $PROJ/data/logs/starra-keepalive.log"
  guard_rc=2
  if bash "$PROJ/scripts/starra" guard >/dev/null 2>&1; then
    gpid="$(cat "$PROJ/data/starra-watchdog.pid" 2>/dev/null || echo '?')"
    guard_line="● Crash guard ARMED right now instead (watchdog pid ${gpid}) — she revives
  herself within ~20s if the deck dies, for as long as you stay logged in."
    guard_rc=0
  fi

  cat <<BLOCKED
◆ Login keepalive NOT installed — macOS is blocking it, and installing anyway
  would give you a watchdog that dies every 30 seconds while claiming to guard
  her.

  Why: this repo lives under ~/Desktop. macOS shields Desktop from background
  (launchd) jobs — they can see the folder but cannot read the files. Verified
  just now with a throwaway launchd job: reading package.json came back
  "Operation not permitted".

${guard_line}

  What is still missing: a REBOOT. The guard above lives in your login session,
  so after restarting the Mac you run \`starra\` once and it re-arms itself.
  To make even that automatic — two free ways, pick one:

  1) 30-second permission grant (keeps the repo where it is):
       System Settings → Privacy & Security → Full Disk Access
       → "+" → press Cmd+Shift+G → type /bin/bash → Open → toggle it ON
       Then re-run:  bash scripts/macos/install-keepalive.sh

  2) Move the repo out of the shielded area (no permission grants at all), e.g.
       ~/Projects/stargate  or  ~/STARGATE
       then re-run \`starra install\` and this script. Nothing else changes.

  Check any time:  starra status
BLOCKED
  exit $guard_rc
fi
echo "● macOS allows it — proceeding."

stop_job
cp "$TMP" "$TARGET"
chmod 644 "$TARGET"

# Load it. bootstrap is the modern form; fall back to legacy load.
if ! launchctl bootstrap "$DOMAIN" "$TARGET" 2>/dev/null; then
  launchctl load -w "$TARGET" 2>/dev/null || true
fi

# Give the watchdog a moment to actually come up, then judge it by whether it
# has a live pid — not merely by whether launchd accepted the file.
sleep 2
if launchctl list "$LABEL" 2>/dev/null | grep -q '"PID"'; then
  echo "● Keepalive armed: $LABEL"
  echo "  agent:    $TARGET"
  echo "  watchdog: $PROJ/scripts/starra-watchdog.sh"
  echo "  log:      $PROJ/data/logs/starra-watchdog.log"
  echo ""
  echo "  She now comes back on her own if the deck crashes (~20s), and at login."
  echo "  Straight talk: this is a LaunchAgent, so after a reboot she starts when"
  echo "  you LOG IN — not while the Mac is sitting at the login window."
  echo "  \`starra stop\` still means stop: it pauses the watchdog until \`starra up\`."
  echo ""
  echo "  Check any time:  starra status"
  echo "  Remove:          bash scripts/macos/install-keepalive.sh uninstall"
else
  # Loaded but no live pid = it is dying on launch. Do not leave that in place
  # pretending to protect her, and do not let launchd respawn it forever.
  laststatus="$(launchctl list "$LABEL" 2>/dev/null | awk -F'= ' '/"LastExitStatus"/{gsub(/[; ]/,"",$2); print $2; exit}')"
  stop_job
  rm -f "$TARGET"
  echo "◆ The watchdog started but died immediately (last exit: ${laststatus:-unknown})."
  echo "  Removed the agent rather than leave a dead one claiming to guard her."
  echo "  Look at: $PROJ/data/logs/starra-keepalive.log"
  exit 1
fi
