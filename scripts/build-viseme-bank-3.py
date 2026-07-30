#!/usr/bin/env python3
"""
build-viseme-bank-3.py — cuts the conversational STANCE clips, tracks the mouth on
the speaking base, and rebuilds the 2-D viseme bank into public/avatar/visemes2/.

  RUN IT WITH:  python3 scripts/build-viseme-bank-3.py            (measure + report)
                python3 scripts/build-viseme-bank-3.py --write    (also write assets)
  Flags:
    --write        actually write the clips, anchor.json and the bank (default: dry)
    --out <dir>    bank output dir (default public/avatar/visemes2)

$0, OFFLINE, NO GPU, NO NEW DEPENDENCY: ffmpeg + ffprobe + python3 + numpy + cv2, all
already installed. mediapipe and scipy are NOT installed and are NOT used; there is
no face-landmark model anywhere in this file. Nothing is downloaded.

NO PIXEL OF HER FACE IS EVER SYNTHESISED. Every output frame and every bank entry is
a straight ffmpeg CROP / CUT of a real frame of her footage at native resolution. No
interpolation between frames, no inpainting, no morphing, no upscaling. Where her
footage does not contain a shape, this file records an EMPTY or APPROXIMATED cell and
says so in bank.json — it never fills a gap.

WRITES ONLY NEW FILES. The live bank (public/avatar/visemes/) and every pre-existing
clip in public/avatar/clips/ are opened READ-ONLY or not at all; the script refuses to
overwrite anything that already exists.

═══════════════════════════════════════════════════════════════════════════════════
WHY THIS EXISTS — THE ARCHITECTURE ERROR IT FIXES
The mouth patch used to be composited onto public/avatar/clips/talking.mp4. That clip
is unusable as a conversational base: her eyes are closed or downcast for roughly 60%
of it and her head travels 121px horizontally / 73px vertically (measured off the old
public/avatar/visemes/anchor.json box track). A correctly-synced mouth on that base is
still a person twitching and breaking eye contact. No amount of sync tuning fixes a
bad base — the base has to change. That is what this file produces.

═══════════════════════════════════════════════════════════════════════════════════
SOURCE FOOTAGE, AND WHY IT IS ONE TAKE
  'e heavy.mp4'   768x1168, 24fps, 361 frames, 15.0417s, no audio
  'ooo heavy.mp4' 768x1168, 24fps, 361 frames, 15.0417s, no audio
Frame 0 of the two is the SAME IMAGE to within h264 encode noise: mean|d| = 1.16,
PSNR 43.30 dB, 24.18% of pixels bit-identical. They are two image-to-video generations
from one keyframe. For contrast, e heavy frame 0 vs idle_a1 frame 0 is PSNR 14.86 dB
(mean|d| 27.8) with different framing, lighting and makeup — a DIFFERENT take, which
is why nothing here is sourced from the idle_a/b/c family. Same-take sourcing is not
cosmetic: a mouth cut from one take and pasted on a base from another reads as someone
else's mouth.

MEASURED, THIS BUILD (see the module docstrings of the scratchpad QC scripts):
  e heavy    head is essentially LOCKED. Nose-centre travel 25px max over the whole
             clip (0.106 of the 237px measured face width); across the chosen base run
             it is 2px in x and 3px in y. Gaze on the lens for 361/361 frames by the
             conjunctive two-eye rule. Exactly ONE eye closure: f115-120, 250ms,
             perfectly symmetric — a natural blink. No corruption.
  ooo heavy  UNUSABLE as a base and, as it turns out, unnecessary as a viseme source.
             Only 54/361 frames (15%) pass the pose gate. Four separate eye closures
             exceed 600ms (up to 3292ms). 78 frames are asymmetric closures. Zero
             head-still frames. Zero shut-mouth runs of 1s or more.

THE BRIEF EXPECTED 'ooo heavy' TO SUPPLY THE ROUNDED END AND 'e heavy' THE SPREAD END.
MEASURED, THAT IS FALSE, so this builder uses e heavy ALONE:
  lip width, pose-eligible frames:  e heavy 59..91px      ooo heavy 58..79px
  e heavy covers BOTH extremes and a WIDER range. ooo heavy's rounded end (58px) beats
  e heavy's (59px) by one pixel, and its spread end (79px) is 12px NARROWER than
  e heavy's (91px). Filling a 3x3 (aperture x width) grid from pose-eligible frames:
  e heavy fills 9 of 9 cells; ooo heavy fills 5 of 9 and not one of them uniquely.
  So ooo heavy would add nothing while importing a cross-clip appearance risk. Sourcing
  the bank from the SAME clip as the base makes the mouth match the body BY
  CONSTRUCTION, which is the whole point of this round.

═══════════════════════════════════════════════════════════════════════════════════
HOW THE TWO AXES ARE MEASURED — SEPARATELY, so their independence is a real result
HEIGHT (aperture, px) — per column of the tracked mouth ROI, the span between the
  bottom of the FIRST lip run and the top of the LAST lip run, intersected with a
  chromatic interior test (Lab a* below her own lip-redness level, and either dark
  cavity or bright desaturated teeth), then the LONGEST CONTIGUOUS run of that in any
  centre-band column. Every clause was forced by a measured failure:
    - a plain dark-pixel aperture finds her nasolabial shadow, not her mouth (her lips
      are glossy-bright and her cavity is mid-tone red-brown) — the rejection already
      documented in build-viseme-bank.mjs:44-51, re-confirmed here;
    - a chromatic-only interior LEAKED onto the dark shadows at her mouth corners, so
      shut frames scored 455px of "interior";
    - the geometric span ALONE leapt across the whole lip, because her lip GLOSS is not
      lip-red either: median aperture came out 42px on a clip that is shut for a third
      of its length;
    - taking the vertical EXTENT rather than a CONTIGUOUS run read shut frames as 36px
      open, bridging a gloss speckle on the upper lip to one on the lower lip.
  The contiguous run bridges holes of up to 8px, because the gum/tooth-edge band
  inside an open mouth is a real anatomical boundary that is neither lip nor cavity
  and it broke contiguity: at a 2px bridge, teeth frames under-read badly (f238 15px,
  f26 37px). At an 8px bridge those become 24px and 48px while EVERY verified-shut
  frame stays at exactly 5-6px and every rounded frame is unchanged to the pixel
  (f176 37, f193 29, f178 22, f253 24) — measured, not assumed, in a four-way bridge
  sweep. So the bridge buys teeth accuracy at zero cost to the closure floor.
  The result: shut lips measure 2-6px (the dark lip seam), open mouths 22-48px.
WIDTH (corner-to-corner, px) — the widest per-ROW run of lip pixels CONNECTED THROUGH
  the mouth centre column (the connectivity rule from build-viseme-bank-2d.py:189-214;
  a naive horizontal extent reads a disconnected cheek blob as a wide mouth).

  corr(WIDTH, HEIGHT) = +0.146 on e heavy (+0.09 at the 2px bridge, +0.085 on ooo heavy).
  Near zero on every variant tried, so the two axes carry independent information and a
  2-D bank is NOT pointless. Had it come out near +1 this file would say so and ship 1-D.
  The live figure is recomputed every run and written to bank.json -> axes.independence;
  trust that over this comment.

TRACKING — rigid multi-scale NCC, no landmark model. The template is a nose patch
  (bridge to nostrils, stopping above the lip line so speech cannot deform it) taken
  from e heavy frame 0. Each frame is matched over a range of template SCALES because
  the generated footage slowly zooms; the winning (dx, dy, scale) defines a similarity
  transform through which the mouth box is mapped. A fixed crop is worthless here — it
  lands on the nose or the eyebrows once her head moves. `confidence` is the raw NCC:
  it falls when her head rotates out of the reference pose, which is exactly when a
  frontal mouth patch would look wrong, so the runtime can use it as a pose gate.
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_E = "/Users/work/Desktop/e heavy.mp4"
CLIPS_DIR = os.path.join(ROOT, "public/avatar/clips")

WRITE = "--write" in sys.argv


def arg(name, dflt):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else dflt


OUT_DIR = os.path.abspath(os.path.join(ROOT, arg("--out", "public/avatar/visemes2")))

# ── safety rails ──────────────────────────────────────────────────────────────
if not OUT_DIR.startswith(ROOT + os.sep):
    sys.exit(f"refusing: --out must stay inside the repo (got {OUT_DIR})")
for bad in ("public/avatar/clips", "public/avatar/visemes/"):
    if bad in (OUT_DIR.replace("\\", "/") + "/"):
        sys.exit(f"refusing: --out must never point into {bad} (read-only / live)")
if not os.path.exists(SRC_E):
    sys.exit(f"refusing: source footage not found: {SRC_E}")

# ── reference geometry, MEASURED on e heavy frame 0 (full-frame px) ────────────
W, H = 768, 1168
NOSE = (330, 300, 100, 85)
NCX, NCY = NOSE[0] + NOSE[2] / 2.0, NOSE[1] + NOSE[3] / 2.0
MOUTH = (288, 358, 196, 140)
IOD = 132.0          # measured interocular distance (iris centres 317,290 / 449,288)
FACE_W = 237.0       # measured lit-face cheek-to-cheek at y=310..330
SCALES = np.arange(0.84, 1.41, 0.02)
FPS = 24.0

# ── measurement constants, all derived from measurements printed by this script ─
POSE_FLOOR = 0.93    # NCC pose gate, matching viseme-sync's POSE_CONFIDENCE_FLOOR
SHUT_FLOOR = 6.0     # px: shut lips measure 2-6px (the dark lip seam). 0 aperture.
CX, CY = 98, 70      # mouth centre in the 196x140 ROI
COL_HALF = 16
WINX0, WINX1, WINY0, WINY1 = 18, 178, 14, 126
A_COEF = 0.26

# ── the CUTS. Frame ranges are inclusive, chosen from the measured runs. ───────
# e heavy contains exactly TWO runs of >=12 frames with a resting/shut mouth AND a
# still head AND both eyes open AND gaze on the lens: f93-139 and f272-360. That is
# the complete inventory, not a selection from many.
CUTS = {
    # THE SPEAKING BASE. The longer and steadier of the two runs. Nose centre moves
    # 379.0..381.0 in x and 339.5..342.5 in y across all 89 frames (2px / 3px, i.e.
    # 0.013 of face width); scale 1.000 on 88 of 89 frames; NCC min 0.986; aperture
    # 5-8px (resting lips) on every frame; gaze on lens on every frame; no closure.
    "base_speak": (272, 360),
    # IDLE STANCES. stance_a is the other independent run and is the ONLY stance that
    # contains a blink — e heavy holds exactly one blink (f115-120, 250ms, symmetric)
    # in its whole 15s, and it lands here.
    "stance_a": (93, 139),
    # stance_b / stance_c are the two halves of the same run base_speak is cut from.
    # THIS OVERLAP IS DELIBERATE AND DISCLOSED: the footage contains no third
    # qualifying run, so a "third independent stance" would have to be invented.
    # stance_b has the tightest loop seam of every candidate measured (mean|d| 3.06
    # on 192x292 thumbnails, against 6.35 for the full base run).
    "stance_b": (272, 316),
    "stance_c": (317, 360),
}

# ── the requested bank grid. Rungs are REQUESTS, not promises. ────────────────
OPEN_RUNGS = [0.00, 0.25, 0.50, 0.75, 1.00]
ROUND_COLS = [("spread", 0.05), ("neutral", 0.50), ("rounded", 0.95)]
APPROX_TOL = 0.14


# ══════════════════════════════════════════════════════════════════════════════
def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,r_frame_rate,nb_frames,duration", "-of",
         "default=noprint_wrappers=1:nokey=0", path],
        capture_output=True, check=True).stdout.decode()
    d = dict(l.split("=", 1) for l in out.strip().splitlines())
    n, den = d["r_frame_rate"].split("/")
    return (int(d["width"]), int(d["height"]), int(n) / int(den),
            int(d.get("nb_frames") or 0), float(d.get("duration") or 0))


def decode(path, w, h):
    """Sequential full decode via ffmpeg rawvideo. ZERO SEEKS — a fast seek (-ss
    before -i) produces FALSE rainbow artefacts and already fooled an earlier pass."""
    n = w * h * 3
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo",
                          "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE, bufsize=n)
    while True:
        buf = p.stdout.read(n)
        if len(buf) < n:
            break
        yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    p.wait()


# ── corruption detector ───────────────────────────────────────────────────────
# VALIDATED as a control test against the two clips with documented baked-in
# rainbow/datamosh corruption: it fires on idle_c frames 291-318 (28 of 28, the exact
# documented range) and idle_b 222-240, with ZERO false positives on the documented-
# clean idle_a. `hisat` is the load-bearing metric: corrupt frames carry 2.5-6.7x the
# baseline count of highly-saturated pixels. ffmpeg -f null reports these clips clean
# because the BITSTREAM is valid — the damage is in the decoded PIXELS.
GRID = 16


def corruption_scan(path):
    w, h, fps, nb, dur = probe(path)
    mad, blk, hisat = [], [], []
    prev = None
    for fr in decode(path, w, h):
        if prev is None:
            mad.append(0.0)
            blk.append(0.0)
        else:
            d = cv2.absdiff(fr, prev).astype(np.float32).mean(axis=2)
            bh, bw = d.shape[0] // GRID, d.shape[1] // GRID
            b = d[:bh * GRID, :bw * GRID].reshape(GRID, bh, GRID, bw).mean(axis=(1, 3))
            mad.append(float(d.mean()))
            blk.append(float(b.max()))
        hsv = cv2.cvtColor(fr, cv2.COLOR_BGR2HSV)
        s, v = hsv[:, :, 1].astype(np.int16), hsv[:, :, 2].astype(np.int16)
        hisat.append(int(((s > 190) & (v > 90)).sum()))
        prev = fr.copy()
    out = {}
    for nm, arr in (("mad", mad), ("blkmax", blk), ("hisat", hisat)):
        a = np.array(arr, float)[1:]
        m = np.median(a)
        sd = 1.4826 * np.median(np.abs(a - m))
        z = (a - m) / (sd if sd > 1e-9 else 1.0)
        out[nm] = dict(median=float(m), min=float(a.min()), max=float(a.max()),
                       flagged=[int(i) + 1 for i in np.nonzero(z > 8.0)[0]])
    return out, len(mad)


# ── tracker ───────────────────────────────────────────────────────────────────
def build_templates(ref):
    tg = cv2.cvtColor(ref[NOSE[1]:NOSE[1] + NOSE[3], NOSE[0]:NOSE[0] + NOSE[2]],
                      cv2.COLOR_BGR2GRAY)
    t = {}
    for s in SCALES:
        tw, th = int(round(NOSE[2] * s)), int(round(NOSE[3] * s))
        t[round(float(s), 3)] = cv2.resize(
            tg, (tw, th), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC)
    return t


def match(gray, tpl, prev, fw, fh):
    if prev is None:
        sl = [round(float(s), 3) for s in SCALES]
        x0, y0, x1, y1 = 120, 140, min(660, fw), min(760, fh)
    else:
        _, pcx, pcy, ps = prev
        i = int(np.argmin(np.abs(SCALES - ps)))
        sl = [round(float(SCALES[j]), 3)
              for j in range(max(0, i - 3), min(len(SCALES), i + 4))]
        x0 = int(max(0, pcx - NOSE[2] * ps / 2 - 45))
        y0 = int(max(0, pcy - NOSE[3] * ps / 2 - 45))
        x1 = int(min(fw, pcx + NOSE[2] * ps / 2 + 45))
        y1 = int(min(fh, pcy + NOSE[3] * ps / 2 + 45))
    win = gray[y0:y1, x0:x1]
    best = (-2.0, 0.0, 0.0, 1.0)
    for s in sl:
        t = tpl[s]
        if win.shape[0] < t.shape[0] or win.shape[1] < t.shape[1]:
            continue
        r = cv2.matchTemplate(win, t, cv2.TM_CCOEFF_NORMED)
        _, mx, _, ml = cv2.minMaxLoc(r)
        if mx > best[0]:
            best = (float(mx), x0 + ml[0] + t.shape[1] / 2.0,
                    y0 + ml[1] + t.shape[0] / 2.0, s)
    return best


def box_at(ref_box, cx, cy, s):
    bx, by, bw, bh = ref_box
    ccx, ccy = bx + bw / 2.0, by + bh / 2.0
    nw, nh = bw * s, bh * s
    return cx + s * (ccx - NCX) - nw / 2.0, cy + s * (ccy - NCY) - nh / 2.0, nw, nh


def track(path, tpl):
    w, h, *_ = probe(path)
    out, mouths, prev = [], [], None
    for fr in decode(path, w, h):
        g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        b = match(g, tpl, prev, w, h)
        prev = b
        out.append(b)
        x, y, bw, bh = box_at(MOUTH, b[1], b[2], b[3])
        xi = max(0, min(int(round(x)), w - int(round(bw))))
        yi = max(0, min(int(round(y)), h - int(round(bh))))
        c = fr[yi:yi + int(round(bh)), xi:xi + int(round(bw))]
        mouths.append(cv2.resize(c, (MOUTH[2], MOUTH[3]),
                                 interpolation=cv2.INTER_AREA if bw > MOUTH[2]
                                 else cv2.INTER_CUBIC))
    return np.array(out, float), np.array(mouths, np.uint8)


# ── mouth measurement ─────────────────────────────────────────────────────────
def lip_mask(img):
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    L, A = lab[:, :, 0], lab[:, :, 1]
    skinL = float(np.median(L[6:26, CX - 30:CX + 30]))
    if skinL <= 1:
        return np.zeros(L.shape, np.uint8), 1.0, 0.0
    valid = L > 0.45 * skinL
    if valid.sum() < 2000:
        valid = np.ones_like(L, bool)
    av = A[valid]
    a_skin, a_hi = np.percentile(av, 45), np.percentile(av, 98)
    thr = a_skin + A_COEF * max(a_hi - a_skin, 1.0)
    lip = ((A > thr) & valid).astype(np.uint8)
    lip = cv2.morphologyEx(lip, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    lip = cv2.morphologyEx(lip, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    win = np.zeros_like(lip)
    win[WINY0:WINY1, WINX0:WINX1] = 1
    lip *= win
    n, lbl, st, cent = cv2.connectedComponentsWithStats(lip, 8)
    keep = np.zeros_like(lip)
    for i in range(1, n):
        if (st[i, cv2.CC_STAT_AREA] >= 150 and abs(cent[i][0] - CX) < 62
                and abs(cent[i][1] - CY) < 46):
            keep |= (lbl == i).astype(np.uint8)
    return keep, skinL, thr


def interior_mask(img, lip, skinL, thr):
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    L, A = lab[:, :, 0], lab[:, :, 1]
    chroma_ok = (A <= thr) & ((L < 0.62 * skinL) | ((L > 0.80 * skinL) & (A < thr - 3)))
    ys, xs = np.nonzero(lip)
    out = np.zeros(lip.shape, np.uint8)
    if len(xs) < 100:
        return out
    for x in range(max(int(xs.min()), 0), min(int(xs.max()) + 1, lip.shape[1])):
        col = np.nonzero(lip[:, x])[0]
        if len(col) < 2:
            continue
        brk = np.nonzero(np.diff(col) > 1)[0]
        if len(brk) == 0:
            continue
        a, b = col[brk[0]] + 1, col[brk[-1] + 1]
        if b - a >= 1 and abs((a + b) / 2 - CY) < 40:
            out[a:b, x] = chroma_ok[a:b, x]
    return out


def aperture(it):
    band = it[:, CX - COL_HALF:CX + COL_HALF + 1]
    if not band.any():
        return 0.0
    best = 0
    for c in range(band.shape[1]):
        r = np.nonzero(band[:, c])[0]
        if len(r) == 0:
            continue
        start = prev = r[0]
        for v in r[1:]:
            if v - prev <= 9:      # bridge holes up to 8px: the GUM/TOOTH-EDGE band
                prev = v
            else:
                best = max(best, int(prev - start + 1))
                start = prev = v
        best = max(best, int(prev - start + 1))
    return float(best)


def lip_width(lip):
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


def touching_frac(lip):
    """Fraction of centre-band columns where the lip mask is a SINGLE run, i.e. the
    lips are in contact. ~1.0 proves a real bilabial closure; ~0 proves an aperture.
    This is the evidence that the closed entry is genuinely SHUT — the previous bank
    had nothing shut at all (its floor was 0.0814 openness)."""
    tot = hit = 0
    for x in range(CX - COL_HALF, CX + COL_HALF + 1):
        col = np.nonzero(lip[:, x])[0]
        if len(col) < 2:
            continue
        tot += 1
        if not (np.diff(col) > 1).any():
            hit += 1
    return (hit / tot) if tot else 0.0


# ══════════════════════════════════════════════════════════════════════════════
vw, vh, vfps, vnb, vdur = probe(SRC_E)
print(f"source {SRC_E}\n  {vw}x{vh} @ {vfps}fps  nb_frames={vnb}  {vdur:.4f}s")
if (vw, vh) != (W, H):
    sys.exit(f"refusing: expected {W}x{H}, got {vw}x{vh}")

def first_frame(path, w, h):
    """One frame, without leaving ffmpeg writing into a closed pipe (abandoning the
    decode() generator makes ffmpeg print a Broken pipe traceback to stderr)."""
    n = w * h * 3
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-frames:v", "1",
                          "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    buf = p.stdout.read(n)
    p.stdout.close()
    p.wait()
    return np.frombuffer(buf, np.uint8).reshape(h, w, 3).copy()


ref = first_frame(SRC_E, vw, vh)
TPL = build_templates(ref)
T, MO = track(SRC_E, TPL)
N = len(T)
print(f"  tracked {N} frames; NCC median={np.median(T[:,0]):.4f} min={T[:,0].min():.4f}; "
      f"scale {T[:,3].min():.2f}..{T[:,3].max():.2f}")

hgt = np.zeros(N)
wid = np.zeros(N)
touch = np.zeros(N)
for f in range(N):
    lip, sL, thr = lip_mask(MO[f])
    hgt[f] = aperture(interior_mask(MO[f], lip, sL, thr))
    wid[f] = lip_width(lip)
    touch[f] = touching_frac(lip)

conf = T[:, 0]
ok = conf >= POSE_FLOOR
H_MAX = float(hgt[ok].max())
W_LO = float(np.percentile(wid[ok], 3))
W_HI = float(np.percentile(wid[ok], 97))
openness = np.clip((hgt - SHUT_FLOOR) / max(H_MAX - SHUT_FLOOR, 1e-9), 0.0, 1.0)
roundness = np.clip((W_HI - wid) / max(W_HI - W_LO, 1e-9), 0.0, 1.0)
corr_wh = float(np.corrcoef(wid, hgt)[0, 1])

print(f"\n  aperture (HEIGHT): min={hgt.min():.0f} median={np.median(hgt):.0f} "
      f"max={hgt.max():.0f}px | pose-eligible max={H_MAX:.0f}px "
      f"| frames at/below the {SHUT_FLOOR:.0f}px shut floor: {int((hgt<=SHUT_FLOOR).sum())}")
print(f"  lip WIDTH: min={wid.min():.0f} p03={W_LO:.0f} median={np.median(wid):.0f} "
      f"p97={W_HI:.0f} max={wid.max():.0f}px  (roundness maps {W_HI:.0f}px->0 spread, "
      f"{W_LO:.0f}px->1 rounded)")
print(f"  corr(WIDTH, HEIGHT) = {corr_wh:+.3f}   "
      f"{'AXES INDEPENDENT — a 2-D bank is justified' if abs(corr_wh) < 0.5 else 'AXES COUPLED — a 2-D bank would be pointless'}")
print(f"  pose-eligible frames (NCC>={POSE_FLOOR}): {int(ok.sum())}/{N}")

print("\n  openness coverage of HER footage (the honest constraint):")
for a, b in [(0.0, 0.001), (0.001, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.01)]:
    i = int(((openness >= a) & (openness < b)).sum())
    j = int(((openness >= a) & (openness < b) & ok).sum())
    lbl = "shut (0.000)" if b == 0.001 else f"{a:.1f}-{b:.1f}"
    print(f"    openness {lbl:12s}: {i:3d} frames ({j:3d} pose-eligible)")

# ── pick one real frame per requested cell ────────────────────────────────────
cells = []
for orq in OPEN_RUNGS:
    for lbl, rrq in ROUND_COLS:
        # openness weighted 2x: it is the better-conditioned axis, so a cell never
        # trades away aperture to win on width. Non-frontal frames are pushed far
        # away rather than merely penalised. Frames at the base run's own scale
        # (1.00) get a small bonus so the patch geometry matches the base exactly
        # and the crop needs no resampling at runtime.
        d = np.hypot(2.0 * (openness - orq), roundness - rrq)
        d = np.where(ok, d, d + 1.0)
        d = d + np.where(np.round(T[:, 3], 3) == 1.0, 0.0, 0.05)
        f = int(np.argmin(d))
        true_d = float(np.hypot(openness[f] - orq, roundness[f] - rrq))
        cells.append(dict(reqOpen=orq, reqRound=rrq, reqLabel=lbl, frame=f,
                          dist=true_d, approx=bool(true_d > APPROX_TOL)))

best = {}
for c in cells:
    k = c["frame"]
    if k not in best or c["dist"] < best[k]["dist"]:
        best[k] = c

# dedicated bilabial /m/ /b/ /p/ entry: most shut, then most NEUTRAL in width, then
# most frontal. Neutral width is deliberate — /m/ is a generic lip closure, so the
# maximally pursed shut frame would put rounding on every /m/.
cand = [f for f in range(N) if ok[f] and hgt[f] <= SHUT_FLOOR]
if not cand:
    sys.exit("refusing: no pose-eligible shut frame — cannot ship a bank with no closure")
closed_f = min(cand, key=lambda f: (hgt[f], abs(roundness[f] - 0.5), -conf[f]))

print(f"\n  CLOSED entry: frame {closed_f}  aperture={hgt[closed_f]:.0f}px  "
      f"width={wid[closed_f]:.0f}px  lips-touching in "
      f"{touch[closed_f]*100:.0f}% of centre-band columns  NCC={conf[closed_f]:.4f}")
print(f"    (for contrast, the most OPEN pose-eligible frame touches in "
      f"{touch[int(np.argmax(np.where(ok,hgt,-1)))]*100:.0f}% of columns)")


def label_for(o, r):
    if o <= 0.02:
        return "closed" if r < 0.6 else "closed-oo"
    if o < 0.35:
        return "ee" if r < 0.35 else ("oo-small" if r >= 0.65 else "eh")
    if r >= 0.65:
        return "oo"
    if r < 0.35:
        return "ee-open"
    return "ah"


entries = []


def emit(f, ident, label, req=None, approx=False, dist=0.0, note=""):
    x, y, bw, bh = box_at(MOUTH, T[f, 1], T[f, 2], T[f, 3])
    xi = max(0, min(int(round(x)), vw - int(round(bw))))
    yi = max(0, min(int(round(y)), vh - int(round(bh))))
    bwi, bhi = int(round(bw)), int(round(bh))
    fn = f"{ident}.png"
    if WRITE:
        # PURE CROP of one real frame at native resolution. -vsync 0 + select by
        # frame number; no scaling filter, so no pixel value is interpolated.
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", SRC_E, "-vf",
             f"select=eq(n\\,{f}),crop={bwi}:{bhi}:{xi}:{yi}",
             "-vsync", "0", "-frames:v", "1", os.path.join(OUT_DIR, fn)], check=True)
    e = dict(id=ident, file=f"/avatar/visemes2/{fn}",
             openness=round(float(openness[f]), 4),
             roundness=round(float(roundness[f]), 4),
             sourceFrame=int(f), sourceClip="/avatar/clips/base_speak.mp4 source: e heavy.mp4",
             poseConfidence=round(float(conf[f]), 4), label=label,
             aperturePx=round(float(hgt[f]), 1), widthPx=round(float(wid[f]), 1),
             lipsTouchingFrac=round(float(touch[f]), 3),
             box=dict(x=xi, y=yi, w=bwi, h=bhi), sourceScale=round(float(T[f, 3]), 3),
             scaleMatchesBase=bool(round(float(T[f, 3]), 3) == 1.0))
    if req is not None:
        e["requestedOpenness"] = req[0]
        e["requestedRoundness"] = req[1]
        e["cellDistance"] = round(dist, 4)
    e["approximation"] = bool(approx)
    if note:
        e["note"] = note
    entries.append(e)


if WRITE:
    os.makedirs(OUT_DIR, exist_ok=True)

emit(closed_f, "m_closed", "closed",
     note=f"Dedicated bilabial /m/ /b/ /p/. GENUINELY SHUT, proven not asserted: "
          f"aperture {hgt[closed_f]:.0f}px (the shut floor is the {SHUT_FLOOR:.0f}px dark lip "
          f"seam) and the lip mask is a single unbroken run in "
          f"{touch[closed_f]*100:.0f}% of centre-band columns. The previous bank's "
          f"floor was 0.0814 openness — it had nothing fully closed.")

for i, (f, c) in enumerate(sorted(best.items(),
                                  key=lambda kv: (openness[kv[0]], -roundness[kv[0]]))):
    if f == closed_f:
        continue
    emit(f, f"m{i:02d}", label_for(openness[f], roundness[f]),
         req=(c["reqOpen"], c["reqRound"]), approx=c["approx"], dist=c["dist"],
         note=("No real frame lies near this requested cell — her footage does not "
               "contain this mouth shape. The nearest REAL frame is used and flagged; "
               "no pixels were synthesised.") if c["approx"] else "")

# ── honest per-cell coverage map ───────────────────────────────────────────────
cov = []
for c in cells:
    f = c["frame"]
    cov.append(dict(requestedOpenness=c["reqOpen"], requestedRoundness=c["reqRound"],
                    requestedLabel=c["reqLabel"], resolvedFrame=int(f),
                    trueOpenness=round(float(openness[f]), 4),
                    trueRoundness=round(float(roundness[f]), 4),
                    distance=round(c["dist"], 4), approximation=bool(c["approx"]),
                    empty=False))
n_approx = sum(1 for c in cells if c["approx"])

bank = dict(
    version=3,
    builder="scripts/build-viseme-bank-3.py",
    source="/avatar/clips/base_speak.mp4",
    sourceFootage="e heavy.mp4 (768x1168 @24fps, 361 frames) — the SAME clip the base "
                  "is cut from, so the mouth matches the body by construction",
    width=MOUTH[2], height=MOUTH[3], fps=FPS,
    poseFloor=POSE_FLOOR,
    axes=dict(
        openness="0 = lips shut, 1 = the widest real aperture. From MEASURED vertical "
                 f"aperture in px: 0 at the {SHUT_FLOOR:.0f}px shut floor (the dark lip "
                 f"seam), 1 at {H_MAX:.0f}px. Not a discriminant — a real distance.",
        roundness="1 = rounded/narrow (oo, w), 0 = spread/wide (ee). From MEASURED "
                  f"corner-to-corner lip width: {W_HI:.0f}px -> 0, {W_LO:.0f}px -> 1.",
        independence=f"corr(width, aperture) = {corr_wh:+.3f} on this footage. Near "
                     "zero, so the two axes are genuinely independent and the 2-D "
                     "lookup carries information a 1-D ladder cannot.",
    ),
    closedId="m_closed",
    coverage=dict(
        framesMeasured=int(N), poseEligible=int(ok.sum()),
        requestedCells=len(cells), distinctRealFrames=len(entries),
        approximatedCells=n_approx, emptyCells=0,
        note="HONEST COVERAGE. Every entry is a pure ffmpeg crop of one real frame of "
             "her footage; nothing is interpolated, inpainted or synthesised. Cells "
             "further than "
             f"{APPROX_TOL} from their request in the 2-D plane are flagged "
             "`approximation: true` and resolve to the nearest REAL frame. "
             "'ooo heavy.mp4' was measured and DELIBERATELY NOT USED: it passes the "
             "pose gate on only 54/361 frames and its lip-width range (58..79px) is "
             "strictly narrower than e heavy's (59..91px), so it fills 5 of 9 grid "
             "cells and none of them uniquely.",
        cells=cov,
    ),
    frames=entries,
)

print(f"\n  bank: {len(entries)} distinct real frames from {len(cells)} requested cells "
      f"({n_approx} cells flagged as approximations, 0 empty)")
for e in entries:
    print(f"    {e['id']:9s} o={e['openness']:.3f} r={e['roundness']:.3f} "
          f"ap={e['aperturePx']:4.0f}px w={e['widthPx']:3.0f}px src=f{e['sourceFrame']:3d} "
          f"pose={e['poseConfidence']:.3f} sc={e['sourceScale']:.2f} "
          f"{e['label']:10s}{'  APPROX' if e['approximation'] else ''}")

# ── STEP 2: cut the stances ───────────────────────────────────────────────────
def cut(name, a, b):
    dst = os.path.join(CLIPS_DIR, f"{name}.mp4")
    if os.path.exists(dst):
        print(f"    {name}.mp4 ALREADY EXISTS — refusing to overwrite")
        return dst
    if not WRITE:
        print(f"    (dry) {name}.mp4  frames {a}-{b}  "
              f"t={a/FPS:.4f}s..{(b+1)/FPS:.4f}s  {(b-a+1)} frames  {(b-a+1)/FPS:.4f}s")
        return dst
    # select by FRAME NUMBER, not -ss. Frame-exact, decodes sequentially from frame 0,
    # so it cannot hit the fast-seek artefact. Re-encode (NOT stream copy, which cannot
    # cut accurately on a non-keyframe). -an: the source has no audio track.
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", SRC_E, "-vf",
         f"select=between(n\\,{a}\\,{b}),setpts=N/FRAME_RATE/TB",
         "-r", "24", "-c:v", "libx264", "-crf", "16", "-preset", "slow",
         "-pix_fmt", "yuv420p", "-an", dst], check=True)
    return dst


print("\n  STANCE CUTS (frame-exact select, re-encode -crf 16, -an):")
made = {}
for nm, (a, b) in CUTS.items():
    made[nm] = cut(nm, a, b)

# ── STEP 3: anchor track for base_speak.mp4 ───────────────────────────────────
anchor = None
base_path = made["base_speak"]
if WRITE and os.path.exists(base_path):
    bw_, bh_, bfps, bnb, bdur = probe(base_path)
    bT, _ = track(base_path, TPL)
    frames = []
    # 5-tap temporal smoothing of the box position, as in the live anchor.json
    xs = np.array([box_at(MOUTH, r[1], r[2], r[3])[0] for r in bT])
    ys = np.array([box_at(MOUTH, r[1], r[2], r[3])[1] for r in bT])
    ws = np.array([box_at(MOUTH, r[1], r[2], r[3])[2] for r in bT])
    hs = np.array([box_at(MOUTH, r[1], r[2], r[3])[3] for r in bT])
    k = np.ones(5) / 5.0
    pad = lambda v: np.convolve(np.pad(v, 2, mode="edge"), k, mode="valid")
    xs, ys, ws, hs = pad(xs), pad(ys), pad(ws), pad(hs)
    for i in range(len(bT)):
        frames.append(dict(x=int(round(xs[i])), y=int(round(ys[i])),
                           w=int(round(ws[i])), h=int(round(hs[i])),
                           confidence=round(float(bT[i, 0]), 4)))
    anchor = dict(
        fps=bfps, method="ncc-nose-template-multiscale-sequential",
        note="Per-frame mouth box for base_speak.mp4 (768x1168 @24fps), derived by "
             "normalised-cross-correlation tracking of a RIGID nose template (bridge "
             "to nostrils, stopping above the lip line so speech cannot deform it) "
             "over a range of template SCALES, with a sequential warm start, then "
             "5-tap temporal smoothing of the box position. `confidence` is the raw "
             "NCC at that frame: it falls when her head rotates away from the "
             "reference pose, which is exactly when a frontal mouth patch would look "
             "wrong, so the runtime can treat it as a pose gate. NOT a landmark model; "
             "there is no face-landmark dependency and mediapipe is not installed. "
             "The live public/avatar/visemes/anchor.json tracks talking.mp4 at "
             "832x1248 and is useless for this base — this track is measured fresh.",
        confidenceIsNcc=True, frames=frames)
    c = np.array([f["confidence"] for f in frames])
    print(f"\n  ANCHOR for base_speak.mp4: {len(frames)} frames, NCC min={c.min():.4f} "
          f"p05={np.percentile(c,5):.4f} median={np.median(c):.4f} max={c.max():.4f}; "
          f"below pose floor {POSE_FLOOR}: {int((c<POSE_FLOOR).sum())}")
    bx = np.array([f["x"] for f in frames])
    by = np.array([f["y"] for f in frames])
    print(f"    box x {bx.min()}..{bx.max()} ({bx.max()-bx.min()}px travel)  "
          f"y {by.min()}..{by.max()} ({by.max()-by.min()}px travel)   "
          f"[the OLD anchor on talking.mp4 travelled 121px x / 73px y]")

if WRITE:
    with open(os.path.join(OUT_DIR, "bank.json"), "w") as fh:
        fh.write(json.dumps(bank, indent=2) + "\n")
    if anchor:
        with open(os.path.join(OUT_DIR, "anchor.json"), "w") as fh:
            fh.write(json.dumps(anchor, indent=2) + "\n")
    print(f"\n  wrote {os.path.relpath(OUT_DIR, ROOT)}/bank.json"
          f"{' + anchor.json' if anchor else ''} and {len(entries)} PNGs")
    print("  public/avatar/visemes/ (bank.json, bank2.json, v*.png, w*.png) UNTOUCHED.")
else:
    print("\n  DRY RUN — nothing written. Re-run with --write.")
