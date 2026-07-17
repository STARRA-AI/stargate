#!/usr/bin/env bash
# Build a real macOS STARRA.app with custom icon and install to ~/Applications
# (and /Applications if writable).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ICNS="$ROOT/scripts/macos/AppIcon.icns"
LAUNCHER="$ROOT/scripts/starra"
APP_NAME="STARRA.app"
BUILD="/tmp/${APP_NAME}"
DEST_USER="${HOME}/Applications/${APP_NAME}"
DEST_SYS="/Applications/${APP_NAME}"

if [[ ! -f "$ICNS" ]]; then
  echo "◆ Missing AppIcon.icns — regenerate from badge art first."
  exit 1
fi
if [[ ! -x "$LAUNCHER" ]]; then
  chmod +x "$LAUNCHER"
fi

rm -rf "$BUILD"
mkdir -p "$BUILD/Contents/MacOS" "$BUILD/Contents/Resources"

cat >"$BUILD/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>STARRA</string>
  <key>CFBundleDisplayName</key>
  <string>STARRA</string>
  <key>CFBundleIdentifier</key>
  <string>llc.starra.stargate</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>STARRA</string>
  <key>CFBundleIconFile</key>
  <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

cp "$ICNS" "$BUILD/Contents/Resources/AppIcon.icns"

cat >"$BUILD/Contents/MacOS/STARRA" <<EOF
#!/usr/bin/env bash
# Opens STARGATE (starts stack if needed) then focuses the browser HUD.
exec "$LAUNCHER" open
EOF
chmod +x "$BUILD/Contents/MacOS/STARRA"

mkdir -p "${HOME}/Applications"
rm -rf "$DEST_USER"
cp -R "$BUILD" "$DEST_USER"

# Refresh Finder icon cache for this app
touch "$DEST_USER"
if command -v osascript >/dev/null 2>&1; then
  osascript -e "tell application \"Finder\" to update POSIX file \"$DEST_USER\"" 2>/dev/null || true
fi

echo "● Installed: $DEST_USER"
echo "  Look in Finder → Go → Applications (or press Cmd+Shift+A),"
echo "  then open the STARRA folder under your user Applications,"
echo "  OR Spotlight: Cmd+Space → type STARRA"

if [[ -w /Applications ]]; then
  rm -rf "$DEST_SYS"
  cp -R "$BUILD" "$DEST_SYS"
  touch "$DEST_SYS"
  echo "● Also copied to /Applications/STARRA.app"
else
  echo "○ /Applications not writable — using ~/Applications only."
  echo "  To put it with system apps: drag STARRA.app into /Applications in Finder."
fi

# Remove confusing .command if present
rm -f "${HOME}/Applications/STARRA.command" 2>/dev/null || true

echo ""
echo "Double-click STARRA.app — she starts and the HUD opens."
echo "Phone: same Wi-Fi → http://\$(ipconfig getifaddr en0):3000"
