#!/usr/bin/env python3
"""
build-anatomy-assets.py — builds STARRA's ANATOMY ASSETS.

    public/avatar/body/       base_loop.mp4 + gesture cuts + gestures.json
    public/avatar/visemes3/   bank.json + 15 viseme PNGs + anchor.json + gesture anchors

DRY RUN BY DEFAULT.  Pass --write to actually create files.
It only ever CREATES files inside those two NEW directories.  It never opens an existing
file under public/avatar for writing.

------------------------------------------------------------------------------------------
WHAT THIS BUILDS AND WHY (every constant below was MEASURED, not assumed — see PROVENANCE)
------------------------------------------------------------------------------------------
1. base_loop.mp4 — a PING-PONG loop of the base clip, frames 14..284 forward then 283..15
   back.  Ping-pong was chosen over a seam cut ON EVIDENCE:
     * best seam cut anywhere in the clip (all 289x289 frame pairs, min length 96f):
       frames 19->284, MAD 2.132 = 1.61x the clip's median adjacent-frame motion (1.323).
       An instantaneous 1.61x jump.
     * ping-pong: EVERY junction is a genuine adjacent frame pair, so the added
       discontinuity is exactly ZERO.  The two turnarounds were placed at the clip's
       lowest-motion frames: local motion 0.14x (f14) and 0.06x (f284) of median.
   The classic ping-pong hazard — a blink played backwards — DOES NOT EXIST here: the base
   clip contains NO blink.  Proven with a positive control (see PROVENANCE).

2. gesture_{smile,tilt,nod}.mp4 — cut neutral-to-neutral WITHIN their own clip.
   THESE ARE NOT BLEND-READY AGAINST base_loop.  Measured: their neutral frames differ
   from the nearest base_loop frame by 8.2-12.8 MAD, versus 1.12 for a natural adjacent
   frame — a 7-11x instantaneous jump, dominated by hair and jacket, which sit in a
   completely different configuration in every clip.  They are separate GENERATIONS, not
   alternate takes of one continuous body.  gestures.json records both numbers per cut.
   gesture_brow is NOT built: the brow clip has no neutral frame before its apex, and its
   framing is 1.165x so scale-matching leaves 14% of the canvas unfillable.

3. All geometry is normalised to ONE common face scale T=0.950 so every asset shares her
   face size and position.  T is the SMALLEST neutral framing scale across the clips, which
   makes every transform a DOWNSCALE — nothing is ever upscaled, interpolated or invented.

------------------------------------------------------------------------------------------
PROVENANCE — measured this session, on the source footage, with the method named
------------------------------------------------------------------------------------------
RIGID ANCHOR TEMPLATE = base frame 0, full-frame box (550,150)-(730,250).  That band is
brows+eyes+nose bridge+nostrils and STOPS ABOVE the upper lip (lip top ~252px), so neither
speech nor a blink deforms it.  Contrast std 53.16.
  -> A tighter nose-only crop was TRIED AND REJECTED: it is blown-out white (see
     scratchpad look/tpl_nose_tight.png), gave a degenerate scale estimate that slid to the
     search floor (0.850) while reporting NCC 1.0000.  Low contrast = no scale information.
  -> The chosen template reproduces the brief's independently-measured numbers for the base:
     head travel (10,17)px and scale drift 0.98..1.01.  That agreement is the validation.

NO BLINK IN THE BASE — differential eye-band deviation vs the per-pixel median, with a nose
band as control.  Base: max/median = 7.18/4.94 = 1.45x, no contiguous run above 2x.
POSITIVE CONTROL on 'e heavy', which is documented to contain one 250ms blink: the same
detector spikes to 3.70x median across frames 115-120 — exactly 6 frames at 24fps.  The
detector therefore does fire on a real blink and does not fire on the base.

NEUTRAL FRAMING SCALE per clip, measured only on frames where the gesture signal is at
baseline, with a rotation search confirming roll=0 at those frames:
    base 1.000 (definition) | smile 0.968 | brow 1.165 | tilt 0.950 | nod 0.970
Consequence: T = 0.950, and the output canvas is 570x684.  Filling 684 rows requires
720*T/s_neut >= 684, which brow (587 rows available) FAILS by 97 rows.

MOUTH BOX = template-relative (27.65, 72.55, 128, 92) at scale 1.0.  NOT eyeballed:
back-derived from all 15 boxes in public/avatar/visemes2/bank.json divided by this session's
independent e-heavy anchor track.  The 15 agree to within (3.7,2.8,6.0,4.5)px; median
box_rel (28.4,73.4,126.5,90.3), standardised to 128x92 about the same centre.  Two
independent trackers converging is the evidence.

E-HEAVY -> BASE SCALE = 0.652, measured BOTH directions:
  forward: the anchor template matches e heavy at scale 1.540 => 1/1.540 = 0.6494
  reverse: downscaling e heavy's eye band into base frame 0 peaks at k=0.652, NCC 0.9841
The brief's figure of 0.670 scores only 0.9682 and is ~2.7% off; 0.652 is used here.

SOURCE FOOTAGE — READ THIS
  Partway through the session that produced these measurements, four source files were
  DELETED from /Users/work/Desktop by something outside the build:
      4ff00ead.mp4 (THE BASE), 09d28038.mp4 (smile), 29fc2b70.mp4 (brow), 'e heavy.mp4'
  Their exact pixels survive as bit-exact FFV1/RGB recoveries (max abs diff 0 on read-back)
  in the scratchpad `recovered/` directory.  This script prefers the originals when present
  and falls back to those recoveries.  The two tilt/nod clips in ~/Downloads still exist.
"""

