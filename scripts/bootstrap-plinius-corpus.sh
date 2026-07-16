#!/usr/bin/env bash
# Shallow-clone elder-plinius defensive threat corpus into vendor/plinius/.
# Vendor is gitignored — never commit the tree. Threat intel only; not prompt fuel.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p vendor/plinius

REPOS=(
  G0DM0D3
  T3MP3ST
  L1B3RT4S
  OBLITERATUS
  ST3GG
  CL4R1T4S
)

for repo in "${REPOS[@]}"; do
  dest="vendor/plinius/${repo}"
  if [[ ! -d "${dest}/.git" ]]; then
    echo "→ Cloning elder-plinius/${repo} (shallow)…"
    git clone --depth 1 "https://github.com/elder-plinius/${repo}.git" "${dest}"
  else
    echo "✓ ${repo} present at ${dest}"
  fi
done

echo "→ Plinius corpus ready under vendor/plinius/ (gitignored)."
echo "→ Read docs/PLINIUS_CORPUS.md — defensive threat intel only."
echo "→ Done."
