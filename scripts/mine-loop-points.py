#!/usr/bin/env python3
"""
SEAM MINING — find the loop points that already exist inside a take.

WHY THIS EXISTS. Pose-locking (same anchor as first AND last frame) is the clean
way to make clips interchangeable, but both Vidu start/end models fail upstream
(`taskUUID` error, 2026-08-22), and no other model on the catalogue accepts an
end frame. So the fallback is the codebase's own prescription:

    StarraClipFace.tsx:1029-1038 — "The fix is not code — it is FOOTAGE
    GENERATED AS ONE CONTINUOUS TAKE that already contains the gestures."

    starra-clip-map.ts:99-105 — base_loop.mp4 was itself found by "an
    exhaustive seam search" inside a single take.

Frames from ONE take share a moment, wardrobe and lighting, so two frames that
LOOK alike genuinely are compatible — no generation needed. This script finds
those pairs.

TWO STAGES, because there is no numpy on this machine:
  1. a cheap 32x32 greyscale signature per frame screens all pairs in memory;
  2. the top candidates are then measured EXACTLY with the same ffmpeg
     blend=difference + signalstats used by qc-poselock-clip.py, so the number
     reported is comparable to the deck's own recorded figures.

THE CRITERION IS THE DECK'S OWN (starra-clip-map.ts:99-105): a seam is invisible
when it is smaller than motion the clip already contains naturally, i.e.
seam < MAX natural inter-frame motion.

Usage:
    python3 scripts/mine-loop-points.py TAKE.mp4 [--min-seconds 1.5] [--top 8]
                                        [--cut OUTDIR]
"""

from __future__ import annotations

import argparse
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

SIG = 32  # signature edge length; 32x32 = 1024 bytes/frame


def run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd[:4])}…\n{p.stderr.strip()[:400]}")
    return p.stdout


def probe(path: Path) -> dict[str, str]:
    out = run([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1", str(path),
    ])
    return dict(l.split("=", 1) for l in out.strip().splitlines() if "=" in l)


def fps_of(meta: dict[str, str]) -> float:
    r = meta.get("r_frame_rate", "24/1")
    n, _, d = r.partition("/")
    return float(n) / float(d or 1)


