#!/bin/zsh
# ─────────────────────────────────────────────────────────────────────────────
# STARGATE app — opens the deck in a chromeless Chrome window.
# Chrome (not WKWebView) because the WKWebView on this 2013 Mac lacks color-mix
# and other modern CSS/JS the deck uses.
#
# FIXED 2026-07-29. Four proven defects, all diagnosed from real evidence:
#
#  1. --app WAS BEING IGNORED, so Classic landed on Chrome's New Tab Page and had
#     to click the "STARGATE — STARRA" shortcut tile himself. Proof: that
#     profile's Top Sites db held 127.0.0.1:3000 at rank 0 and localhost:3000 at
#     rank 1, and Preferences recorded
#     ntp.most_visited_tile_navigation_count = 14.
#     CAUSE: --app is a STARTUP-ONLY switch. On macOS, closing the window does
#     not quit Chrome, so every later launch merely forwards its command line to
#     the surviving process — and a forwarded command line ignores --app, opening
#     a normal tab instead. FIX: quit this profile's Chrome first (see below) so
#     the exec below always starts a genuinely new browser process.
#
#  2. HOST MISMATCH. The health check probed 127.0.0.1 while Chrome was pointed
#     at localhost. The deck binds IPv4 ONLY (verified: `lsof -nP -iTCP:3000`
#     shows one IPv4 listener; http://[::1]:3000 fails outright), and Chrome's
#     resolver may prefer ::1. FIX: 127.0.0.1 everywhere, no name resolution.
#
#  3. FALSE READY. The old gate accepted any response from "/" — but "/" returns
#     a 307 to /login as soon as middleware compiles, roughly 7s BEFORE /login
#     can actually render. Chrome opened onto a page that was not servable yet.
#     FIX: require HTTP 200 from /login, which proves Next really is serving.
#
#  4. MIC GRANT CLOBBERED. Preferences was written while a Chrome instance was
#     still running, so that instance overwrote it from memory on exit.
#     FIX: quit Chrome FIRST, then write Preferences, then launch.
#
# Nothing here touches Classic's main Chrome. This profile is dedicated to the
# STARGATE app, so quitting it loses no browsing session.
# ─────────────────────────────────────────────────────────────────────────────
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

PROFILE="$HOME/.starra-app-profile"
# The deck picks its own scheme: scripts/starra serves https ONLY when the mkcert
# root CA is actually trusted in a keychain, and plain http otherwise. Hardcoding
# https here meant a machine without `mkcert -install` probed a TLS port that was
# speaking plaintext, got nothing, and died with "the deck never answered" — even
# though she was up and healthy on http the whole time.
# So: follow the deck instead of dictating to it. https is still preferred, and
# once the CA is trusted this resolves to https on the first probe exactly as before.
# ── WHY localhost AND NOT 127.0.0.1 (2026-08-08) ──
# TOUCH ID. WebAuthn refuses to bind a passkey to an IP address
# (src/lib/webauthn.ts:72-74 blocks it outright with a message), so a deck
# opened at 127.0.0.1 can NEVER offer Touch ID no matter what else is right.
# The name is the whole point.
#
# This reverses note 2 above ("127.0.0.1 everywhere, no name resolution"), and
# only because the cause of that bug is now fixed: `localhost` resolves to ::1
# first here, and the deck used to bind IPv4 ONLY, so the ::1 connection was
# refused. scripts/starra now binds `::` (dual-stack), verified answering on
# 127.0.0.1, localhost, [::1] AND the LAN address. So the name resolves either
# way and note 2's failure cannot recur.
#
# The IP stays as fallback: if a future deck ever binds IPv4-only again, the
# probe chain below still finds her — she just loses Touch ID until it is fixed.
DECK="https://localhost:3000"
DECK_FALLBACK="https://127.0.0.1:3000"
DECK_FALLBACK_HTTP="http://localhost:3000"
DECK_FALLBACK_HTTP_IP="http://127.0.0.1:3000"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
STARRA="$HOME/STARGATE/stargate/scripts/starra"

note() { osascript -e "display notification \"$1\" with title \"STARGATE\"" >/dev/null 2>&1 || true; }
die() {
  osascript -e "display alert \"STARGATE could not start\" message \"$1\" as critical" >/dev/null 2>&1 || true
  exit 1
}

# Real readiness: 200 from a page that must be compiled and rendered to answer.
# -k: /usr/bin/curl (LibreSSL) can't see keychain trust, so the mkcert cert
# fails ITS verification even though Chrome/WebKit trust it fine.
probe() { curl -skf -m 4 -o /dev/null "$1/login"; }

