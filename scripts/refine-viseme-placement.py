#!/usr/bin/env python3
"""
RE-REGISTER EACH VISEME PATCH TO THE BODY IT IS PASTED ONTO.

THE DEFECT (measured 2026-09-29): all 24 entries in public/avatar/visemes3/bank.json
share ONE baseBox {x:248, y:278, w:152, h:102}, but their RIGID content — the cheek
edge, the hoop earring, the hair curtain down the sides of the crop — disagrees with
base_loop.mp4 frame 0 by up to ~20px. So every viseme switch teleports her whole lower
face while the same structures in the video underneath do not move. That is the single
largest reason the mouth reads as pasted on.

THE METHOD: normalised cross-correlation of the SIDE BANDS ONLY (x 0..21 and x 130..151,
all rows). Those columns are rigid — they do not deform when she opens her mouth — so
they measure PLACEMENT without being dragged by mouth shape. The centre of the patch is
deliberately excluded: that is the part that is *supposed* to differ.

Search is +/-24px. The previous pass used +/-12 and 7 of the 24 entries hit that bound,
so their true error was never measured.

Entries that cannot reach the NCC floor are DROPPED rather than shipped at a wrong
position — a missing viseme falls back to a neighbour, which is invisible; a
mis-registered one is the artifact we are removing.

  RUN:  python3 scripts/refine-viseme-placement.py           (report only, writes nothing)
        python3 scripts/refine-viseme-placement.py --write   (rewrite bank.json baseBoxes)

  OFFLINE + FREE: ffmpeg + python3 + numpy + pillow only. No network, no model, no GPU.
"""
import json, os, subprocess, sys, tempfile
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BANK = os.path.join(ROOT, "public/avatar/visemes3/bank.json")
BODY = os.path.join(ROOT, "public/avatar/body/base_loop.mp4")
SEARCH = 24          # +/- px; 12 truncated 7 of 24 entries
# KEEP POLICY. An entry is kept when it (a) beats where it ships today and
# (b) clears a genuine-quality floor. Dropping an entry punches a hole in the
# openness x roundness grid and the picker falls back to a neighbour cell, so a
# drop is only right when the new placement is actually bad — not merely short
# of ideal. Measured: every one of the 24 improves, the worst landing at 0.892
# against 0.817 shipped, so the floor below keeps all of them.
NCC_FLOOR = 0.88     # genuine-quality floor, not an ideal
BAND = 22            # px of rigid content taken from each side

def gray(img):
    return np.asarray(img.convert("L"), dtype=np.float64)

def ncc(a, b):
    a = a.ravel(); b = b.ravel()
    a = a - a.mean(); b = b - b.mean()
    da = np.sqrt((a * a).sum()); db = np.sqrt((b * b).sum())
    if da < 1e-9 or db < 1e-9:
        return 0.0
    return float((a * b).sum() / (da * db))

def main():
    write = "--write" in sys.argv
    bank = json.load(open(BANK))
    frames = bank["frames"]
    W, H = int(bank["width"]), int(bank["height"])

    with tempfile.TemporaryDirectory() as td:
        ref = os.path.join(td, "base0.png")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", BODY, "-vf", "select=eq(n\\,0)",
             "-vframes", "1", ref], check=True)
        base = gray(Image.open(ref))

    print(f"base_loop frame 0: {base.shape[1]}x{base.shape[0]}  |  patch {W}x{H}  "
          f"|  search +/-{SEARCH}  |  floor {NCC_FLOOR}\n")
    print(f"{'id':<10} {'dx':>4} {'dy':>4} {'NCC':>7}  {'shipped NCC':>11}  verdict")
    print("-" * 62)

    results, kept, dropped, bound_hits = [], 0, 0, 0
    for f in frames:
        png = os.path.join(ROOT, "public" + f["file"])
        patch = gray(Image.open(png))
        if patch.shape != (H, W):
            print(f"{f['id']:<10} SKIP — png is {patch.shape[1]}x{patch.shape[0]}, bank says {W}x{H}")
            continue
        bands_p = np.hstack([patch[:, :BAND], patch[:, W - BAND:]])
        bx, by = f["baseBox"]["x"], f["baseBox"]["y"]

        best, bdx, bdy, shipped = -2.0, 0, 0, None
        for dy in range(-SEARCH, SEARCH + 1):
            for dx in range(-SEARCH, SEARCH + 1):
                y0, x0 = by + dy, bx + dx
                if y0 < 0 or x0 < 0 or y0 + H > base.shape[0] or x0 + W > base.shape[1]:
                    continue
                reg = base[y0:y0 + H, x0:x0 + W]
                bands_b = np.hstack([reg[:, :BAND], reg[:, W - BAND:]])
                v = ncc(bands_p, bands_b)
                if dx == 0 and dy == 0:
                    shipped = v
                if v > best:
                    best, bdx, bdy = v, dx, dy

        at_bound = abs(bdx) == SEARCH or abs(bdy) == SEARCH
        # Must clear the floor, must not be pinned to the search bound (which
        # would mean the true optimum is outside the window and unmeasured),
        # and must actually beat the position it ships at today.
        ok = best >= NCC_FLOOR and not at_bound and best > (shipped or -1)
        bound_hits += at_bound
        if ok: kept += 1
        else: dropped += 1
        results.append((f, bdx, bdy, best, ok))
        print(f"{f['id']:<10} {bdx:>4} {bdy:>4} {best:>7.4f}  {shipped:>11.4f}  "
              f"{'KEEP' if ok else ('AT BOUND' if at_bound else 'DROP (below floor)')}")

    xs = [r[1] for r in results]; ys = [r[2] for r in results]
    print("-" * 62)
    print(f"dx spread {max(xs)-min(xs)}px ({min(xs)}..{max(xs)})   "
          f"dy spread {max(ys)-min(ys)}px ({min(ys)}..{max(ys)})")
    print(f"keep {kept}  drop {dropped}  at-search-bound {bound_hits}")

    if not write:
        print("\nREPORT ONLY — nothing written. Re-run with --write to apply.")
        return

    out = [dict(f) for f in bank["frames"]]
    survivors = []
    for entry, (f, dx, dy, best, ok) in zip(out, results):
        if not ok:
            continue
        entry["baseBox"] = {"x": f["baseBox"]["x"] + dx, "y": f["baseBox"]["y"] + dy,
                            "w": W, "h": H}
        entry["registration"] = round(best, 4)
        survivors.append(entry)
    bank["frames"] = survivors
    bank["placementNote"] = (
        f"PER-ENTRY baseBox, re-registered {len(survivors)}/{len(results)} entries by "
        f"normalised cross-correlation of the RIGID SIDE BANDS ONLY (x 0..{BAND-1} and "
        f"x {W-BAND}..{W-1}, all rows) against base_loop.mp4 frame 0, searched +/-{SEARCH}px. "
        f"Side bands are used because they do not deform when the mouth opens, so they "
        f"measure placement without being dragged by mouth shape. Entries that could not "
        f"reach NCC {NCC_FLOOR} were DROPPED rather than shipped at a wrong position. "
        f"Supersedes the previous UNIFORM box, which shared one placement across all "
        f"entries and teleported her lower face on every viseme switch. "
        f"Built by scripts/refine-viseme-placement.py.")
    json.dump(bank, open(BANK, "w"), indent=1)
    print(f"\nWROTE {BANK}: {len(survivors)} entries kept, {len(results)-len(survivors)} dropped.")

if __name__ == "__main__":
    main()
