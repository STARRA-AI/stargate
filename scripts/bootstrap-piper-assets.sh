#!/usr/bin/env bash
# LOCAL MOUTH ASSETS — everything Piper needs to speak on this Mac, fetched
# ONCE, served from the deck's own public/. After this runs, a private reply
# (and the PRIVATE CALL) can make sound with zero requests off the box.
#
# WHY THIS SCRIPT EXISTS. src/lib/voice/local-voice.ts REFUSES the library's
# CDN defaults by design (its header, and LOCAL_WASM_PATHS at local-voice.ts:
# 394-398) — @mintplex-labs/piper-tts-web would otherwise fetch
#   HF_BASE    https://huggingface.co/diffusionstudio/piper-voices/resolve/main
#   ONNX_BASE  https://cdnjs.cloudflare.com/ajax/libs/onnxruntime-web/1.18.0/
#   WASM_BASE  https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize
# (verified verbatim at node_modules/@mintplex-labs/piper-tts-web/dist/
# piper-tts-web.js:12-14, wired into DEFAULT_WASM_PATHS at :236-238) on EVERY
# sentence. Refusing them means MISSING ASSETS = SILENCE. This script is what
# turns that silence back into her voice, on loopback.
#
# Free only: two public files from HuggingFace + one npm package's build output
# from jsDelivr + a copy out of node_modules. No account, no key, no paid tier.
# Nothing here runs at deck runtime — this is a one-time, offline-able fetch.
#
# Pattern: scripts/bootstrap-whisper.sh. Idempotent — every step is skipped
# when its target is already present and non-empty, so re-running is safe.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# The voice to fetch. Defaults to the one the code picks (PIPER_VOICE_ID,
# src/lib/voice/piper-speak.ts). That default is `en_GB-cori-medium`, and the
# reason is measured, not theoretical: `high` synthesises at RTF 3.14/2.78 on
# this Intel Mac — three seconds of CPU per second of speech, which is a wait,
# not a voice — while `medium` runs 0.39/0.36, faster than real time, from the
# SAME speaker (.superpowers/sdd/p2-task-4-report.md §7).
#
# An ARGUMENT fetches an ADDITIONAL voice alongside the default rather than
# replacing it — local-voice.ts already ships the operator override this feeds
# (LOCAL_VOICE_KEY / NEXT_PUBLIC_STARRA_LOCAL_VOICE, local-voice.ts:337-371),
# so `high` stays one setting away:
#   bash scripts/bootstrap-piper-assets.sh en_GB-cori-high
VOICE_ID="${1:-en_GB-cori-medium}"
# The paths below are a CONTRACT with the code, not preferences: VOICE_DIR is
# PIPER_VOICE_BASE (src/lib/voice/piper-speak.ts:7) and the two wasm paths are
# LOCAL_WASM_PATHS (src/lib/voice/local-voice.ts:394-398). Move one and her
# voice goes silent — localAssetsAvailable() HEAD-checks these exact URLs.
VOICE_DIR="public/brand/voice"          # = PIPER_VOICE_BASE, served at /brand/voice
WASM_DIR="$VOICE_DIR/wasm"              # = LOCAL_WASM_PATHS piperWasm/piperData dir
ORT_DIR="$WASM_DIR/ort"                 # = LOCAL_WASM_PATHS.onnxWasm (a DIRECTORY)

mkdir -p "$ORT_DIR"

# Download to a temp name and rename only on success. A half-written file is
# exactly the failure local-voice.ts's seedComplete() was written against: a
# present-but-truncated asset PASSES a bare existence check and then sends the
# library to the CDN for the rest.
fetch() {
  local url="$1" dest="$2" label="$3"
  if [[ -s "$dest" ]]; then
    echo "✓ $label already present ($(wc -c <"$dest" | tr -d ' ') bytes)"
    return 0
  fi
  # BRACES REQUIRED, not style: the "…" that follows is multibyte UTF-8, and
  # this bash (5.x, macOS 12) folds those bytes INTO the parameter name —
  # `$label…` expanded as an unset `label…` and `set -u` killed the script.
  echo "→ Fetching ${label}…"
  curl -fL --retry 3 --retry-delay 2 -o "$dest.part" "$url"
  mv "$dest.part" "$dest"
  echo "✓ $label ($(wc -c <"$dest" | tr -d ' ') bytes)"
}

# 1. THE VOICE MODEL — Piper "Cori" (en_GB, quality tier per $VOICE_ID).
#
# Fetched from rhasspy/piper-voices, the UPSTREAM home of the Piper voices
# (the diffusionstudio repo the library hardcodes is a mirror of it). Layout is
# <lang>/<locale>/<name>/<quality>/<voiceId>.onnx — the same relative path the
# library's own PATH_MAP carries for this id:
#   "en_GB-cori-high": "en/en_GB/cori/high/en_GB-cori-high.onnx"
#   (dist/piper-tts-web.js:39)
# Verified live 2026-08-04: HTTP 200, content-length 114,219,352 for the .onnx
# and 4,963 for the .onnx.json.
#
# These two land side by side under public/brand/voice/ because that is where
# seedOpfs() reads them from before it copies them into OPFS under the exact
# names the library's getBlob() looks up (local-voice.ts:487-529). BOTH files
# are required: a seed with the .onnx but no .onnx.json is the half-seed that
# falls through to huggingface.co on a private turn (local-voice.ts:456-479).
HF_BASE="https://huggingface.co/rhasspy/piper-voices/resolve/main"
# rhasspy/piper-voices lays voices out as <lang>/<locale>/<name>/<quality>/,
# which is exactly what the library's own PATH_MAP carries — so the path is
# DERIVED from the id rather than hardcoded, and any id in PATH_MAP works.
#   en_GB-cori-high -> en / en_GB / cori / high
VOICE_LOCALE="${VOICE_ID%%-*}"                 # en_GB
VOICE_LANG="${VOICE_LOCALE%%_*}"               # en
VOICE_REST="${VOICE_ID#*-}"                    # cori-high
VOICE_NAME="${VOICE_REST%-*}"                  # cori
VOICE_QUALITY="${VOICE_REST##*-}"              # high
VOICE_PATH="$VOICE_LANG/$VOICE_LOCALE/$VOICE_NAME/$VOICE_QUALITY/$VOICE_ID"
fetch "$HF_BASE/$VOICE_PATH.onnx"      "$VOICE_DIR/$VOICE_ID.onnx"      "$VOICE_ID.onnx"
fetch "$HF_BASE/$VOICE_PATH.onnx.json" "$VOICE_DIR/$VOICE_ID.onnx.json" "$VOICE_ID.onnx.json"