def signatures(clip: Path) -> list[bytes]:
    """One tiny greyscale thumbnail per frame, as raw bytes, via a single
    ffmpeg pass. Greyscale so a colour-grade shift cannot masquerade as motion."""
    p = subprocess.run([
        "ffmpeg", "-v", "error", "-i", str(clip),
        "-vf", f"scale={SIG}:{SIG},format=gray",
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], capture_output=True)
    if p.returncode != 0:
        sys.exit(f"ffmpeg failed reading {clip.name}: {p.stderr.decode()[:300]}")
    buf, n = p.stdout, SIG * SIG
    return [buf[i * n:(i + 1) * n] for i in range(len(buf) // n)]


def sig_mad(a: bytes, b: bytes) -> float:
    return sum(x - y if x > y else y - x for x, y in zip(a, b)) / len(a)


def extract_pair(clip: Path, i: int, j: int, into: Path) -> tuple[Path, Path]:
    """Two exact full-resolution frames, greyscale PNG, for precise measurement."""
    out = []
    for idx, tag in ((i, "a"), (j, "b")):
        f = into / f"{tag}_{idx:05d}.png"
        # ffmpeg 9 removed -vsync; -fps_mode passthrough is the replacement.
        run(["ffmpeg", "-v", "error", "-i", str(clip),
             "-vf", f"select=eq(n\\,{idx}),format=gray", "-fps_mode", "passthrough",
             "-frames:v", "1", "-y", str(f)])
        out.append(f)
    return out[0], out[1]


def exact_mad(a: Path, b: Path) -> float:
    p = subprocess.run([
        "ffmpeg", "-v", "info", "-i", str(a), "-i", str(b),
        "-filter_complex", "[0:v][1:v]blend=all_mode=difference,signalstats,"
                           "metadata=print:key=lavfi.signalstats.YAVG",
        "-f", "null", "-",
    ], capture_output=True, text=True)
    for stream in (p.stdout, p.stderr):
        for line in stream.splitlines():
            if "YAVG" in line:
                return float(line.rsplit("=", 1)[1])
    sys.exit("could not read YAVG — ffmpeg build missing signalstats?")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("take", type=Path)
    ap.add_argument("--min-seconds", type=float, default=1.5,
                    help="shortest loop worth having")
    ap.add_argument("--top", type=int, default=8, help="candidates to verify exactly")
    ap.add_argument("--cut", type=Path, default=None,
                    help="write the best passing segment as an mp4 into this dir")
    args = ap.parse_args()

    if not args.take.exists():
        sys.exit(f"no such take: {args.take}")
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not on PATH")

    meta = probe(args.take)
    fps = fps_of(meta)
    sigs = signatures(args.take)
    if len(sigs) < 8:
        sys.exit(f"only {len(sigs)} frames — not a usable take")

    print(f"take      {args.take.name}")
    print(f"          {meta.get('width')}x{meta.get('height')}  {fps:g}fps  "
          f"{len(sigs)} frames  {float(meta.get('duration', 0)):.2f}s")

    # The bar, from the clip's own natural motion — measured on signatures for
    # ranking, then re-measured exactly on the winners.
    natural = [sig_mad(sigs[i], sigs[i + 1]) for i in range(len(sigs) - 1)]
    nat_med, nat_max = statistics.median(natural), max(natural)
    print(f"\nsignature motion   median {nat_med:.3f}   max {nat_max:.3f}")

    min_len = max(2, int(args.min_seconds * fps))
    pairs = []
    for i in range(len(sigs)):
        for j in range(i + min_len, len(sigs)):
            pairs.append((sig_mad(sigs[i], sigs[j]), i, j))
    if not pairs:
        sys.exit(f"no pair at least {min_len} frames apart — take is too short")
    pairs.sort()
    print(f"screened {len(pairs)} pairs at least {min_len} frames "
          f"({args.min_seconds:g}s) apart\n")

    # Keep candidates spread out rather than 8 variants of the same seam.
    chosen, seen = [], set()
    for score, i, j in pairs:
        key = (i // 4, j // 4)
        if key in seen:
            continue
        seen.add(key)
        chosen.append((score, i, j))
        if len(chosen) >= args.top:
            break

    tmp = Path(tempfile.mkdtemp(prefix="seam-mine-"))
    results = []
    try:
        # Exact natural motion, so the verdict uses the same units as the deck.
        a, b = extract_pair(args.take, 0, 1, tmp)
        exact_natural = [exact_mad(a, b)]
        for k in range(1, min(len(sigs) - 1, 40)):
            a, b = extract_pair(args.take, k, k + 1, tmp)
            exact_natural.append(exact_mad(a, b))
        ex_med, ex_max = statistics.median(exact_natural), max(exact_natural)
        print(f"exact natural motion   median {ex_med:.3f}   max {ex_max:.3f}")
        print(f"criterion: a seam passes when it is below {ex_max:.3f}\n")

        print(f"{'frames':>13}  {'seconds':>14}  {'seam':>8}  {'xmax':>6}  verdict")
        for score, i, j in chosen:
            fa, fb = extract_pair(args.take, j, i, tmp)  # j loops back to i
            seam = exact_mad(fa, fb)
            ok = seam < ex_max
            results.append((seam, i, j, ok))
            print(f"{i:5d} -> {j:<5d}  {i / fps:5.2f}s -> {j / fps:5.2f}s  "
                  f"{seam:8.3f}  {seam / ex_max:5.2f}x  "
                  f"{'PASS' if ok else 'no'}")

        passing = [r for r in results if r[3]]
        print()
        if not passing:
            best = min(results)[0]
            print(f"NO usable loop inside this take (best seam {best:.3f} = "
                  f"{best / ex_max:.2f}x max).")
            print("Generate a longer take, or one that returns toward its opening pose.")
            return 1

        seam, i, j, _ = min(passing)
        dur = (j - i) / fps
        print(f"BEST LOOP  frames {i}->{j}  ({dur:.2f}s)  seam {seam:.3f} = "
              f"{seam / ex_max:.2f}x max natural motion")

        if args.cut:
            args.cut.mkdir(parents=True, exist_ok=True)
            out = args.cut / f"{args.take.stem}_loop_{i}_{j}.mp4"
            run(["ffmpeg", "-v", "error", "-i", str(args.take),
                 "-vf", f"select=between(n\\,{i}\\,{j}),setpts=N/{fps}/TB",
                 "-an", "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p",
                 "-y", str(out)])
            print(f"wrote {out}")

        print("\nNOTE: this proves the SEAM. It does not prove she looks right "
              "in motion — that still needs Classic's eyes.")
        return 0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
