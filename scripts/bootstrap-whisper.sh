#!/usr/bin/env bash
# Shallow-clone whisper.cpp, build it with make, and pull both quantized
# English models — STARGATE's local ears for the private call (no hosted
# STT, no network round-trip). Vendor is gitignored — never commit the tree.
# Pattern: scripts/bootstrap-private-gpt.sh. Idempotent: every step is
# skippable when already done, safe to re-run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

mkdir -p vendor data/models/whisper

# 1. Clone (shallow).
if [[ ! -d vendor/whisper.cpp/.git ]]; then
  echo "→ Cloning whisper.cpp (shallow)…"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git vendor/whisper.cpp
else
  echo "✓ whisper.cpp present at vendor/whisper.cpp"
fi

# 2. Build. whisper.cpp's top-level Makefile is a thin CMake wrapper —
# `make` == `cmake -B build && cmake --build build --config Release`
# (vendor/whisper.cpp Makefile:4-6). WHISPER_STANDALONE is ON for a
# top-level checkout (vendor/whisper.cpp CMakeLists.txt:25), which defaults
# WHISPER_BUILD_SERVER to ON too (CMakeLists.txt:82) — so the server example
# builds via plain `make`, no extra flags. Its only HTTP dependency,
# cpp-httplib, ships vendored as a header
# (vendor/whisper.cpp examples/server/httplib.h) — no external lib to
# install. Xcode CLT's clang (14.0.0) + cmake (already on PATH here) were
# sufficient — no new tool installs needed on macOS 12.
#
# NONSTANDARD, REQUIRED on this hardware: ggml's CMake defaults GGML_METAL=ON
# on every Apple target regardless of GPU (vendor/whisper.cpp
# ggml/CMakeLists.txt:95-96, "if (APPLE) set(GGML_METAL_DEFAULT ON)"). This
# machine's GPU (Intel i5-6267U integrated graphics, no Apple-Silicon/Metal3
# compute support) fails to initialize the Metal library at model-load time
# and the process aborts — verified live 2026-08-04: build/bin/whisper-server
# logged "ggml_metal_init: error: failed to initialize the Metal library" /
# "whisper_backend_init: using BLAS backend" and then hard-crashed inside
# ggml_backend_sched_alloc_graph because the scheduler still tried to place a
# tensor on the dead Metal device. Building with GGML_METAL=OFF forces
# pure-CPU (Apple Accelerate BLAS) and loads/runs cleanly. This is passed via
# CMAKE_ARGS, which the top-level Makefile forwards verbatim to the
# `cmake -B build` configure step (Makefile:4).
# Measured build time on this machine (Intel i5-6267U, 2 physical/4 logical
# cores, AVX2, 8GB RAM) — `make -j4` (full: lib + all examples + tests):
# 2m24s wall (130s user CPU) with GGML_METAL=OFF, verified 2026-08-04.
if [[ ! -x vendor/whisper.cpp/build/bin/whisper-server ]]; then
  echo "→ Building whisper.cpp (make -j$(sysctl -n hw.ncpu 2>/dev/null || echo 2), GGML_METAL=OFF)…"
  ( cd vendor/whisper.cpp && make CMAKE_ARGS="-DGGML_METAL=OFF" -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 2)" )
else
  echo "✓ whisper-server already built at vendor/whisper.cpp/build/bin/whisper-server"
fi

# 3. Models — BOTH tiny.en and base.en, quantized (q5_1). q5_1 is the only
# pre-built quantized variant offered for the .en (English-only) models; q8_0
# quantized files exist only for the multilingual tiny/base, not
# tiny.en/base.en (verified against the model list in vendor/whisper.cpp
# models/download-ggml-model.sh:36-53 — "tiny-q8_0" and "base-q8_0" are
# listed, "tiny.en-q8_0"/"base.en-q8_0" are not). Task 4 measures tiny.en vs
# base.en real-time factor on THIS machine and picks the default model from
# that — both are fetched here so that choice is made from real numbers, not
# a guess.
# Sizes (verified 2026-08-04, downloaded from huggingface.co/ggerganov/whisper.cpp):
#   ggml-tiny.en-q5_1.bin  32,166,155 bytes (~30.7 MiB)
#   ggml-base.en-q5_1.bin  59,721,011 bytes (~57.0 MiB)
# download-ggml-model.sh is itself idempotent (skips if the target .bin
# already exists — models/download-ggml-model.sh:115-117), so this loop is
# safe to re-run.
for m in tiny.en-q5_1 base.en-q5_1; do
  echo "→ Ensuring ggml-$m.bin is present in data/models/whisper/…"
  bash vendor/whisper.cpp/models/download-ggml-model.sh "$m" "$ROOT/data/models/whisper"
done

echo "→ Done. Start with: scripts/whisper-up.sh"