# 2. THE PHONEMIZER — piper_phonemize.wasm + its espeak-ng data package.
#
# NOT shippable from node_modules: @mintplex-labs/piper-tts-web's own dist
# contains only JS (piper-tts-web.js, piper-o91UDS6e.js, voices_static-*.js,
# *.d.ts) — no .wasm and no .data. The Emscripten module inside
# dist/piper-o91UDS6e.js asks for them BY NAME at runtime
# ("piper_phonemize.data" at :23-24, wasmBinaryFile = "piper_phonemize.wasm"
# at :404) and routes both through the locateFile hook that TtsSession.predict
# points at #wasmPaths (dist/piper-tts-web.js:310-311). So they come from the
# package the library's own WASM_BASE names — @diffusionstudio/piper-wasm@1.0.0
# — pinned to that exact version, from jsDelivr's npm mirror. Same bytes the
# CDN default would have fetched; the only difference is that after this they
# are served by the deck instead of over the internet, per sentence.
PIPER_WASM_BASE="https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize"
fetch "$PIPER_WASM_BASE.wasm" "$WASM_DIR/piper_phonemize.wasm" "piper_phonemize.wasm"
fetch "$PIPER_WASM_BASE.data" "$WASM_DIR/piper_phonemize.data" "piper_phonemize.data"

# 3. THE ONNX RUNTIME — copied out of node_modules, not downloaded.
#
# onnxruntime-web is already a direct dependency of this repo (package.json:42,
# "onnxruntime-web": "^1.27.0"), so its wasm binaries are on disk already and
# the cdnjs 1.18.0 default is both remote AND a version mismatch.
#
# WHICH FILES, determined from the resolved entry point rather than guessed.
# TtsSession.init() does `await import("onnxruntime-web")` (dist/
# piper-tts-web.js:283); the package's "." export resolves the `import`
# condition to ./dist/ort.bundle.min.mjs (node_modules/onnxruntime-web/
# package.json exports). Grepping that bundle for the runtime filenames it can
# request yields exactly three: ort-wasm-simd-threaded.jsep.mjs,
# ort-wasm-simd-threaded.jsep.wasm, and ort-wasm-proxy-worker. The proxy worker
# is only reachable with env.wasm.proxy = true, which piper-tts-web never sets
# (it sets only allowLocalModels, numThreads and wasmPaths — dist:284-286), so
# the jsep pair is the whole runtime surface. They are copied under
# LOCAL_WASM_PATHS.onnxWasm, which onnxruntime treats as a DIRECTORY and joins
# a filename onto (local-voice.ts:388-398).
ORT_SRC="node_modules/onnxruntime-web/dist"
if [[ ! -d "$ORT_SRC" ]]; then
  echo "✗ $ORT_SRC missing — run: npm install" >&2
  exit 1
fi
for f in ort-wasm-simd-threaded.jsep.wasm ort-wasm-simd-threaded.jsep.mjs; do
  if [[ -s "$ORT_DIR/$f" ]]; then
    echo "✓ $f already copied ($(wc -c <"$ORT_DIR/$f" | tr -d ' ') bytes)"
  else
    if [[ ! -s "$ORT_SRC/$f" ]]; then
      echo "✗ $ORT_SRC/$f missing — onnxruntime-web layout changed; re-check the" >&2
      echo "  filenames referenced by dist/ort.bundle.min.mjs before editing this." >&2
      exit 1
    fi
    cp "$ORT_SRC/$f" "$ORT_DIR/$f"
    echo "✓ $f ($(wc -c <"$ORT_DIR/$f" | tr -d ' ') bytes)"
  fi
done

# 4. Verify the exact set localAssetsAvailable() HEAD-checks before it will let
# her speak (local-voice.ts:420-434) — plus the ort binary, which it cannot
# check by name because onnxruntime picks the filename itself.
echo
missing=0
for p in \
  "$VOICE_DIR/$VOICE_ID.onnx" \
  "$VOICE_DIR/$VOICE_ID.onnx.json" \
  "$WASM_DIR/piper_phonemize.wasm" \
  "$WASM_DIR/piper_phonemize.data" \
  "$ORT_DIR/ort-wasm-simd-threaded.jsep.wasm" \
  "$ORT_DIR/ort-wasm-simd-threaded.jsep.mjs" \
; do
  if [[ -s "$p" ]]; then
    printf '  ok   %10s  %s\n' "$(wc -c <"$p" | tr -d ' ')" "$p"
  else
    printf '  MISS %10s  %s\n' "-" "$p"
    missing=1
  fi
done
echo
if [[ $missing -ne 0 ]]; then
  echo "✗ Local voice is NOT ready — she will stay silent (by design, never a CDN fallback)." >&2
  exit 1
fi
echo "→ Done. Her local voice has everything it needs, served from /brand/voice."
