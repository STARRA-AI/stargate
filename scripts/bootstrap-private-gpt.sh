#!/usr/bin/env bash
# Shallow-clone the private-gpt vendor reference, install its runtime, and pull
# the embedding model — for STARGATE's private lane (Ollama-only, no hosted
# endpoint). Vendor is gitignored — never commit the tree.
# Pattern: scripts/bootstrap-multica.sh. Idempotent: every step is skippable
# when already done, safe to re-run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

UV="${UV:-$HOME/.local/bin/uv}"

mkdir -p vendor

# 1. Clone (shallow).
if [[ ! -d vendor/private-gpt/.git ]]; then
  echo "→ Cloning private-gpt (shallow)…"
  git clone --depth 1 https://github.com/zylon-ai/private-gpt.git vendor/private-gpt
else
  echo "✓ private-gpt present at vendor/private-gpt"
fi

# 2. Runtime install — prebuilt wheels, Python 3.11 managed by uv (NOT the
# system Python 3.14, NOT brew — this Mac's system Python is too new for
# private-gpt, which requires 3.11: vendor/private-gpt
# fern/docs/pages/installation/package.mdx:52).
# Base command verbatim from vendor/private-gpt
# fern/docs/pages/installation/package.mdx:33-36 (also
# fern/docs/pages/getting-started/quickstart.mdx:21-24).
#
# macOS 12 landmine: private-gpt[core] pulls in markitdown[pdf] -> pdfplumber
# -> pypdfium2, and the latest pypdfium2 (5.12.1) ships no prebuilt wheel for
# this OS/arch — uv builds one from sdist tagged macosx_13_0_x86_64, which is
# newer than this machine's macOS 12.7.6 and uv correctly refuses to install
# ("not compatible with the current Python 3.11 on macOS x86_64"). Verified
# live 2026-08-04: pypdfium2==5.8.0 IS published with a compatible prebuilt
# wheel and satisfies pdfplumber 0.11.9's dependency range, so it is pinned
# via --with. Not a vendor doc line (this is an environment-compatibility
# fix, not a documented requirement) — remove the pin if a future pypdfium2
# release ships a macOS-12-compatible wheel again.
if command -v private-gpt >/dev/null 2>&1; then
  echo "✓ private-gpt CLI already installed ($(command -v private-gpt))"
else
  echo "→ Installing private-gpt[core] via uv (Python 3.11, prebuilt wheels)…"
  "$UV" tool install --python 3.11 \
    --find-links https://wheels.privategpt.dev/packages/ \
    --with "pypdfium2==5.8.0" \
    "private-gpt[core]"
fi

# 3. Embedding model — nomic-embed-text (~274MB): fits the 8GB RAM constraint.
# Vendor docs place no restriction on which Ollama embedding model is used
# ("Any model from the Ollama library works" — vendor/private-gpt
# fern/docs/pages/providers/ollama.mdx:54), so the smaller model is used
# rather than the doc's example mxbai-embed-large (~670MB). The vector store's
# embed_dim is auto-probed from whichever model is actually pulled
# (vendor/private-gpt private_gpt/components/vector_store/vector_store_component.py:53-67),
# so no dimension is hardcoded here.
ollama_models="$(ollama list 2>/dev/null || true)"
# Captured to a variable, not piped straight into grep -q: under `set -o
# pipefail`, grep -q exits as soon as it finds a match, SIGPIPEing `ollama
# list` before it finishes writing — pipefail then reports that SIGPIPE as
# the pipeline's exit status and the (still-correct) match is missed.
if grep -q '^nomic-embed-text' <<<"$ollama_models"; then
  echo "✓ nomic-embed-text already pulled"
else
  echo "→ Pulling nomic-embed-text (Ollama)…"
  ollama pull nomic-embed-text
fi

echo "→ Done. Start with: scripts/private-gpt-up.sh"
