#!/usr/bin/env python3
"""
measure_mouth_alignment.py — measures WHERE the v4 mouth patch actually lands on
base_loop.mp4, frame by frame, against the anatomy measured in the footage itself.

  RUN:  python3 scripts/measure_mouth_alignment.py            (report)
        python3 scripts/measure_mouth_alignment.py --json X   (also dump per-frame JSON)

$0, OFFLINE: ffmpeg + python3 + numpy + cv2 only. READ-ONLY — writes nothing into
public/. No pixel of her face is synthesised; this file only MEASURES.

WHAT IT REPLICATES (the shipped placement math, from source):
  src/lib/voice/viseme-sync.ts
    patchPlacement (lines 1190-1192):
        drawX = Math.floor((canvasW - w) / 2); drawY = Math.floor((canvasH - h) / 2);
        return { drawX, drawY, originX: x - drawX, originY: y - drawY };
    baseBoxAt (lines 1021-1031): box.x + BASE_DRIFT_X[i], box.y + BASE_DRIFT_Y[i]
    bankPatchExtent: canvas = ceil(max baseBox w) x ceil(max baseBox h)
  src/components/bridge/StarraClipFace.tsx
    V4_PATCH_MASK (lines 163-166): radial-gradient ellipse, semi-axes
        MASK_RX_FRAC * canvasW x MASK_RY_FRAC * canvasH, centred in the canvas
        (at 50% MASK_CY_PCT%), alpha 1.0 out to the solid stop then a smoothstep
        feather to 0 at 100% of the radius.
The drift tables and mask string are PARSED OUT OF THE SHIPPED SOURCE (no copy that
can rot), so this script always measures the code that actually runs.

WHAT IT MEASURES IN THE FOOTAGE (per frame, all 266):
  NOSE BASELINE — the bottom of her nose (alar base / nostril bottoms): the lowest
    row of the dark nostril mass inside a nose window above the mouth box. Nostrils
    are the darkest structure there (luminance method, precedent:
    scripts/build-anatomy-assets.py's differential-band measurements and
    build-viseme-bank-3.py's luminance interior test).
  LIP BOX + CORNERS — the Lab a* chroma lip mask (the EXACT method shipped in
    scripts/build-viseme-bank-3.py lip_mask(): lips are redder than skin; threshold
    a* at skin-percentile + 0.26 * (p98 - p45)), largest central component.

THE QUESTION IT ANSWERS: for every bank entry on every frame, where does the patch's
visible top edge sit relative to the measured nose baseline, and do the lips stay
inside the solid part of the mask? Overlap > 0 = the patch is cutting into her nose.
"""
import json
import os
import re
import subprocess
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.join(ROOT, "public/avatar/body/base_loop.mp4")
BANK = os.path.join(ROOT, "public/avatar/visemes3/bank.json")
SYNC_TS = os.path.join(ROOT, "src/lib/voice/viseme-sync.ts")
FACE_TSX = os.path.join(ROOT, "src/components/bridge/StarraClipFace.tsx")

JSON_OUT = None
if "--json" in sys.argv:
    JSON_OUT = sys.argv[sys.argv.index("--json") + 1]


# ── parse the SHIPPED constants out of the source (never a stale copy) ────────
def parse_drift(src: str, name: str) -> list[int]:
    m = re.search(name + r"\s*:\s*readonly number\[\]\s*=\s*\[([^\]]*)\]", src, re.S)
    if not m:
        sys.exit(f"cannot find {name} in viseme-sync.ts")
    return [int(v) for v in re.findall(r"-?\d+", m.group(1))]


def parse_mask(src: str) -> dict:
    """V4_PATCH_MASK: 'ellipse 46% 42% at 50% 50%', solid to 66%, feather stops."""
    m = re.search(
        r"V4_PATCH_MASK\s*=\s*((?:\"[^\"]*\"\s*\+?\s*)+)", src, re.S)
    if not m:
        sys.exit("cannot find V4_PATCH_MASK in StarraClipFace.tsx")
    s = "".join(re.findall(r'"([^"]*)"', m.group(1)))
    g = re.search(r"ellipse\s+([\d.]+)%\s+([\d.]+)%\s+at\s+([\d.]+)%\s+([\d.]+)%", s)
    stops = re.findall(r"rgba\(0,0,0,([\d.]+)\)\s+([\d.]+)%", s)
    if not g or not stops:
        sys.exit(f"cannot parse V4_PATCH_MASK gradient: {s}")
    return dict(
        rx=float(g.group(1)) / 100.0, ry=float(g.group(2)) / 100.0,
        cx=float(g.group(3)) / 100.0, cy=float(g.group(4)) / 100.0,
        stops=[(float(a), float(p) / 100.0) for a, p in stops], css=s)


