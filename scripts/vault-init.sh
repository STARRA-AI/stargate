#!/usr/bin/env bash
# Layer 1 — scaffold local Obsidian-style vault (PARA + CODE inbox).
# Writes under data/vault or STARGATE_VAULT_PATH. Never into git-tracked app paths.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VAULT="${STARGATE_VAULT_PATH:-$ROOT/data/vault}"

echo "→ Vault root: $VAULT"
mkdir -p "$VAULT"

for d in 0-Inbox 1-Projects 2-Areas 3-Resources 4-Archives Daily Canvas; do
  mkdir -p "$VAULT/$d"
done

if [[ ! -f "$VAULT/README.md" ]]; then
  cat > "$VAULT/README.md" <<'EOF'
# STARRA vault

Local long-term memory. Plain markdown. Exportable. Yours.

See docs/OBSIDIAN_MEMORY.md in the STARGATE repo.
EOF
  echo "→ Wrote README.md"
fi

if [[ ! -f "$VAULT/0-Inbox/Inbox.md" ]]; then
  cat > "$VAULT/0-Inbox/Inbox.md" <<'EOF'
---
tags: [inbox]
---

# Inbox

Capture here. Process into Projects / Areas / Resources.

Use [[wikilinks]] when linking related notes.
EOF
  echo "→ Wrote 0-Inbox/Inbox.md"
fi

echo "✓ Vault ready. Optional: open this folder in Obsidian."
echo "→ Backup: npm run vault:sync -- --init  (private GitHub repo only)"
