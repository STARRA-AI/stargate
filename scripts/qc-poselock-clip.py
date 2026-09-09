#!/usr/bin/env python3
"""
SEAM QC for a pose-locked clip — does she actually return to the anchor?

WHY THIS EXISTS. Clip switching was abandoned in this deck for one measured
reason (src/lib/voice/starra-clip-map.ts:88-96): two clips generated at
different moments never resume the same pose, so every switch is a visible cut.
StarraClipFace.tsx:1029-1038 measured it — gesture clips differ from base_loop
at rest by 14-29x the clip's own natural inter-frame motion.

Pose-locking removes that IF, and only if, the generator really honoured the
first/last frame constraint. A model can accept `last_image` and still drift.
This script is what decides, before a clip is allowed into the library.

THE CRITERION IS THE DECK'S OWN, not a new one (starra-clip-map.ts:99-105):

    "seam mean-abs-diff 2.025 = 1.64x the clip's MEDIAN inter-frame motion but
     only 0.52x its MAXIMUM natural inter-frame motion. The seam is smaller
     than motion that already happens naturally in the clip, so it is
     invisible."

So the bar is: seam < the clip's own MAX natural inter-frame motion. Being
above the median is fine and expected — the recorded base loop that shipped was
1.64x median.

Usage:
    python3 scripts/qc-poselock-clip.py CLIP.mp4 [--anchor ANCHOR.jpg] [--keep]

Exit code 0 = PASS (safe to loop / interchange), 1 = REGENERATE.
"""

from __future__ import annotations

import argparse
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path


def run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd[:3])}…\n{p.stderr.strip()[:400]}")
    return p.stdout


def probe(path: Path) -> dict[str, str]:
    out = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1", str(path),
    ])
    return dict(
        line.split("=", 1) for line in out.strip().splitlines() if "=" in line
    )


def extract(clip: Path, into: Path) -> list[Path]:
    """Every frame as greyscale PNG — greyscale so a colour-grade shift does
    not masquerade as motion."""
    run([
        "ffmpeg", "-v", "error", "-i", str(clip),
        "-vf", "format=gray", str(into / "f_%05d.png"),
    ])
    frames = sorted(into.glob("f_*.png"))
    if len(frames) < 3:
        sys.exit(f"only {len(frames)} frames decoded — not a usable clip")
    return frames


def mad(a: Path, b: Path) -> float:
    """Mean absolute difference between two same-size greyscale PNGs, 0..255.

    Uses ffmpeg's blend=difference + signalstats so there is no numpy/PIL
    dependency — this must run on a bare Intel Mac with nothing installed.
    """
    out = run([
        "ffmpeg", "-v", "error", "-i", str(a), "-i", str(b),
        "-filter_complex", "[0:v][1:v]blend=all_mode=difference,signalstats,"
                           "metadata=print:key=lavfi.signalstats.YAVG",
        "-f", "null", "-",
    ])
    # signalstats prints to stderr via metadata=print; ffmpeg routes it to
    # stdout under -f null on some builds. Handle both.
    for line in out.splitlines():
        if "YAVG" in line:
            return float(line.rsplit("=", 1)[1])
    return _mad_fallback(a, b)


def _mad_fallback(a: Path, b: Path) -> float:
    p = subprocess.run([
        "ffmpeg", "-v", "info", "-i", str(a), "-i", str(b),
        "-filter_complex", "[0:v][1:v]blend=all_mode=difference,signalstats,"
                           "metadata=print:key=lavfi.signalstats.YAVG",
        "-f", "null", "-",
    ], capture_output=True, text=True)
    for line in p.stderr.splitlines():
        if "YAVG" in line:
            return float(line.rsplit("=", 1)[1])
    sys.exit("could not read YAVG from ffmpeg — is this ffmpeg build missing signalstats?")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("clip", type=Path)
    ap.add_argument("--anchor", type=Path, default=None,
                    help="the still used as first AND last frame; checks she "
                         "STARTED where we said, not just that she returned")
    ap.add_argument("--keep", action="store_true", help="keep extracted frames")
    args = ap.parse_args()

    if not args.clip.exists():
        sys.exit(f"no such clip: {args.clip}")
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        sys.exit("ffmpeg/ffprobe not found on PATH")

    meta = probe(args.clip)
    print(f"clip      {args.clip.name}")
    print(f"          {meta.get('width')}x{meta.get('height')}  "
          f"{meta.get('r_frame_rate')}  {meta.get('nb_frames')} frames  "
          f"{float(meta.get('duration', 0)):.2f}s")

    tmp = Path(tempfile.mkdtemp(prefix="poselock-qc-"))
    try:
        frames = extract(args.clip, tmp)
        motion = [mad(frames[i], frames[i + 1]) for i in range(len(frames) - 1)]
        med = statistics.median(motion)
        mx = max(motion)
        seam = mad(frames[-1], frames[0])

        print(f"\nnatural inter-frame motion   median {med:.3f}   max {mx:.3f}")
        print(f"seam (last -> first frame)   {seam:.3f}")
        if med > 0:
            print(f"                             = {seam / med:.2f}x median, "
                  f"{seam / mx:.2f}x max")

        if args.anchor:
            if not args.anchor.exists():
                sys.exit(f"no such anchor: {args.anchor}")
            # Normalise the anchor to the clip's own geometry before comparing.
            norm = tmp / "anchor_gray.png"
            run(["ffmpeg", "-v", "error", "-i", str(args.anchor),
                 "-vf", f"scale={meta['width']}:{meta['height']},format=gray",
                 str(norm)])
            print(f"\nstart drift from anchor      {mad(frames[0], norm):.3f}")
            print(f"end   drift from anchor      {mad(frames[-1], norm):.3f}")

        # THE DECK'S OWN BAR: below the clip's MAXIMUM natural motion.
        ok = seam < mx
        verdict = (
            "PASS — seam is invisible against the clip's own motion"
            if ok
            else "REGENERATE — seam exceeds the clip's own max motion"
        )
        print(f"\n{verdict}")
        print("criterion: seam < max natural inter-frame motion "
              "(src/lib/voice/starra-clip-map.ts:99-105)")
        print("\nNOTE: this proves the SEAM and the ENDPOINTS. It does not "
              "prove she looks right — that still needs Classic's eyes.")
        return 0 if ok else 1
    finally:
        if args.keep:
            print(f"\nframes kept in {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