def mask_alpha_at_t(t: float, stops) -> float:
    """Alpha of the gradient at radius fraction t (piecewise-linear CSS stops)."""
    if t <= stops[0][1]:
        return stops[0][0]
    for (a0, p0), (a1, p1) in zip(stops, stops[1:]):
        if t <= p1:
            f = (t - p0) / (p1 - p0) if p1 > p0 else 1.0
            return a0 + (a1 - a0) * f
    return stops[-1][0]


def t_at_alpha(alpha: float, stops) -> float:
    """Radius fraction where the gradient falls to `alpha` (stops are decreasing)."""
    for (a0, p0), (a1, p1) in zip(stops, stops[1:]):
        if a1 <= alpha <= a0:
            f = (a0 - alpha) / (a0 - a1) if a0 > a1 else 0.0
            return p0 + (p1 - p0) * f
    return stops[-1][1]


with open(SYNC_TS) as fh:
    sync_src = fh.read()
with open(FACE_TSX) as fh:
    face_src = fh.read()
DRIFT_X = parse_drift(sync_src, "BASE_DRIFT_X")
DRIFT_Y = parse_drift(sync_src, "BASE_DRIFT_Y")
MASK = parse_mask(face_src)
bank = json.load(open(BANK))
frames_meta = bank["frames"]
CANVAS_W = int(np.ceil(max(f["baseBox"]["w"] for f in frames_meta)))
CANVAS_H = int(np.ceil(max(f["baseBox"]["h"] for f in frames_meta)))

print(f"shipped mask: {MASK['css']}")
print(f"  ellipse semi-axes {MASK['rx']:.2f}w x {MASK['ry']:.2f}h at "
      f"({MASK['cx']:.2f}, {MASK['cy']:.2f}) of the {CANVAS_W}x{CANVAS_H} canvas; "
      f"solid to {MASK['stops'][0][1]*100:.0f}% of radius")
print(f"drift table: {len(DRIFT_X)} frames, dx {min(DRIFT_X)}..{max(DRIFT_X)}, "
      f"dy {min(DRIFT_Y)}..{max(DRIFT_Y)}")


# ── decode base_loop sequentially (no seeks — precedent build-viseme-bank-3.py) ─
def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,nb_frames", "-of", "default=nw=1:nk=0", path],
        capture_output=True, check=True).stdout.decode()
    d = dict(l.split("=", 1) for l in out.strip().splitlines())
    return int(d["width"]), int(d["height"]), int(d["nb_frames"])


W, H, NB = probe(BASE)
raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", BASE, "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
    capture_output=True, check=True).stdout
N = len(raw) // (W * H * 3)
FR = np.frombuffer(raw, np.uint8).reshape(N, H, W, 3)
print(f"\nbase_loop: {W}x{H}, {N} frames decoded")
assert N == len(DRIFT_X) == len(DRIFT_Y), "frame count vs drift table mismatch"


# ── per-frame anatomy ─────────────────────────────────────────────────────────
# The mouth region every baseBox agrees on (x 211..213, y 205..222, w<=131, h<=93).
#
# WINDOWS ARE DRIFT-COMPENSATED: her head travels up to 17px vertically across the
# loop (the shipped BASE_DRIFT_Y), so a fixed window that isolates the nostrils on
# frame 0 lands on her lips by frame 41. Each window rides driftY, and the OUTPUT
# is validated below: (nose[i] - driftY[i]) must be near-constant, which holds only
# if BOTH the drift table AND this detector are tracking the same rigid head.
#
# Frame-0 luminance profile (measured, this script's own probe): nostril dark mass
# y 222..239 (min luminance 7 at y=234), BRIGHT philtrum band y 240..249 (p05
# ~87-110), lip vermilion darkens from y 250. The windows sit on those structures.
# ★ RE-CENTRED 2026-09-22 for the InfiniteTalk base loop. The new base is cut at a
# 9% larger face scale with her nose 22px right of the old spot (cut-idle-base.py
# --k 0.80: nose lands at 295.6,213.5 vs the shipped 273.5,213.5) and the uniform
# baseBox moved with her to (234,248,131,78). With the OLD windows the lip box's
# right edge pinned at 343 = MX1-1 on every entry — the window was clipping her
# lips, not measuring them. All x windows shift +22; the lip ROI top follows the
# box top (248) and the nostril band is unchanged in y (baseline measured 241..247).
MX0, MX1 = 215, 384          # union of baseBox x-extents (216..382; box grew to 167x96 for the wider InfiniteTalk mouth)
NOSE_X0, NOSE_X1 = 257, 347  # central band: nostrils, excluding cheek shadows
NOSE_Y0, NOSE_Y1 = 208, 248  # frame-0 coords; rides driftY per frame


