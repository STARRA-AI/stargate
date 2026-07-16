#!/usr/bin/env bash
# Shallow-clone kepano/obsidian-skills for STARRA reference (gitignored).
# Not a runtime dependency — grammar is adapted into docs/OBSIDIAN_MEMORY.md.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p vendor

if [[ ! -d vendor/obsidian-skills/.git ]]; then
  echo "→ Cloning kepano/obsidian-skills (shallow)…"
  git clone --depth 1 https://github.com/kepano/obsidian-skills.git vendor/obsidian-skills
else
  echo "✓ obsidian-skills present at vendor/obsidian-skills"
fi

echo "→ Reference only. STARRA doctrine: docs/OBSIDIAN_MEMORY.md"
echo "→ Done."
