#!/usr/bin/env bash
# Install / update STARRA.app from the version-controlled launcher.
#
# WHY THIS EXISTS. The launcher used to live ONLY inside the .app bundle, so
# there were two copies on this Mac — /Applications/STARRA.app (what the Dock
# launches) and ~/STARRA.app — and they silently drifted. On 2026-08-08 the
# /Applications one was two days stale and still hardcoded to 127.0.0.1, where
# WebAuthn refuses to bind a passkey, so Touch ID could never appear no matter
# what the deck did. The repo is the source of truth now; run this to sync.
#
# Editing a signed bundle BREAKS its signature and macOS can refuse to launch
# it, so this re-signs (ad-hoc — no certificate, no password) every time.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="/Applications/STARRA.app"

[[ -d "$APP" ]] || { echo "✖ $APP not found — nothing to update."; exit 1; }

install -m 755 "$HERE/STARGATE-launcher.sh" "$APP/Contents/MacOS/STARGATE"
codesign --force --deep --sign - "$APP"
codesign --verify --strict "$APP" || { echo "✖ signature did not verify"; exit 1; }

# One bundle, one truth: the home path is a pointer, never a rival copy.
if [[ -e "$HOME/STARRA.app" && ! -L "$HOME/STARRA.app" ]]; then
  rm -rf "$HOME/STARRA.app"
fi
[[ -L "$HOME/STARRA.app" ]] || ln -s "$APP" "$HOME/STARRA.app"

echo "● STARRA.app updated and signed."
echo "  opens: $(grep -m1 '^DECK=' "$APP/Contents/MacOS/STARGATE" | cut -d'"' -f2)"
