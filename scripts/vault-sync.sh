#!/usr/bin/env bash
# Layer 3 — Backup / sync guidance for the Obsidian vault.
# Operates ONLY on the vault directory. Never pushes to the STARGATE app remote.
# Pattern: Obsidian Git Plugin → private GitHub repo (recommended) or this CLI helper.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VAULT="${STARGATE_VAULT_PATH:-$ROOT/data/vault}"

if [[ ! -d "$VAULT" ]]; then
  echo "Vault missing at $VAULT"
  echo "Run: npm run vault:init"
  exit 1
fi

# Refuse if someone pointed STARGATE_VAULT_PATH at the app repo
ABS_VAULT="$(cd "$VAULT" && pwd)"
ABS_ROOT="$(cd "$ROOT" && pwd)"
if [[ "$ABS_VAULT" == "$ABS_ROOT" ]]; then
  echo "Refusing: vault path is the STARGATE app root. Use data/vault or a separate folder."
  exit 1
fi

INIT=0
COMMIT=0
for arg in "$@"; do
  case "$arg" in
    --init) INIT=1 ;;
    --commit) COMMIT=1 ;;
  esac
done

cd "$ABS_VAULT"

if [[ "$INIT" -eq 1 ]]; then
  if [[ -d .git ]]; then
    echo "✓ Vault already has .git"
  else
    git init -b main
    echo "→ Initialized git in vault"
  fi

  if [[ ! -f .gitignore ]]; then
    cat > .gitignore <<'EOF'
.obsidian/workspace*
.obsidian/workspaces.json
.trash/
.DS_Store
EOF
    echo "→ Wrote vault .gitignore"
  fi

  echo ""
  echo "Next (private backup only):"
  echo "  1. Create a PRIVATE GitHub repo (e.g. starra-vault-private)."
  echo "  2. cd \"$ABS_VAULT\""
  echo "  3. git remote add origin git@github.com:YOU/starra-vault-private.git"
  echo "  4. git add -A && git commit -m 'vault: initial' && git push -u origin main"
  echo "  5. Or install Obsidian Git Plugin and enable auto-commit / pull."
  echo ""
  echo "Do NOT add this remote to the STARGATE app repository."
  exit 0
fi

if [[ ! -d .git ]]; then
  echo "Vault has no .git yet. Run: npm run vault:sync -- --init"
  exit 1
fi

echo "→ Vault: $ABS_VAULT"
git status -sb || true

if [[ "$COMMIT" -eq 1 ]]; then
  if git diff --quiet && git diff --cached --quiet; then
    echo "✓ Nothing to commit"
  else
    git add -A
    git commit -m "vault: sync $(date -u +%Y-%m-%dT%H%MZ)"
    echo "✓ Local commit created. Push when ready: git push (vault remote only)"
  fi
else
  echo ""
  echo "Guidance:"
  echo "  npm run vault:sync -- --commit   # local commit inside vault"
  echo "  git push                         # to your PRIVATE vault remote"
  echo "  Or use Obsidian Git Plugin for scheduled auto-commit/pull."
fi