from __future__ import annotations
import argparse, json, os, subprocess, sys
import numpy as np

try:
    import cv2
except ImportError:
    sys.exit("cv2 required (installed system-wide; do NOT pip install anything)")

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BODY = os.path.join(REPO, "public", "avatar", "body")
V3 = os.path.join(REPO, "public", "avatar", "visemes3")
BANK2 = os.path.join(REPO, "public", "avatar", "visemes2", "bank.json")

# ---------------------------------------------------------------- measured constants
T = 0.950                 # common face scale: the SMALLEST neutral framing scale
OUT_W, OUT_H = 570, 684
TGT = (194.0, 142.0)      # anchor-template top-left, in OUT coords, for EVERY asset
ANCHOR_T = (550, 150, 730, 250)
MOUTH_REL = (27.65, 72.55, 128.0, 92.0)
FPS = 24.0
LOOP_A, LOOP_B = 14, 284   # ping-pong turnarounds (lowest-motion frames)
EH_SCALE = 1.540           # e heavy's framing scale in anchor-template units

# per-clip: neutral framing scale, neutral anchor position (full-frame px)
NEUT = {
    "base":  (1.000, (550.5, 150.0)),
    "smile": (0.968, (550.8, 153.4)),
    "tilt":  (0.950, (553.0, 152.5)),
    "nod":   (0.970, (550.6, 160.0)),
}
# gesture cuts: (in, out, apex) — neutral-to-neutral within their own clip
CUTS = {"smile": (21, 258, 126), "tilt": (129, 281, 193), "nod": (5, 192, 20)}

SOURCES = {
    "base":   ["/Users/work/Desktop/4ff00ead.mp4"],
    "smile":  ["/Users/work/Desktop/09d28038.mp4"],
    "brow":   ["/Users/work/Desktop/29fc2b70.mp4"],
    "tilt":   ["/Users/work/Downloads/hf_20260730_031201_1322fd7a-da06-400b-81a3-86300d7d9f37.mp4"],
    "nod":    ["/Users/work/Downloads/hf_20260730_035859_cec985d3-fc15-44d6-ad7f-349d5ca87531.mp4"],
    "eheavy": ["/Users/work/Desktop/e heavy.mp4"],
}
DIMS = {"eheavy": (768, 1168)}


def resolve(name: str, recovered_dir: str) -> str:
    for p in SOURCES[name]:
        if os.path.exists(p):
            return p
    alt = os.path.join(recovered_dir, f"{name}_RECOVERED_ffv1_rgb.mkv")
    if os.path.exists(alt):
        return alt
    raise SystemExit(f"source for {name!r} not found (tried {SOURCES[name]} and {alt})")


