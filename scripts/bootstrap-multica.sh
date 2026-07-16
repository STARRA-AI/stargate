#!/usr/bin/env bash
# Shallow-clone Multica vendor tree for STARGATE (doctrine + API reference).
# Vendor is gitignored — never commit the tree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p vendor

if [[ ! -d vendor/multica/.git ]]; then
  echo "→ Cloning Multica (shallow)…"
  git clone --depth 1 https://github.com/multica-ai/multica.git vendor/multica
else
  echo "✓ Multica present at vendor/multica"
fi

echo "→ Multica CLI (optional): brew install multica-ai/tap/multica"
echo "→ Link PAT in Settings → LINK APIS (multica_token). Cloud API default: https://api.multica.ai"
echo "→ Done."
