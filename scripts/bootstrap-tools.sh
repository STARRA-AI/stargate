#!/usr/bin/env bash
# Bootstrap optional vendor tooling for STARGATE.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p vendor docs/reference data/packs

if [[ ! -d vendor/OpenMontage/.git ]]; then
  echo "→ Cloning OpenMontage (shallow)…"
  git clone --depth 1 https://github.com/calesthio/OpenMontage.git vendor/OpenMontage
else
  echo "✓ OpenMontage present"
fi

if [[ ! -d docs/reference/system_prompts_leaks/.git ]]; then
  echo "→ Cloning system_prompts_leaks (shallow)…"
  git clone --depth 1 https://github.com/asgeirtj/system_prompts_leaks.git docs/reference/system_prompts_leaks
else
  echo "✓ system_prompts_leaks present"
fi

echo "→ Distilling prompt structure patterns…"
node scripts/distill-prompt-patterns.mjs

echo "→ Done. Next for OpenMontage (optional heavy install):"
echo "   cd vendor/OpenMontage && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt"
echo "   cd remotion-composer && npm install"
