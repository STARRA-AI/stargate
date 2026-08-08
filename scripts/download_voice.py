#!/usr/bin/env python3
"""Download Piper voice models into public/brand/voice/ for STARRA TTS.

Cori en_GB is the STARRA voice (Book 1 §7 — one consistent voice). The tier
fetched here is `medium`, which is what the code picks by default
(PIPER_VOICE_ID, src/lib/voice/piper-speak.ts) — same speaker as `high`, but
measured at RTF 0.39 vs 3.14 on this Intel Mac, i.e. faster than real time
instead of three seconds of CPU per second of speech
(.superpowers/sdd/p2-task-4-report.md §7).

`high` is not fetched here and is not gone — one command away when wanted:
    bash scripts/bootstrap-piper-assets.sh en_GB-cori-high
then point the deck at it with `stargate.localVoice` in localStorage or
NEXT_PUBLIC_STARRA_LOCAL_VOICE (src/lib/voice/local-voice.ts:337-371).

Jenny files are kept when present for rollback.
"""

from __future__ import annotations

import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = REPO_ROOT / "public" / "brand" / "voice"

# Cori en_GB medium — primary STARRA voice, = PIPER_VOICE_ID
CORI_BASES = [
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/medium/",
    "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/cori/medium/",
    "https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_GB/cori/medium/",
]
CORI_FILES = [
    "en_GB-cori-medium.onnx",
    "en_GB-cori-medium.onnx.json",
]

# Jenny en_GB medium — legacy rollback (STARRA_BRAIN.md)
JENNY_BASES = [
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/jenny_dioco/medium/",
    "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_GB/jenny_dioco/medium/",
    "https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_GB/jenny_dioco/medium/",
]
JENNY_FILES = [
    "en_GB-jenny_dioco-medium.onnx",
    "en_GB-jenny_dioco-medium.onnx.json",
]


def download_file(url: str, dest: Path, retries: int = 3) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  skip (exists): {dest.name}")
        return
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            print(f"  fetch ({attempt}/{retries}): {url}")
            req = urllib.request.Request(
                url, headers={"User-Agent": "stargate-voice/1.0"}
            )
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = resp.read()
            # `dest.name`, not a bare `name`: this function has no `name` in
            # scope (the loop variable lives in download_set), so the old spelling
            # raised NameError on EVERY fetch, burned all three retries, and
            # reported it as a download failure. dest is OUT_DIR / name, so
            # dest.name is that same file name.
            if dest.name.endswith(".json"):
                text = data.decode("utf-8", errors="replace").lstrip()
                if not text.startswith("{"):
                    raise ValueError("response is not JSON (HF gateway error?)")
            elif dest.name.endswith(".onnx") and len(data) < 100_000:
                raise ValueError(f"onnx too small ({len(data)} bytes) — likely error page")
            dest.write_bytes(data)
            print(f"  wrote: {dest} ({len(data):,} bytes)")
            return
        except Exception as e:
            last_err = e
            print(f"  attempt {attempt} failed: {e}")
    raise last_err  # type: ignore[misc]


def download_set(label: str, bases: list[str], files: list[str]) -> bool:
    print(f"\n[{label}]")
    for name in files:
        dest = OUT_DIR / name
        last_err: Exception | None = None
        for base in bases:
            url = base + name
            try:
                download_file(url, dest)
                last_err = None
                break
            except urllib.error.HTTPError as e:
                last_err = e
                if e.code in (404, 502, 503, 504):
                    print(f"  {e.code} at {url}, trying next base…")
                    continue
                raise
            except Exception as e:
                last_err = e
                print(f"  error at {url}: {e}")
        if last_err and not dest.exists():
            print(f"  FAILED: {name} — {last_err}", file=sys.stderr)
            return False
    return True


def main() -> int:
    print(f"Voice output: {OUT_DIR}")
    ok_cori = download_set("Cori en_GB medium", CORI_BASES, CORI_FILES)
    ok_jenny = download_set("Jenny en_GB medium (rollback)", JENNY_BASES, JENNY_FILES)
    if not ok_cori:
        print("\nCori download failed. Check network or HuggingFace availability.", file=sys.stderr)
        return 1
    if not ok_jenny:
        print("\nJenny rollback skipped (optional). Cori is ready.", file=sys.stderr)
    print("\nDone. Restart dev server if running; Piper loads on next speak.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
