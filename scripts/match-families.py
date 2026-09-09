#!/usr/bin/env python3
"""
FAMILY MATCHING — can the 832x1248 clip set be made to cut cleanly against
base_loop?

THE PROBLEM. public/avatar/clips/ holds 11 clips at 832x1248 that are mutually
pose-locked (measured: every transition seam 1.6-2.4, against the 2.025 seam
base_loop already ships and that was judged invisible). They are a free,
working animation library.

But base_loop.mp4 — the clip the deck actually plays, and the one the mouth
patch is calibrated against — is 552x720 from a DIFFERENT generation. Cutting
between the two families measures ~26, which is a hard visible cut.

THE QUESTION THIS ANSWERS. Is that 26 a POSE difference (unfixable without
regenerating) or a FRAMING + COLOUR GRADE difference (fixable offline, free)?
The two look identical in wardrobe and pose to the eye, which points at grade.

METHOD. Search crop+scale of the 832x1248 frame for the framing that best
matches base_loop, then solve a per-channel linear grade (gain/offset) on top.
Report the residual. If the residual lands near the family's own internal seams,
the families can be reconciled with an offline ffmpeg bake and no generation.
"""
from __future__ import annotations
import subprocess, sys, tempfile, shutil, statistics
from pathlib import Path

W, H = 69, 90          # working signature size, base_loop aspect 552x720
def run(c): 
    p = subprocess.run(c, capture_output=True)
    if p.returncode: sys.exit(p.stderr.decode()[:300])
    return p.stdout

def sig(path, vf):
    return run(["ffmpeg","-v","error","-i",str(path),"-vf",f"{vf},scale={W}:{H},format=gray",
                "-f","rawvideo","-pix_fmt","gray","-frames:v","1","-"])

def mad(a,b): return sum(abs(x-y) for x,y in zip(a,b))/len(a)

def main():
    base = Path("public/avatar/body/base_loop.mp4")
    other = Path(sys.argv[1] if len(sys.argv)>1 else "public/avatar/clips/talking.mp4")
    ref = sig(base, "select=eq(n\\,0)")
    print(f"reference : {base.name} frame 0")
    print(f"candidate : {other.name} frame 0\n")

    raw = sig(other, "select=eq(n\\,0)")
    print(f"no transform            MAD {mad(ref,raw):7.3f}")

    # coarse crop search: base_loop is a tighter view; find it inside 832x1248
    SW, SH = 832, 1248
    best = None
    for cw in range(420, 833, 34):
        ch = int(cw * 720/552)
        if ch > SH: continue
        for cx in range(0, SW-cw+1, max(1,(SW-cw)//6 or 1)):
            for cy in range(0, min(SH-ch, 500)+1, max(1,(min(SH-ch,500))//6 or 1)):
                s = sig(other, f"select=eq(n\\,0),crop={cw}:{ch}:{cx}:{cy}")
                d = mad(ref, s)
                if best is None or d < best[0]:
                    best = (d, cw, ch, cx, cy, s)
    d, cw, ch, cx, cy, s = best
    print(f"best crop {cw}x{ch}+{cx}+{cy}   MAD {d:7.3f}")

    # solve a linear grade  y = a*x + b  by least squares on the matched pixels
    n = len(s)
    mx = sum(s)/n; my = sum(ref)/n
    vxx = sum((p-mx)**2 for p in s)/n
    vxy = sum((p-mx)*(q-my) for p,q in zip(s,ref))/n
    a = vxy/vxx if vxx else 1.0
    b = my - a*mx
    graded = [min(255,max(0,round(a*p+b))) for p in s]
    dg = mad(ref, graded)
    print(f"+ linear grade gain={a:.3f} offset={b:+.1f}   MAD {dg:7.3f}")

    print(f"\nfor reference, the family's own internal seams measure 1.6-2.4,")
    print(f"and base_loop's own shipped/invisible loop seam is 2.025.")
    if dg < 6:
        print("\n=> the gap is mostly FRAMING + GRADE. An offline bake can reconcile them.")
    else:
        print("\n=> residual too high: this is a genuine POSE/identity difference,")
        print("   not something a crop and a colour curve can fix.")
    print(f"\nffmpeg: crop={cw}:{ch}:{cx}:{cy},scale=552:720,eq=contrast={a:.3f}:brightness={b/255:.3f}")

main()
