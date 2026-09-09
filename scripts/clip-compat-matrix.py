#!/usr/bin/env python3
"""
CROSS-CLIP COMPATIBILITY — can these clips follow one another without a cut?

WHY THIS EXISTS. 20 generated clips sit unused in public/avatar/clips/ with zero
references anywhere in src/. They were abandoned for a measured reason
(StarraClipFace.tsx:1029-1038): every gesture clip's resting pose differs from
`base_loop` by 14-29x the clip's own natural inter-frame motion, so switching
shows a visible cut.

But that measurement compared everything against BASE_LOOP, which is a different
generation entirely (552x720, while most clips are 832x1248 — the exact size of
the ANGLE stills). The untested question is whether the clips match EACH OTHER.
If they share an anchor, they are mutually interchangeable and the fix is to stop
using base_loop as the hub — which would cost nothing at all.

This builds the matrix that answers it: every clip's FIRST and LAST frame against
every other clip's FIRST frame, in the deck's own units.

CRITERION (starra-clip-map.ts:99-105): a seam is invisible when it is below the
clip's MAX natural inter-frame motion.

Usage:
    python3 scripts/clip-compat-matrix.py DIR [--filter 832x1248] [--json OUT]
"""

from __future__ import annotations

import argparse
import json
import shutil
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path

SIG = 48


def run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"command failed: {' '.join(cmd[:4])}…\n{p.stderr.strip()[:300]}")
    return p.stdout


def probe(path: Path) -> tuple[int, int, int]:
    out = run(["ffprobe", "-v", "error", "-select_streams", "v:0",
               "-show_entries", "stream=width,height,nb_frames",
               "-of", "csv=p=0:nk=1", str(path)]).strip().split(",")
    return int(out[0]), int(out[1]), int(out[2] or 0)


def gray_frames(clip: Path, w: int, h: int) -> list[bytes]:
    """Every frame as a small greyscale signature, normalised to one size so
    clips of different resolutions remain comparable."""
    p = subprocess.run([
        "ffmpeg", "-v", "error", "-i", str(clip),
        "-vf", f"scale={SIG}:{SIG},format=gray",
        "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], capture_output=True)
    if p.returncode != 0:
        return []
    n = SIG * SIG
    return [p.stdout[i * n:(i + 1) * n] for i in range(len(p.stdout) // n)]


def mad(a: bytes, b: bytes) -> float:
    return sum(x - y if x > y else y - x for x, y in zip(a, b)) / len(a)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("dir", type=Path)
    ap.add_argument("--filter", default=None, help="only clips of this WxH")
    ap.add_argument("--json", type=Path, default=None)
    ap.add_argument("--extra", type=Path, nargs="*", default=[],
                    help="additional clips outside DIR to include")
    args = ap.parse_args()

    paths = sorted(args.dir.glob("*.mp4")) + [Path(p) for p in args.extra]
    clips = {}
    for p in paths:
        try:
            w, h, n = probe(p)
        except SystemExit:
            continue
        if args.filter and f"{w}x{h}" != args.filter:
            continue
        f = gray_frames(p, w, h)
        if len(f) < 3:
            continue
        motion = [mad(f[i], f[i + 1]) for i in range(len(f) - 1)]
        clips[p.name] = {
            "path": str(p), "wh": f"{w}x{h}", "frames": len(f),
            "first": f[0], "last": f[-1],
            "med": statistics.median(motion), "max": max(motion),
        }

    if len(clips) < 2:
        sys.exit("need at least 2 comparable clips")

    names = list(clips)
    # The shared bar: the largest natural motion any of these clips contains.
    bar = max(c["max"] for c in clips.values())
    print(f"{len(names)} clips" + (f" at {args.filter}" if args.filter else ""))
    print(f"criterion: a seam passes below the MAX natural motion in the set = {bar:.3f}\n")

    # Do all these clips START from the same pose? That is the anchor question.
    print("=== do they share an opening pose? (first-frame vs first-frame) ===")
    firsts = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            firsts.append((mad(clips[a]["first"], clips[b]["first"]), a, b))
    firsts.sort()
    same = [f for f in firsts if f[0] < bar]
    print(f"{len(same)} of {len(firsts)} first-frame pairs are within the bar")
    for d, a, b in firsts[:6]:
        print(f"  {d:7.3f}  {'PASS' if d < bar else '  no'}  {a}  ~  {b}")
    if len(firsts) > 6:
        print(f"  … worst: {firsts[-1][0]:7.3f}  {firsts[-1][1]} ~ {firsts[-1][2]}")

    # The switching question: can clip A's END be followed by clip B's START?
    print("\n=== can one clip follow another? (A last -> B first) ===")
    edges, per_clip = [], {n: 0 for n in names}
    for a in names:
        for b in names:
            if a == b:
                continue
            d = mad(clips[a]["last"], clips[b]["first"])
            edges.append((d, a, b))
            if d < bar:
                per_clip[a] += 1
    edges.sort()
    good = [e for e in edges if e[0] < bar]
    print(f"{len(good)} of {len(edges)} transitions pass\n")
    for d, a, b in edges[:10]:
        print(f"  {d:7.3f}  {d / bar:5.2f}x  {a:>22}  ->  {b}")

    print("\n=== how many onward transitions each clip has ===")
    for n in sorted(per_clip, key=lambda k: -per_clip[k]):
        c = clips[n]
        print(f"  {n:>22}  {per_clip[n]:3d} exits   ({c['frames']} frames, {c['wh']})")

    if args.json:
        args.json.write_text(json.dumps({
            "bar": bar,
            "clips": {n: {k: v for k, v in c.items() if k not in ("first", "last")}
                      for n, c in clips.items()},
            "transitions": [{"from": a, "to": b, "seam": d, "pass": d < bar}
                            for d, a, b in edges],
        }, indent=2))
        print(f"\nwrote {args.json}")

    print("\nNOTE: this proves SEAMS, not likeness. Classic's eyes decide whether "
          "she looks right in motion.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