# Try https, then http; whichever answers becomes THE url for the rest of the run
# (including the Chrome --app launch below), so the window never opens on a scheme
# the deck isn't actually serving.
deck_ready() {
  # Ordered by preference: the https NAME first (Touch ID works only there),
  # then the https IP, then the http pair for a deck without a trusted CA.
  for candidate in "$DECK" "$DECK_FALLBACK" "$DECK_FALLBACK_HTTP" "$DECK_FALLBACK_HTTP_IP"; do
    if probe "$candidate"; then DECK="$candidate"; return 0; fi
  done
  return 1
}

# ── ALWAYS LAND ON THE NAME ── (2026-08-08)
# The chain above races a cold Next.js. If the FIRST probe times out because she
# is still compiling, readiness falls through to the 127.0.0.1 entry and the
# window opens on the IP — where Touch ID is refused outright. She is up, the
# page loads, and the only symptom is that Touch ID silently never appears.
# Measured: a warm deck answers localhost in ~0.25s, but a cold one can exceed
# the 4s probe.
#
# So once she is KNOWN up, spend one generous probe re-checking the name and
# upgrade to it. Same deck either way (the bind is dual-stack) — this only
# decides which hostname the window carries, which is the whole Touch ID story.
prefer_named_host() {
  case "$DECK" in
    *//localhost:*) return 0 ;;  # already on the name
  esac
  named="${DECK/127.0.0.1/localhost}"
  if curl -skf -m 20 -o /dev/null "$named/login"; then
    DECK="$named"
  fi
}

# ── 1. bring the deck up if it is not already serving ────────────────────────
if ! deck_ready; then
  note "Waking her up…"
  if [[ ! -x "$STARRA" ]]; then
    die "The launcher script is missing at:\n$STARRA\n\nThe repo may have moved."
  fi
  "$STARRA" up >/dev/null 2>&1 &
  # Cold Next.js starts can exceed 40s when .next has to rebuild — 90s, and we
  # stop as soon as she actually answers.
  for i in {1..90}; do
    deck_ready && break
    sleep 1
  done
fi

deck_ready || die "The deck never answered on ${DECK} or ${DECK_FALLBACK}.\n\nOpen Terminal and run:\n  bash ~/STARGATE/stargate/scripts/starra status"

prefer_named_host   # Touch ID needs the hostname, not the IP

# ── 2. quit ONLY this profile's Chrome so --app is honored on a fresh start ───
# Matching on the exact --user-data-dir makes this incapable of touching the main
# browser. Helper processes carry the same flag, so the whole instance goes.
if pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1; then
  pkill -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1 || true
  for i in {1..20}; do
    pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1 || break
    sleep 0.25
  done
  # Anything still alive after 5s gets SIGKILL, or the profile lock blocks us.
  pgrep -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1 && \
    pkill -9 -f -- "--user-data-dir=$PROFILE" >/dev/null 2>&1 || true
  sleep 0.4
fi

# ── 3. pre-grant the mic for the deck origin (now that Chrome cannot clobber) ─
# Browser-site layer only. macOS must also allow Google Chrome under
# System Settings → Privacy & Security → Microphone — a one-time user grant.
python3 - <<'PY' 2>/dev/null || true
import json, os
prof = os.path.expanduser("~/.starra-app-profile/Default")
os.makedirs(prof, exist_ok=True)
pref = os.path.join(prof, "Preferences")
try:
    with open(pref) as fh:
        d = json.load(fh)
except Exception:
    d = {}
exc = d.setdefault("profile", {}).setdefault("content_settings", {}).setdefault("exceptions", {})
for kind in ("media_stream_mic",):
    table = exc.setdefault(kind, {})
    for origin in ("http://127.0.0.1:3000,*", "http://localhost:3000,*",
                   "https://127.0.0.1:3000,*", "https://localhost:3000,*"):
        table[origin] = {"setting": 1}  # 1 = Allow
# Land straight on the deck; never restore a stray tab or the New Tab Page.
sess = d.setdefault("session", {})
sess["restore_on_startup"] = 4          # 4 = open a specific set of URLs
sess["startup_urls"] = ["https://127.0.0.1:3000/"]
tmp = pref + ".tmp"
with open(tmp, "w") as fh:
    json.dump(d, fh)
os.replace(tmp, pref)
PY

# ── 4. chromeless standalone window, dedicated profile ───────────────────────
exec "$CHROME" --app="$DECK/" \
  --user-data-dir="$PROFILE" \
  --window-size=1440,900 \
  --class=STARGATE \
  --no-first-run \
  --no-default-browser-check \
  >/dev/null 2>&1