def decode(path: str, w: int, h: int) -> np.ndarray:
    """SEQUENTIAL decode only. -ss before -i is never used: fast seek produces false
    rainbow artifacts that read as corruption."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout
    n = len(raw) // (w * h * 3)
    if n * w * h * 3 != len(raw):
        raise SystemExit(f"{path}: decoded {len(raw)} bytes, not a multiple of {w}x{h}x3")
    return np.frombuffer(raw, np.uint8).reshape(n, h, w, 3)


def gray(a: np.ndarray) -> np.ndarray:
    return (0.299 * a[..., 0] + 0.587 * a[..., 1] + 0.114 * a[..., 2]).astype(np.float32)


def solve_geom(s_neut: float, anchor: tuple[float, float]) -> dict:
    k = T / s_neut
    Wsrc = int(round(OUT_W / k)); Hsrc = int(round(OUT_H / k))
    Wsrc -= Wsrc % 2; Hsrc -= Hsrc % 2
    Hsrc = min(Hsrc, 720); Wsrc = min(Wsrc, 1280)
    kx, ky = OUT_W / Wsrc, OUT_H / Hsrc
    ax, ay = anchor
    x0 = max(0, min(1280 - Wsrc, int(round(ax - TGT[0] / kx))))
    y0 = max(0, min(720 - Hsrc, int(round(ay - TGT[1] / ky))))
    return dict(k=k, Wsrc=Wsrc, Hsrc=Hsrc, kx=kx, ky=ky, x0=x0, y0=y0)


def align(frames: np.ndarray, g: dict) -> np.ndarray:
    out = np.empty((len(frames), OUT_H, OUT_W, 3), np.uint8)
    for i in range(len(frames)):
        c = frames[i][g["y0"]:g["y0"] + g["Hsrc"], g["x0"]:g["x0"] + g["Wsrc"]]
        out[i] = cv2.resize(c, (OUT_W, OUT_H), interpolation=cv2.INTER_AREA)
    return out


def track(frames: np.ndarray, tpl: np.ndarray, lo: float, hi: float, pad: int = 48):
    """Sequential warm-start multi-scale NCC track of the rigid anchor template."""
    th, tw = tpl.shape
    scales = np.arange(lo, hi + 1e-9, 0.005)
    tc = {round(float(s), 4): cv2.resize(
            tpl, (int(round(tw * s)), int(round(th * s))),
            interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC).astype(np.float32)
          for s in scales}
    H, W = frames.shape[1:3]
    g0 = gray(frames[0]); best = (-2.0, None, None)
    for s in scales:
        r = cv2.matchTemplate(g0, tc[round(float(s), 4)], cv2.TM_CCOEFF_NORMED)
        _, mx, _, ml = cv2.minMaxLoc(r)
        if mx > best[0]:
            best = (float(mx), float(s), (int(ml[0]), int(ml[1])))
    n = len(frames)
    S = np.zeros(n); X = np.zeros(n, int); Y = np.zeros(n, int); C = np.zeros(n)
    px, py = best[2]
    for i in range(n):
        gg = gray(frames[i])
        rx0, ry0 = max(0, px - pad), max(0, py - pad)
        rx1 = min(W, px + int(tw * hi) + pad); ry1 = min(H, py + int(th * hi) + pad)
        roi = gg[ry0:ry1, rx0:rx1]; bb = (-2.0, None, None)
        for s in scales:
            t = tc[round(float(s), 4)]
            if t.shape[0] >= roi.shape[0] or t.shape[1] >= roi.shape[1]:
                continue
            r = cv2.matchTemplate(roi, t, cv2.TM_CCOEFF_NORMED)
            _, mx, _, ml = cv2.minMaxLoc(r)
            if mx > bb[0]:
                bb = (float(mx), float(s), (rx0 + int(ml[0]), ry0 + int(ml[1])))
        if bb[1] is None:
            S[i], X[i], Y[i], C[i] = S[i - 1], X[i - 1], Y[i - 1], 0.0
            continue
        C[i], S[i] = bb[0], bb[1]; X[i], Y[i] = bb[2]; px, py = X[i], Y[i]
    return S, X, Y, C


def smooth5(v: np.ndarray) -> np.ndarray:
    v = np.asarray(v, float); out = v.copy()
    for i in range(len(v)):
        out[i] = v[max(0, i - 2):min(len(v), i + 3)].mean()
    return out


def anchor_json(S, X, Y, C, g, order, note):
    """Per-frame mouth box in OUT coords. Same shape as visemes2/anchor.json."""
    ox, oy, ow, oh = MOUTH_REL
    sx = smooth5(X.astype(float)); sy = smooth5(Y.astype(float))
    fr = []
    for i in order:
        s = S[i]
        axo = (sx[i] - g["x0"]) * g["kx"]; ayo = (sy[i] - g["y0"]) * g["ky"]
        fr.append(dict(
            x=int(round(axo + ox * s * g["kx"])), y=int(round(ayo + oy * s * g["ky"])),
            w=int(round(ow * s * g["kx"])), h=int(round(oh * s * g["ky"])),
            confidence=round(float(C[i]), 4)))
    return dict(fps=FPS, method="ncc-rigid-browsEyesNoseBand-multiscale-sequential-smoothed5",
                note=note, confidenceIsNcc=True, frames=fr)


def encode(path: str, arr, write: bool):
    if not write:
        print(f"    [dry-run] would write {path} ({len(arr)} frames {OUT_W}x{OUT_H})")
        return
    p = subprocess.Popen(
        ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{OUT_W}x{OUT_H}", "-r", str(FPS), "-i", "-",
         "-c:v", "libx264", "-preset", "veryslow", "-crf", "16",
         "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", path],
        stdin=subprocess.PIPE)
    for f in arr:
        p.stdin.write(np.ascontiguousarray(f).tobytes())
    p.stdin.close()
    if p.wait() != 0:
        raise SystemExit(f"ffmpeg failed writing {path}")
    print(f"    wrote {path} ({len(arr)} frames, {os.path.getsize(path)} bytes)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true", help="actually create files (default: dry run)")
    ap.add_argument("--recovered", default=os.path.join(
        "/private/tmp/claude-502/-Users-work/43e3aa80-c7d5-43ee-8ad8-63cd7f5c1ba8",
        "scratchpad", "anatomy", "recovered"))
    a = ap.parse_args()
    W = a.write
    print(f"{'WRITE' if W else 'DRY RUN'}  ->  {BODY}  and  {V3}")
    if W:
        os.makedirs(BODY, exist_ok=True); os.makedirs(V3, exist_ok=True)

    base_raw = decode(resolve("base", a.recovered), 1280, 720)
    x0, y0, x1, y1 = ANCHOR_T
    tpl = gray(base_raw[0])[y0:y1, x0:x1]
    print(f"anchor template {tpl.shape} contrast std {tpl.std():.2f}")

    geom = {nm: solve_geom(*v) for nm, v in NEUT.items()}

    # ---------------------------------------------------------------- 1. base loop
    print("\n[1] base_loop.mp4  (ping-pong)")
    gb = geom["base"]
    Sb, Xb, Yb, Cb = track(base_raw, tpl, 0.93, 1.07, pad=40)
    ab = align(base_raw, gb)
    order = list(range(LOOP_A, LOOP_B + 1)) + list(range(LOOP_B - 1, LOOP_A, -1))
    gg = gray(ab)
    nat = float(np.median([np.abs(gg[i + 1] - gg[i]).mean() for i in range(LOOP_A, LOOP_B)]))
    j1 = float(np.abs(gg[order[-1]] - gg[order[0]]).mean())
    j2 = float(np.abs(gg[order[LOOP_B - LOOP_A + 1]] - gg[order[LOOP_B - LOOP_A]]).mean())
    print(f"    {len(order)} frames ({len(order)/FPS:.2f}s). adjacent-frame MAD {nat:.3f}")
    print(f"    loop junction  MAD {j1:.3f} ({j1/nat:.2f}x)   turnaround MAD {j2:.3f} ({j2/nat:.2f}x)")
    encode(os.path.join(BODY, "base_loop.mp4"), (ab[i] for i in order), W)
    aj = anchor_json(Sb, Xb, Yb, Cb, gb, order,
        "Per-frame mouth box for body/base_loop.mp4 (570x684 @24fps, 540 frames, PING-PONG "
        "of source frames 14..284 then 283..15). Rigid brows+eyes+nose-bridge template "
        "(stops above the lip line so speech and blinks cannot deform it), multi-scale NCC, "
        "sequential warm start, 5-tap smoothing of position. `confidence` is the raw NCC and "
        "doubles as a pose gate. Coordinates are in the 570x684 OUTPUT frame.")
    if W:
        with open(os.path.join(V3, "anchor.json"), "w") as f:
            json.dump(aj, f, indent=1)
        print(f"    wrote {V3}/anchor.json ({len(aj['frames'])} frames)")
    cs = np.array([f["confidence"] for f in aj["frames"]])
    bx = np.array([f["x"] for f in aj["frames"]]); by = np.array([f["y"] for f in aj["frames"]])
    print(f"    anchor confidence min {cs.min():.4f} p5 {np.percentile(cs,5):.4f} "
          f"median {np.median(cs):.4f} | box travel x {bx.max()-bx.min()} y {by.max()-by.min()} px")

    # ---------------------------------------------------------------- 2. gestures
    print("\n[2] gesture cuts  (NOT blend-ready against base_loop — see MAD vs base)")
    BF = gray(ab[LOOP_A:LOOP_B + 1]).reshape(LOOP_B - LOOP_A + 1, -1)
    meta = {}
    for nm, (ci, co, apex) in CUTS.items():
        raw = decode(resolve(nm, a.recovered), 1280, 720)
        g = geom[nm]
        S, X, Y, C = track(raw, tpl, NEUT[nm][0] - 0.04, NEUT[nm][0] + 0.06, pad=48)
        al = align(raw, g)
        ga = gray(al); gm = ga.reshape(len(ga), -1)
        natg = float(np.median([np.abs(ga[i + 1] - ga[i]).mean() for i in range(len(ga) - 1)]))
        within = float(np.abs(gm[ci] - gm[co]).mean())
        d_in = np.abs(BF - gm[ci]).mean(axis=1); d_out = np.abs(BF - gm[co]).mean(axis=1)
        meta[nm] = dict(
            cutIn=ci, cutOut=co, apex=apex, frames=co - ci + 1,
            seconds=round((co - ci + 1) / FPS, 3),
            withinClipFirstVsLastMAD=round(within, 3),
            withinClipXAdjacent=round(within / natg, 2),
            adjacentFrameMAD=round(natg, 3),
            firstVsBaseLoopMAD=round(float(d_in.min()), 2),
            firstVsBaseLoopBestFrame=int(LOOP_A + d_in.argmin()),
            lastVsBaseLoopMAD=round(float(d_out.min()), 2),
            lastVsBaseLoopBestFrame=int(LOOP_A + d_out.argmin()),
            baseAdjacentFrameMAD=round(nat, 3),
            blendReadyAgainstBase=False,
            whyNot=("hair and jacket sit in a different configuration: this is a separate "
                    "generation, not another take of the same body"))
        print(f"    {nm}: {ci}..{co} ({co-ci+1}f {(co-ci+1)/FPS:.2f}s) "
              f"within-clip {within:.3f} ({within/natg:.2f}x) | "
              f"vs base first {d_in.min():.2f} last {d_out.min():.2f} "
              f"({d_in.min()/nat:.1f}x/{d_out.min()/nat:.1f}x adjacent)")
        encode(os.path.join(BODY, f"gesture_{nm}.mp4"), (al[i] for i in range(ci, co + 1)), W)
        gj = anchor_json(S, X, Y, C, g, list(range(ci, co + 1)),
            f"Per-frame mouth box for body/gesture_{nm}.mp4 (570x684 @24fps, source frames "
            f"{ci}..{co}). Same rigid-template NCC method as visemes3/anchor.json, so the "
            f"mouth patch can keep tracking her face THROUGH the gesture instead of being "
            f"disabled during it. Coordinates are in the 570x684 OUTPUT frame.")
        if W:
            with open(os.path.join(V3, f"anchor_gesture_{nm}.json"), "w") as f:
                json.dump(gj, f, indent=1)
        gc = np.array([f["confidence"] for f in gj["frames"]])
        print(f"        anchor conf min {gc.min():.4f} p5 {np.percentile(gc,5):.4f} median {np.median(gc):.4f}")
        del raw, al, ga, gm
    meta["_brow"] = dict(built=False, reasons=[
        "no neutral frame exists BEFORE its apex (apex f61; earliest neutral run starts f152), "
        "so it cannot be cut neutral-to-neutral",
        "neutral framing scale 1.165 vs base 1.000: after scale-matching it fills only 587 of "
        "684 canvas rows, and the missing 97 rows cannot be filled without inventing pixels"])
    meta["_geometry"] = dict(commonFaceScaleT=T, outW=OUT_W, outH=OUT_H,
                             targetAnchorTopLeft=list(TGT), perClip=geom)
    if W:
        with open(os.path.join(BODY, "gestures.json"), "w") as f:
            json.dump(meta, f, indent=1)
        print(f"    wrote {BODY}/gestures.json")

    # ---------------------------------------------------------------- 3. viseme bank
    print("\n[3] visemes3  (bank re-cut from e heavy at the base's scale)")
    eh = decode(resolve("eheavy", a.recovered), *DIMS["eheavy"])
    b2 = json.load(open(BANK2))
    k_eh = T / EH_SCALE                                   # 0.61688 — a DOWNSCALE
    src_w = int(round(MOUTH_REL[2] * EH_SCALE)); src_h = int(round(MOUTH_REL[3] * EH_SCALE))
    tw = int(round(MOUTH_REL[2] * T)); th_ = int(round(MOUTH_REL[3] * T))
    print(f"    e heavy {src_w}x{src_h}  --INTER_AREA-->  {tw}x{th_}   "
          f"(k={tw/src_w:.4f}, one resample from the original)")
    out_frames = []
    for e in b2["frames"]:
        bx0 = e["box"]["x"] + e["box"]["w"] / 2.0; by0 = e["box"]["y"] + e["box"]["h"] / 2.0
        sx = int(round(bx0 - src_w / 2.0)); sy = int(round(by0 - src_h / 2.0))
        sx = max(0, min(DIMS["eheavy"][0] - src_w, sx))
        sy = max(0, min(DIMS["eheavy"][1] - src_h, sy))
        crop = eh[e["sourceFrame"]][sy:sy + src_h, sx:sx + src_w]
        small = cv2.resize(crop, (tw, th_), interpolation=cv2.INTER_AREA)
        if W:
            cv2.imwrite(os.path.join(V3, e["id"] + ".png"), small[:, :, ::-1])
        n = dict(e)
        n["file"] = f"/avatar/visemes3/{e['id']}.png"
        n["sourceClip"] = "e heavy.mp4 (768x1168 @24fps, 361 frames)"
        n["sourceBox"] = dict(x=sx, y=sy, w=src_w, h=src_h)
        n["sourceScale"] = EH_SCALE
        n["targetScale"] = T
        n["resampleFactor"] = round(tw / src_w, 5)
        n["box"] = dict(x=None, y=None, w=tw, h=th_)   # per-frame x/y come from anchor.json
        n["boxInBaseCoords"] = dict(
            offsetX=round(MOUTH_REL[0] * T, 2), offsetY=round(MOUTH_REL[1] * T, 2),
            w=tw, h=th_,
            note="add offsetX/offsetY to the anchor-template top-left in OUT coords; or just "
                 "use visemes3/anchor.json which already has the absolute per-frame box")
        n["scaleMatchesBase"] = True
        out_frames.append(n)
    bank = dict(
        version=3, builder="scripts/build-anatomy-assets.py",
        source="/avatar/body/base_loop.mp4",
        sourceFootage=b2["sourceFootage"],
        width=tw, height=th_, fps=FPS,
        poseFloor=b2.get("poseFloor", 0.93), axes=b2["axes"], closedId=b2["closedId"],
        sourceScale=EH_SCALE, targetScale=T, resampleFactor=round(tw / src_w, 5),
        rescaleNote=(
            "Each entry is ONE INTER_AREA downscale of the ORIGINAL e heavy frame — crop "
            f"{src_w}x{src_h} then resize to {tw}x{th_}. Not a crop of the visemes2 PNGs, so "
            "there is no resample chain. Nothing is upscaled, interpolated or synthesised. "
            "The e-heavy->base factor 0.652 was measured in both directions (forward 1/1.540="
            "0.6494; reverse peak k=0.652 at NCC 0.9841). The brief's 0.670 scores 0.9682."),
        versionNote=(
            "version:3 matches public/avatar/visemes2/bank.json. NOTE FOR THE RUNTIME: "
            "parseVisemeBank2() in src/lib/voice/viseme-sync.ts rejects anything whose "
            "version is not exactly 2, so a v3 file needs a v3 parser or a version remap."),
        coverage=b2["coverage"], frames=out_frames)
    if W:
        with open(os.path.join(V3, "bank.json"), "w") as f:
            json.dump(bank, f, indent=1)
        print(f"    wrote {V3}/bank.json + {len(out_frames)} PNGs")
    else:
        print(f"    [dry-run] would write bank.json + {len(out_frames)} PNGs")
    print("\ndone.")


if __name__ == "__main__":
    main()