def nose_baseline(img, dy: int) -> float:
    """Lowest row of the dark nostril mass. Luminance method: nostrils are the
    darkest structure in the window (measured 0.06-0.3x the local median);
    threshold at 0.52x median, keep components of real nostril size. The window
    bottom sits in the BRIGHT philtrum band, so lip pixels cannot contaminate."""
    y0, y1 = NOSE_Y0 + dy, NOSE_Y1 + dy
    win = img[y0:y1, NOSE_X0:NOSE_X1]
    g = cv2.cvtColor(win, cv2.COLOR_BGR2GRAY).astype(np.float32)
    med = float(np.median(g))
    dark = (g < 0.52 * med).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    n, lbl, st, cent = cv2.connectedComponentsWithStats(dark, 8)
    bottom = None
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] < 12:
            continue
        b = st[i, cv2.CC_STAT_TOP] + st[i, cv2.CC_STAT_HEIGHT]
        bottom = b if bottom is None else max(bottom, b)
    if bottom is None:
        return float("nan")
    return float(y0 + bottom)


A_COEF = 0.26  # the shipped lip-chroma coefficient, build-viseme-bank-3.py:159


def lip_box(img, dy: int):
    """Lip bbox + corners via the SHIPPED Lab a* chroma method
    (build-viseme-bank-3.py lip_mask), on the mouth region of the base frame.
    The ROI top starts in the bright philtrum band (above the vermilion, below
    the nostril shadows) and rides driftY like the nose window."""
    y0, y1, x0, x1 = 248 + dy, 344 + dy, MX0, MX1   # box top 248, box bottom 344 (167x96 box)
    roi = img[y0:y1, x0:x1]
    lab = cv2.cvtColor(roi, cv2.COLOR_BGR2LAB).astype(np.float32)
    A = lab[:, :, 1]
    a_skin, a_hi = np.percentile(A, 45), np.percentile(A, 98)
    thr = a_skin + A_COEF * max(a_hi - a_skin, 1.0)
    lip = (A > thr).astype(np.uint8)
    lip = cv2.morphologyEx(lip, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    lip = cv2.morphologyEx(lip, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lbl, st, cent = cv2.connectedComponentsWithStats(lip, 8)
    ccx = (x1 - x0) / 2.0
    best, area = None, 0
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] > area and abs(cent[i][0] - ccx) < 45:
            best, area = i, st[i, cv2.CC_STAT_AREA]
    if best is None or area < 300:
        return None
    m = lbl == best
    ys, xs = np.nonzero(m)
    return dict(x0=float(x0 + xs.min()), x1=float(x0 + xs.max()),
                y0=float(y0 + ys.min()), y1=float(y0 + ys.max()))


nose = np.array([nose_baseline(FR[i], DRIFT_Y[i]) for i in range(N)])
lips = [lip_box(FR[i], DRIFT_Y[i]) for i in range(N)]
ok_lips = [l for l in lips if l]
print(f"\nNOSE BASELINE (footage): min {np.nanmin(nose):.0f} median "
      f"{np.nanmedian(nose):.0f} max {np.nanmax(nose):.0f}  (NaN frames: "
      f"{int(np.isnan(nose).sum())})")
rel = nose - np.array(DRIFT_Y, float)
print(f"  drift-relative (nose[i] - driftY[i]): min {np.nanmin(rel):.0f} median "
      f"{np.nanmedian(rel):.0f} max {np.nanmax(rel):.0f}  "
      f"(spread {np.nanmax(rel)-np.nanmin(rel):.0f}px — rigid-motion check)")
lt = np.array([l["y0"] for l in ok_lips])
lb = np.array([l["y1"] for l in ok_lips])
ll = np.array([l["x0"] for l in ok_lips])
lr = np.array([l["x1"] for l in ok_lips])
print(f"LIPS (footage, {len(ok_lips)}/{N} frames measured): top {lt.min():.0f}.."
      f"{lt.max():.0f}  bottom {lb.min():.0f}..{lb.max():.0f}  left {ll.min():.0f}.."
      f"{ll.max():.0f}  right {lr.min():.0f}..{lr.max():.0f}")


# ── the shipped placement, per entry per frame ────────────────────────────────
def placement(box):
    draw_x = (CANVAS_W - box["w"]) // 2      # Math.floor for positive values
    draw_y = (CANVAS_H - box["h"]) // 2
    return draw_x, draw_y, box["x"] - draw_x, box["y"] - draw_y


T_SOLID = MASK["stops"][0][1]      # alpha = 1.0 out to this radius fraction
T_HALF = t_at_alpha(0.5, MASK["stops"])
T_VIS = t_at_alpha(0.05, MASK["stops"])  # below 5% alpha nothing reads on screen

report = []
print(f"\nPER-ENTRY worst case over all {N} frames "
      f"(positive overlap = patch intrudes ABOVE the nose baseline):")
print(f"{'id':9s} {'boxTop':>7s} {'solidTop':>8s} {'halfTop':>8s} {'visTop':>7s} "
      f"{'ovl.solid':>9s} {'ovl.half':>8s} {'ovl.vis':>8s} {'ovl.raw':>8s} {'frames>0(half)':>14s}")
for e in frames_meta:
    bb = e["baseBox"]
    dx0, dy0, ox0, oy0 = placement(bb)
    ecx = ox0 + MASK["cx"] * CANVAS_W
    ecy = oy0 + MASK["cy"] * CANVAS_H
    ry = MASK["ry"] * CANVAS_H
    o_solid = np.zeros(N)
    o_half = np.zeros(N)
    o_vis = np.zeros(N)
    o_raw = np.zeros(N)
    tops = np.zeros((N, 4))
    for i in range(N):
        dy = DRIFT_Y[i]
        base = nose[i]
        if np.isnan(base):
            continue
        # visible top edges on this frame, in base_loop pixels. The patch rect
        # clips the ellipse: nothing above originY + drawY (the PNG's own top).
        png_top = bb["y"] + dy
        top_solid = max(ecy + dy - T_SOLID * ry, png_top)
        top_half = max(ecy + dy - T_HALF * ry, png_top)
        top_vis = max(ecy + dy - T_VIS * ry, png_top)
        tops[i] = (png_top, top_solid, top_half, top_vis)
        o_raw[i] = base - png_top
        o_solid[i] = base - top_solid
        o_half[i] = base - top_half
        o_vis[i] = base - top_vis
    n_half = int((o_half > 0).sum())
    report.append(dict(id=e["id"], boxTop=bb["y"],
                       worstSolid=float(o_solid.max()), worstHalf=float(o_half.max()),
                       worstVis=float(o_vis.max()), worstRaw=float(o_raw.max()),
                       framesOverHalf=n_half))
    print(f"{e['id']:9s} {bb['y']:7d} {tops[:,1].min():8.1f} {tops[:,2].min():8.1f} "
          f"{tops[:,3].min():7.1f} {o_solid.max():9.1f} {o_half.max():8.1f} "
          f"{o_vis.max():8.1f} {o_raw.max():8.1f} {n_half:11d}/{N}")

# ── lip coverage: do the lips stay inside the SOLID part of the mask? ─────────
print("\nLIP COVERAGE (solid-alpha ellipse must contain the measured lip box):")
for e in frames_meta:
    bb = e["baseBox"]
    dx0, dy0, ox0, oy0 = placement(bb)
    ecx = ox0 + MASK["cx"] * CANVAS_W
    ecy = oy0 + MASK["cy"] * CANVAS_H
    rx = MASK["rx"] * CANVAS_W
    ry = MASK["ry"] * CANVAS_H
    worst_t = 0.0
    worst_i = -1
    for i in range(N):
        l = lips[i]
        if not l:
            continue
        dy, dx = DRIFT_Y[i], DRIFT_X[i]
        # the four extreme lip points, in mask-radius fractions
        for px, py in ((l["x0"], (l["y0"]+l["y1"])/2), (l["x1"], (l["y0"]+l["y1"])/2),
                       ((l["x0"]+l["x1"])/2, l["y0"]), ((l["x0"]+l["x1"])/2, l["y1"])):
            t = np.hypot((px - (ecx + dx)) / rx, (py - (ecy + dy)) / ry)
            if t > worst_t:
                worst_t, worst_i = float(t), i
    a = mask_alpha_at_t(worst_t, MASK["stops"])
    print(f"  {e['id']:9s} worst lip-extreme at t={worst_t:.3f} of radius "
          f"(alpha {a:.3f}) on frame {worst_i}  "
          f"{'INSIDE SOLID' if worst_t <= T_SOLID else 'IN FEATHER' if worst_t < 1 else 'OUTSIDE MASK'}")

if JSON_OUT:
    with open(JSON_OUT, "w") as fh:
        json.dump(dict(canvas=[CANVAS_W, CANVAS_H], mask=MASK,
                       noseBaseline=[None if np.isnan(v) else float(v) for v in nose],
                       driftY=DRIFT_Y, lips=lips, entries=report), fh, indent=1)
    print(f"\nwrote {JSON_OUT}")
