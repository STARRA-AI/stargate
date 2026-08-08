#!/usr/bin/env python3
"""
build-viseme-bank-2d.py — builds the 2-D viseme bank (bank2.json + w*.png).

  RUN IT WITH:  python3 scripts/build-viseme-bank-2d.py
  (from the repo root: ~/STARGATE/stargate)

  Optional flags:
    --dry-run     measure and report coverage, write NOTHING
    --out <dir>   output dir (default public/avatar/visemes)

$0, OFFLINE, NO GPU, NO NEW DEPENDENCY: ffmpeg + python3 + numpy + cv2, all of
which are already installed on this machine. Nothing is downloaded. Her source
footage is opened READ-ONLY and is never written to. NO PIXEL OF HER FACE IS
EVER SYNTHESISED — every bank entry is a straight ffmpeg crop of a real frame of
public/avatar/clips/talking.mp4 at native resolution.

WHY THIS EXISTS ALONGSIDE build-viseme-bank.mjs
The .mjs builder still runs and still produces the 1-D bank.json that the
runtime falls back to. It is NOT the producer of the 2-D bank: this file is.
The reason is that the 2-D measurement needs Lab-space lip segmentation and
connected components, which cv2 provides and which a hand-rolled JS port could
not be validated to the same standard inside this task. Provenance is recorded
in bank2.json's `builder` field so there is no ambiguity about what made it.

── WHAT WENT WRONG WITH THE SHIPPED 1-D BANK (measured, in the report) ─────────
Rendering the 8 shipped PNGs as a labelled ladder (scratchpad/
shipped_bank_ladder.png) shows SIX of the eight are visibly CLOSED mouths,
including v04 (openness 0.563, source frame 103) and v05 (openness 0.688, source
frame 225). So the shipped openness scale is not monotonic in aperture, and at
openness 0.5 the runtime draws a shut mouth.

The cause is measurable: her openness distribution is BIMODAL. Of 354 frames,
295 sit below openness 0.2 and 54 above 0.7, with only 5 frames in the whole
0.2-0.7 middle. The .mjs builder forces 8 EVENLY SPACED openness bands onto that
two-state footage, so its middle bands can only be filled with closed frames
carrying invented mid-range openness labels.

This builder does not invent rungs. It measures each frame, picks the nearest
REAL frame per requested cell, records that frame's TRUE measured values, and
FLAGS any cell with no real frame nearby as an approximation.

── HOW THE TWO AXES ARE MEASURED ──────────────────────────────────────────────
OPENNESS — a linear discriminant over the zero-meaned, unit-normed gray lip ROI,
  between HAND-VERIFIED closed and open exemplars read off contact sheets of all
  354 frames. Exemplars are hand-picked rather than bootstrapped because that is
  the single input that decided the shipped bank's failure. Appearance-based, so
  it survives the lighting that defeats every photometric threshold on this clip:
  her mouth cavity is a mid-tone red-brown and her lips are glossy-bright, so a
  dark-pixel "aperture" finds her nasolabial shadow instead of her mouth. That
  reproduces the rejection of luma metrics already documented in
  build-viseme-bank.mjs:44-51, and was re-confirmed here.

ROUNDNESS — from MEASURED MOUTH WIDTH, corner to corner. The lip mask is Lab a*
  (redness) above her own per-frame skin level, with a background gate, because
  the ROI slides off her cheek into the dark set behind her on many frames.
  Width is then the widest per-ROW run of lip pixels CONNECTED THROUGH the mouth
  centre column. That connectivity rule is load-bearing: a naive horizontal
  extent read 91-93px on frames 164/166/170 purely from a disconnected cheek
  blob, while her lips there were no wider than on the 57px narrowest frames.
  Verified by eye in scratchpad/width_extremes2.png.
  corr(width, openness) = +0.151 on this clip, so the second axis is genuinely
  carrying information the first one does not.
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIP = os.path.join(ROOT, "public/avatar/clips/talking.mp4")
ANCHOR = os.path.join(ROOT, "public/avatar/visemes/anchor.json")

DRY = "--dry-run" in sys.argv


def arg(name, dflt):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else dflt


OUT_DIR = os.path.abspath(os.path.join(ROOT, arg("--out", "public/avatar/visemes")))

# ── safety: never escape the repo, never write into her source footage ────────
if not OUT_DIR.startswith(ROOT + os.sep):
    sys.exit(f"refusing: --out must stay inside the repo (got {OUT_DIR})")
if "public/avatar/clips" in OUT_DIR.replace("\\", "/"):
    sys.exit("refusing: --out must never point into public/avatar/clips (read-only footage)")
for p in (CLIP, ANCHOR):
    if not os.path.exists(p):
        sys.exit(f"refusing: required input not found: {p}")

# ── decode region: covers every anchor box (x 294..555, y 359..532) + margin ──
RX, RY, RW, RH = 240, 310, 380, 270
MW, MH = 220, 180                      # measurement ROI, concentric with the box
CXC, CYC = MW // 2, MH // 2
WX0, WX1, WY0, WY1 = 40, 180, 30, 150  # excludes cheek/nostril speckle
A_COEF = 0.26                          # redness coefficient (threshold sweep)
LW, LH = 130, 92                       # gray ROI for the discriminant

# HAND-VERIFIED exemplars, all from HIGH pose-confidence stretches.
# Read off scratchpad/sheet0.png + sheet1.png (all 354 frames eyeballed):
#   frames  50-296  lips CLOSED (the clear majority of the clip)
#   frames 297-326  WIDE OPEN, rounded/oval cavity
#   frames 327-353  open with TEETH, wider lips
#   frames   6- 20  slightly open, teeth, lips WIDEST — but inside the
#                   low-pose-confidence run 7-20, so not used as an exemplar
CLOSED_EX = list(range(58, 78)) + list(range(180, 200)) + list(range(228, 246))
OPEN_EX = list(range(302, 326))

POSE_FLOOR = 0.93                      # matches viseme-sync POSE_CONFIDENCE_FLOOR

# Requested grid. Rungs are REQUESTS, not promises — each cell records the
# nearest real frame's TRUE measurements plus how far off the request it was.
OPEN_RUNGS = [0.00, 0.15, 0.35, 0.55, 0.75, 0.95]
ROUND_COLS = [("spread", 0.10), ("neutral", 0.50), ("rounded", 0.90)]
# A cell further than this from its request in the 2-D plane is an APPROXIMATION.
APPROX_TOL = 0.14


def probe():
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate,nb_frames", "-of",
         "default=noprint_wrappers=1:nokey=0", CLIP],
        capture_output=True, check=True).stdout.decode()
    d = dict(l.split("=", 1) for l in out.strip().splitlines())
    num, den = (d.get("r_frame_rate", "30/1").split("/") + ["1"])[:2]
    return (int(d["width"]), int(d["height"]), float(num) / float(den),
            int(d.get("nb_frames") or 0))


VW, VH, FPS, NB = probe()
print(f"source public/avatar/clips/talking.mp4  {VW}x{VH} @ {FPS}fps  nb_frames={NB}")

boxes = json.load(open(ANCHOR))["frames"]
raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-i", CLIP, "-vf", f"crop={RW}:{RH}:{RX}:{RY}",
     "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
    capture_output=True, check=True).stdout
N = min(len(raw) // (RW * RH * 3), len(boxes))
if N < 8:
    sys.exit("refusing: decoded too few frames to build a bank")
vid = np.frombuffer(raw, np.uint8)[: (len(raw) // (RW * RH * 3)) * RW * RH * 3] \
    .reshape(-1, RH, RW, 3)
print(f"decoded {N} frames of the {RW}x{RH} region; anchor track has {len(boxes)}")


def roi(f):
    b = boxes[f]
    cx, cy = b["x"] + b["w"] // 2 - RX, b["y"] + b["h"] // 2 - RY
    x0 = int(np.clip(cx - MW // 2, 0, RW - MW))
    y0 = int(np.clip(cy - MH // 2, 0, RH - MH))
    return vid[f, y0:y0 + MH, x0:x0 + MW]


def lip_mask(img):
    """Lab a* redness above her own skin level, background-gated."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    L, A = lab[:, :, 0], lab[:, :, 1]
    skinL = float(np.median(L[CYC - 55:CYC - 35, CXC - 30:CXC + 30]))
    if skinL <= 1:
        return np.zeros(L.shape, np.uint8)
    valid = L > 0.45 * skinL                       # gate the dark set behind her
    if valid.sum() < 3000:
        valid = np.ones_like(L, bool)
    av = A[valid]
    a_skin, a_hi = np.percentile(av, 45), np.percentile(av, 98)
    lip = ((A > a_skin + A_COEF * max(a_hi - a_skin, 1.0)) & valid).astype(np.uint8)
    lip = cv2.morphologyEx(lip, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    lip = cv2.morphologyEx(lip, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    win = np.zeros_like(lip)
    win[WY0:WY1, WX0:WX1] = 1
    lip *= win
    n, lbl, st, cent = cv2.connectedComponentsWithStats(lip, 8)
    keep = np.zeros_like(lip)
    for i in range(1, n):
        # the two lips are stacked and share a centre column; a 34px vertical
        # allowance DROPPED the lower lip on the wide-open frames (upper centroid
        # y=63, lower y=113 on frame 320), which is exactly where it matters.
        if st[i, cv2.CC_STAT_AREA] >= 120 and abs(cent[i][0] - CXC) < 46 \
           and abs(cent[i][1] - CYC) < 58:
            keep |= (lbl == i).astype(np.uint8)
    return keep


def mouth_width(lip):
    """Widest per-ROW lip run CONNECTED THROUGH the mouth centre column."""
    ys, xs = np.nonzero(lip)
    if len(xs) < 100:
        return 0.0
    cx = int(round(np.median(xs)))
    best = 0
    for y in range(lip.shape[0]):
        row = lip[y]
        if not row.any():
            continue
        if row[cx]:
            c0 = cx
        else:
            near = [c for c in range(max(cx - 6, 0), min(cx + 7, lip.shape[1])) if row[c]]
            if not near:
                continue
            c0 = near[len(near) // 2]
        l = c0
        while l > 0 and row[l - 1]:
            l -= 1
        r = c0
        while r < lip.shape[1] - 1 and row[r + 1]:
            r += 1
        best = max(best, r - l)
    return float(best)


# ── measure every frame ───────────────────────────────────────────────────────
gray = np.zeros((N, LH * LW))
width = np.zeros(N)
for f in range(N):
    img = roi(f)
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float64)
    v = g[CYC - LH // 2:CYC - LH // 2 + LH, CXC - LW // 2:CXC - LW // 2 + LW].ravel().copy()
    v -= v.mean()
    nrm = np.linalg.norm(v)
    gray[f] = v / (nrm if nrm > 1e-9 else 1.0)
    width[f] = mouth_width(lip_mask(img))

cex = [f for f in CLOSED_EX if f < N]
oex = [f for f in OPEN_EX if f < N]
w = gray[oex].mean(0) - gray[cex].mean(0)
w /= np.linalg.norm(w) or 1.0
proj = gray @ w
# Scale on the exemplar class MEANS, never on global min/max: one outlier frame
# must not be able to compress the whole usable range (that is how a bimodal
# clip ends up with six closed mouths spread across a fake 0.08..0.69 ladder).
lo, hi = proj[cex].mean(), proj[oex].mean()
openness = np.clip((proj - lo) / (hi - lo if abs(hi - lo) > 1e-9 else 1.0), 0.0, 1.0)

conf = np.array([boxes[f].get("confidence", 1.0) for f in range(N)], float)
ok = conf >= POSE_FLOOR
wlo = float(np.percentile(width[ok], 3))
whi = float(np.percentile(width[ok], 97))
roundness = np.clip((whi - width) / (whi - wlo if whi > wlo else 1.0), 0.0, 1.0)

sep = (proj[oex].mean() - proj[cex].mean()) / max(proj[cex].std(), 1e-9)
print(f"\nopenness discriminant: closed={proj[cex].mean():+.4f}(sd {proj[cex].std():.4f}) "
      f"open={proj[oex].mean():+.4f}(sd {proj[oex].std():.4f})  separation={sep:.1f} sd")
print(f"mouth width: {width[ok].min():.0f}..{width[ok].max():.0f}px at pose>={POSE_FLOOR} "
      f"(roundness maps {whi:.0f}px->0.0 spread, {wlo:.0f}px->1.0 rounded)")
print(f"corr(width, openness) = {np.corrcoef(width, openness)[0,1]:+.3f}  "
      f"(low => the axes are independent)")

print("\nopenness coverage of HER footage (this is the honest constraint):")
for a, b in [(0.0, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.01)]:
    i = np.nonzero((openness >= a) & (openness < b))[0]
    j = np.nonzero((openness >= a) & (openness < b) & ok)[0]
    print(f"  openness {a:.1f}-{b:.1f}: {len(i):3d} frames ({len(j):3d} at pose>={POSE_FLOOR})")

# ── pick one real frame per requested cell ────────────────────────────────────
cells = []
for oi, orq in enumerate(OPEN_RUNGS):
    for lbl, rrq in ROUND_COLS:
        # 2-D distance in the requested plane; openness weighted 2x because it is
        # the better-measured axis, so a cell never sacrifices openness for width.
        d = np.hypot(2.0 * (openness - orq), roundness - rrq)
        d = np.where(ok, d, d + 1.0)          # strongly prefer frontal frames
        f = int(np.argmin(d))
        true_d = float(np.hypot(openness[f] - orq, roundness[f] - rrq))
        cells.append(dict(reqOpen=orq, reqRound=rrq, reqLabel=lbl, frame=f,
                          dist=true_d, approx=bool(true_d > APPROX_TOL)))

# dedupe: many requested cells legitimately resolve to the same real frame,
# because her footage simply does not contain that many distinct mouth shapes.
best = {}
for c in cells:
    k = c["frame"]
    if k not in best or c["dist"] < best[k]["dist"]:
        best[k] = c

# A dedicated BILABIAL CLOSED entry. Chosen shut FIRST, then NEUTRAL in width,
# then most frontal. Neutral width is deliberate: /m/ /b/ /p/ is a generic lip
# closure, so the maximally PURSED shut frame is the wrong pick — it reads as a
# closed "oo" and would put rounding on every /m/. Roundness variation among
# closed frames is served by the closed cells (w00..w02) via the 2-D lookup.
cand = [f for f in range(N) if ok[f] and openness[f] <= 0.03]
if not cand:
    cand = [int(np.argmin(openness + (~ok) * 1.0))]
closed_f = min(cand, key=lambda f: (round(float(openness[f]), 3),
                                    abs(float(roundness[f]) - 0.5), -conf[f]))

entries = []


def label_for(o, r):
    if o < 0.12:
        return "closed" if r >= 0.45 else "closed-wide"
    if o < 0.45:
        return "eh" if r < 0.45 else "uh"
    if r >= 0.6:
        return "oo"
    if r < 0.4:
        return "ah"
    return "oh"


def emit(f, ident, label, req=None, approx=False, dist=0.0, note=""):
    b = boxes[f]
    x = int(min(max(0, b["x"]), VW - b["w"]))
    y = int(min(max(0, b["y"]), VH - b["h"]))
    fn = f"{ident}.png"
    if not DRY:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", CLIP, "-vf",
             f"select=eq(n\\,{f}),crop={b['w']}:{b['h']}:{x}:{y}",
             "-vsync", "0", "-frames:v", "1", os.path.join(OUT_DIR, fn)],
            check=True)
    e = dict(id=ident, file=f"/avatar/visemes/{fn}",
             openness=round(float(openness[f]), 4),
             roundness=round(float(roundness[f]), 4),
             sourceFrame=int(f), poseConfidence=round(float(conf[f]), 4),
             label=label, widthPx=round(float(width[f]), 1))
    if req is not None:
        e["requestedOpenness"] = req[0]
        e["requestedRoundness"] = req[1]
        e["cellDistance"] = round(dist, 4)
    e["approximation"] = bool(approx)
    if note:
        e["note"] = note
    entries.append(e)
    return e


if not DRY:
    os.makedirs(OUT_DIR, exist_ok=True)

emit(closed_f, "w_closed", "closed",
     note="Dedicated bilabial /m/ /b/ /p/ shape: the most-shut, most-frontal, "
          "narrowest real frame. Her footage contains closure in abundance "
          "(295 of 354 frames sit below openness 0.2), so this is a genuine "
          "closed mouth, not an approximation of one.")

for i, (f, c) in enumerate(sorted(best.items(), key=lambda kv: (openness[kv[0]], -roundness[kv[0]]))):
    if f == closed_f:
        continue
    emit(f, f"w{i:02d}", label_for(openness[f], roundness[f]),
         req=(c["reqOpen"], c["reqRound"]), approx=c["approx"], dist=c["dist"],
         note=("No real frame lies near this requested cell — her one talking "
               "take does not contain this mouth shape. Nearest REAL frame used; "
               "no pixels were synthesised.") if c["approx"] else "")

gaps = [c for c in cells if c["approx"]]
bank = dict(
    version=2,
    source="/avatar/clips/talking.mp4",
    builder="scripts/build-viseme-bank-2d.py",
    width=int(boxes[0]["w"]), height=int(boxes[0]["h"]), fps=FPS,
    axes=dict(
        openness="0=lips shut, 1=widest real aperture. Linear discriminant over "
                 "the gray lip ROI between hand-verified closed and open exemplars.",
        roundness="1=rounded/narrow (oo, w), 0=spread/wide (ee, ah). From measured "
                  "corner-to-corner mouth width; independent of openness "
                  f"(corr={np.corrcoef(width, openness)[0,1]:+.3f}).",
    ),
    closedId="w_closed",
    coverage=dict(
        frames=int(N),
        opennessBimodal=True,
        note="HONEST COVERAGE. Her openness distribution is BIMODAL: "
             f"{int((openness < 0.2).sum())} of {N} frames below 0.2 and "
             f"{int((openness > 0.7).sum())} above 0.7, with only "
             f"{int(((openness >= 0.2) & (openness <= 0.7)).sum())} frames in the "
             "entire 0.2-0.7 middle. Mid-openness entries are therefore the "
             "NEAREST REAL frames, not true mid-aperture mouths. A genuine "
             "spread 'ee' exists only in frames 6-20, which sit inside the "
             "low-pose-confidence run 7-20 and are excluded on pose grounds. "
             "No pixels were ever synthesised to fill a gap.",
        approximatedCells=len(gaps),
    ),
    frames=entries,
)

print(f"\nbank: {len(entries)} distinct real frames "
      f"({sum(1 for e in entries if e['approximation'])} flagged as approximations)")
for e in entries:
    flag = "  APPROX" if e["approximation"] else ""
    print(f"  {e['id']:9s} o={e['openness']:.3f} r={e['roundness']:.3f} "
          f"w={e['widthPx']:.0f}px src=f{e['sourceFrame']:3d} pose={e['poseConfidence']:.3f} "
          f"{e['label']:12s}{flag}")

if DRY:
    print("\n--dry-run: nothing written")
else:
    out = os.path.join(OUT_DIR, "bank2.json")
    open(out, "w").write(json.dumps(bank, indent=2) + "\n")
    print(f"\nwrote {os.path.relpath(out, ROOT)} and {len(entries)} PNGs")
    print("bank.json / v00..v07.png are left UNTOUCHED as the 1-D fallback.")
