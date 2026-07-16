#!/usr/bin/env bash
# Heavy OpenMontage install (venv + Remotion). Idempotent.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor/OpenMontage"

if [[ ! -d "$VENDOR/.git" && ! -f "$VENDOR/README.md" ]]; then
  echo "→ OpenMontage missing — cloning…"
  mkdir -p "$ROOT/vendor"
  git clone --depth 1 https://github.com/calesthio/OpenMontage.git "$VENDOR"
fi

cd "$VENDOR"

if [[ ! -d .venv ]]; then
  echo "→ Creating Python venv…"
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
if [[ -f requirements.txt ]]; then
  echo "→ pip install -r requirements.txt…"
  pip install -r requirements.txt
else
  echo "⚠ No requirements.txt — skip pip"
fi

if [[ -d remotion-composer ]]; then
  echo "→ remotion-composer npm install…"
  (cd remotion-composer && npm install)
else
  echo "⚠ remotion-composer missing — skip"
fi

echo "✓ OpenMontage setup complete."
echo "  Next: Tools → OpenMontage → Queue brief"
echo "  Render: open AGENT_GUIDE.md in Cursor with the brief."
echo "  Higgsfield is retired — do not wire it."
