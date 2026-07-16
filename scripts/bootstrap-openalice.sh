#!/usr/bin/env bash
# Shallow-clone OpenAlice vendor tree for STARGATE (doctrine + runtime reference).
# Vendor is gitignored — never commit the tree.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p vendor

if [[ ! -d vendor/openalice/.git ]]; then
  echo "→ Cloning OpenAlice (shallow)…"
  git clone --depth 1 https://github.com/TraderAlice/OpenAlice.git vendor/openalice
else
  echo "✓ OpenAlice present at vendor/openalice"
fi

echo "→ OpenAlice runtime (separate process, optional):"
echo "   cd vendor/openalice && pnpm install && pnpm dev"
echo "   Or: openalice server start vendor/openalice"
echo "→ Link openalice_base_url in Settings → LINK APIS (default http://127.0.0.1:47331)"
echo "→ STARGATE surfaces read-only intel; trade execution stays operator-gated."
echo "→ Done."
