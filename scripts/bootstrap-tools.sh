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

if [[ ! -d vendor/multica/.git ]]; then
  echo "→ Cloning Multica (shallow)…"
  git clone --depth 1 https://github.com/multica-ai/multica.git vendor/multica
else
  echo "✓ Multica present"
fi

if [[ ! -d vendor/openalice/.git ]]; then
  echo "→ Cloning OpenAlice (shallow)…"
  git clone --depth 1 https://github.com/TraderAlice/OpenAlice.git vendor/openalice
else
  echo "✓ OpenAlice present"
fi

if [[ ! -d vendor/obsidian-skills/.git ]]; then
  echo "→ Cloning kepano/obsidian-skills (shallow, optional reference)…"
  git clone --depth 1 https://github.com/kepano/obsidian-skills.git vendor/obsidian-skills || echo "⚠ obsidian-skills clone skipped"
else
  echo "✓ obsidian-skills present"
fi

echo "→ Distilling prompt structure patterns…"
node scripts/distill-prompt-patterns.mjs

echo "→ Done. OpenMontage (canonical video; Higgsfield retired):"
echo "   npm run tools:montage-setup   # venv + remotion"
echo "   Tools → OpenMontage → Queue brief → AGENT_GUIDE.md to render"
echo "→ Multica: link multica_token in Settings · optional CLI: brew install multica-ai/tap/multica"
echo "→ OpenAlice: cd vendor/openalice && pnpm install && pnpm dev · link openalice_base_url if needed"
