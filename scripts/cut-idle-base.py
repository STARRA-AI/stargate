#!/usr/bin/env python3
"""
cut-idle-base.py — cut the deck's base loop (552x720 @24fps, EXACTLY 266 frames)
from an InfiniteTalk render of her LISTENING, landing her nose where the shipped
base_loop.mp4 had it, and MEASURE everything the client and the tests need.

WHY (2026-09-22). Classic set the bar at the InfiniteTalk clips. The free real-time
face is base_loop.mp4 + composited mouth patches; the old base was cut from a take
where she sits at rest for 11s with 10x18px of head travel. This replaces it with
an InfiniteTalk render of her listening — blinks, breath, the small live head
motion of a real person — while the mouth bank is cut from a SPEAKING render of
the same portrait (build-viseme-bank-3.py --src ...). Same portrait, same model,
same lighting family, so the two register tightly.

WHAT IT KEEPS FIXED, ON PURPOSE. 552x720, 24fps, 266 frames, and the nose at the
same on-screen position and size as the shipped loop (273.5, 213.5 in base px,
e-heavy nose at scale 0.625 — from build-viseme-bank-3.py --v4's rigid mapping).
That keeps V4_BOX, BASE_LOOP_FRAMES, the clip map's 11083ms, the drift-table
contract and the anatomy tests' WINDOWS all valid; only the measured VALUES
(drift, nose baseline) change, and this script emits the new ones.

OUTPUTS (--out DIR):
  base_loop.mp4          552x720 24fps 266 frames, libx264 crf 16, no audio
  base_loop_frame0.jpg   frame 0 as a real image (the hero still)
  base_measure.json      anchor, crop, per-frame drift (dx,dy,ncc), nose baseline
                         per frame (the test's exact method), seam report

MEASUREMENT PARITY. Drift = template match of the base's OWN frame-0 nose window
into every frame, relative to frame 0 (viseme-sync.ts BASE_DRIFT_X/Y were made the
same way). Nose baseline = measure_mouth_alignment.py nose_baseline(): window
x 235..325, y 208..248 riding driftY, dark = luminance < 0.52 x window median,
open 2x2, components with area >= 12, lowest bottom edge.

    python3 scripts/cut-idle-base.py --src idle.mp4 --out DIR [--write]

$0, offline: ffmpeg + numpy + cv2. --write is required to emit files.
"""
import argparse
import json
import os
import subprocess
import sys

import cv2
import numpy as np

# e heavy reference nose (build-viseme-bank-3.py) and where the v4 mapping put it
EH_NOSE = (330, 300, 100, 85)
BASE_W, BASE_H, BASE_FPS, BASE_FRAMES = 552, 720, 24, 266
BASE_NOSE_CENTRE = (273.5, 213.5)
BASE_NOSE_SCALE = 0.625

# measure_mouth_alignment.py windows (frame-0 base coords)
NOSE_X0, NOSE_X1 = 235, 325
NOSE_Y0, NOSE_Y1 = 208, 248


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                          "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
                          "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout.strip()
    w, h, fr, nb = out.split(",")
    n, d = fr.split("/")
    return int(w), int(h), float(n) / float(d), int(nb) if nb.isdigit() else 0


def decode(path, w, h):
    n = w * h * 3
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo",
                          "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    try:
        while True:
            b = p.stdout.read(n)
            if len(b) < n:
                break
            yield np.frombuffer(b, np.uint8).reshape(h, w, 3)
    finally:
        p.stdout.close()
        p.wait()


def match_scaled(gray, tpl, scales):
    best = (-2.0, 0.0, 0.0, 1.0)
    for s in scales:
        tw, th = int(round(tpl.shape[1] * s)), int(round(tpl.shape[0] * s))
        if tw < 8 or th < 8 or tw >= gray.shape[1] or th >= gray.shape[0]:
            continue
        t = cv2.resize(tpl, (tw, th), interpolation=cv2.INTER_AREA)
        r = cv2.matchTemplate(gray, t, cv2.TM_CCOEFF_NORMED)
        _, mx, _, ml = cv2.minMaxLoc(r)
        if mx > best[0]:
            best = (float(mx), ml[0] + tw / 2.0, ml[1] + th / 2.0, float(s))
    return best


def nose_baseline(img, dy):
    """measure_mouth_alignment.py nose_baseline(), verbatim in method."""
    y0, y1 = NOSE_Y0 + dy, NOSE_Y1 + dy
    win = img[y0:y1, NOSE_X0:NOSE_X1]
    if win.size == 0:
        return float("nan")
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
    return float("nan") if bottom is None else float(y0 + bottom)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--eheavy", default="/Users/starrallc/STARGATE/STARRA IS ALIVE!!!/e heavy.mp4")
    ap.add_argument("--nose-tpl", default=None)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--k", type=float, default=None,
                    help="render->base scale factor override. Default lands her nose at the SHIPPED "
                         "size (0.625/anchor). InfiniteTalk composes her right of centre, so at that "
                         "size the crop overruns the frame by ~58px; k=0.80 (a 9%% zoom) fits with the "
                         "nose 19px off-centre instead of 43.")
    ap.add_argument("--out-size", default=None,
                    help="WxH of the base (default 552x720). With --fit full the WHOLE render frame is "
                         "scaled into it: 768x1168 -> 552x840 keeps her waist-up, letterboxed by the "
                         "stage's object-fit: contain over her own blurred backdrop.")
    ap.add_argument("--fit", choices=["anchor", "full"], default="anchor",
                    help="anchor = crop so the nose lands where the shipped base had it (default); "
                         "full = no crop, the entire waist-up frame scaled to --out-size (Classic: "
                         "'WE WANT HER FROM THE WAIST UP', 2026-09-22).")
    ap.add_argument("--window-by", choices=["seam", "calm", "frontal", "steady"], default="seam",
                    help="seam = the window whose wrap is closest (default, for idle footage); "
                         "calm = the window with the least head motion, then seam — for a SPEAKING "
                         "render, where the calmest 11s makes the steadiest talking body.")
    ap.add_argument("--seam-blend", type=int, default=0,
                    help="dissolve the last N output frames into the first N so the loop wrap has no "
                         "step. Drift and baseline are measured AFTER the blend, so the tables stay true.")
    a = ap.parse_args()

    w, h, fps, nb = probe(a.src)
    print(f"source {a.src}\n  {w}x{h} @ {fps:.3f}fps nb_frames={nb}")
    frames = list(decode(a.src, w, h))
    N = len(frames)
    print(f"  decoded {N} frames ({N / fps:.2f}s)")

    if a.nose_tpl and os.path.exists(a.nose_tpl):
        tpl = cv2.imread(a.nose_tpl, cv2.IMREAD_GRAYSCALE)
    else:
        f0 = next(decode(a.eheavy, 768, 1168))
        x, y, tw, th = EH_NOSE
        tpl = cv2.cvtColor(f0[y:y + th, x:x + tw], cv2.COLOR_BGR2GRAY)

    # ── 1. anchor + crop ─────────────────────────────────────────────────────
    g0 = cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY)
    ncc, cx, cy, s = match_scaled(g0, tpl, np.arange(0.60, 1.61, 0.05))
    ncc, cx, cy, s = match_scaled(g0, tpl, np.arange(max(0.3, s - 0.08), s + 0.081, 0.01))
    global BASE_W, BASE_H, NOSE_X0, NOSE_X1, NOSE_Y0, NOSE_Y1
    if a.out_size:
        BASE_W, BASE_H = (int(t) for t in a.out_size.lower().split("x"))
    if a.fit == "full":
        # the whole frame, uniformly scaled: k is fixed by the width, the height
        # follows (768x1168 -> 552x840 keeps the render's aspect to 1px)
        k = BASE_W / w
        if abs(h * k - BASE_H) > 1.0:
            sys.exit(f"refusing: --fit full needs --out-size with the render's aspect "
                     f"({w}x{h} -> {BASE_W}x{round(h * k)}), got {BASE_W}x{BASE_H}")
        cw, ch = float(w), float(h)
        cx0 = cy0 = 0.0
    else:
        k = a.k if a.k else BASE_NOSE_SCALE / s    # render px -> base px
        cw, ch = BASE_W / k, BASE_H / k           # crop size in render px
        cx0 = cx - BASE_NOSE_CENTRE[0] / k
        cy0 = cy - BASE_NOSE_CENTRE[1] / k
    # clamp to the frame; report how far the nose lands from the shipped spot
    cx0c = min(max(0.0, cx0), w - cw)
    cy0c = min(max(0.0, cy0), h - ch)
    nose_base = ((cx - cx0c) * k, (cy - cy0c) * k)
    # The nostril window rides the MEASURED nose. The shipped constants were
    # (235..325, 208..248) around a nose at (273.5, 213.5): x -38.5..+51.5,
    # y -5.5..+34.5. Same offsets, new centre, so the baseline method is identical.
    # ...and SCALE with the face: those offsets were measured at k=0.625. At a
    # larger face the nostril mass extends further and a fixed-size window clips
    # it — measured 2026-09-22: half the frames returned exactly the window's
    # bottom edge (278) before this line existed.
    fs = k / BASE_NOSE_SCALE
    NOSE_X0, NOSE_X1 = int(round(nose_base[0] - 38.5 * fs)), int(round(nose_base[0] + 51.5 * fs))
    # The window BOTTOM stops well above the lip crease: with +34.5*fs it reached
    # y=283 on the full-frame base and the "baseline" came back as the upper lip's
    # dark line (ruler check 2026-09-22: nostrils end ~271, lip line ~283). +26*fs
    # ends at ~274 — below every nostril, 9px above the lip.
    NOSE_Y0, NOSE_Y1 = int(round(nose_base[1] - 5.5 * fs)), int(round(nose_base[1] + 26.0 * fs))
    print(f"  NOSTRIL WINDOW (follows the nose): x {NOSE_X0}..{NOSE_X1}  y {NOSE_Y0}..{NOSE_Y1} (+driftY)")
    print(f"  ANCHOR e-heavy nose: scale {s:.3f} centre ({cx:.1f},{cy:.1f}) NCC {ncc:.4f}")
    print(f"  CROP render px: x={cx0c:.1f} y={cy0c:.1f} w={cw:.1f} h={ch:.1f} (k={k:.4f}); "
          f"clamped by ({cx0c - cx0:+.1f},{cy0c - cy0:+.1f}) -> nose lands at "
          f"({nose_base[0]:.1f},{nose_base[1]:.1f}) vs shipped ({BASE_NOSE_CENTRE[0]},{BASE_NOSE_CENTRE[1]})")
    if cw > w or ch > h:
        sys.exit("refusing: the crop is larger than the source frame at the shipped scale")

    def to_base(fr):
        c = fr[int(round(cy0c)):int(round(cy0c + ch)), int(round(cx0c)):int(round(cx0c + cw))]
        return cv2.resize(c, (BASE_W, BASE_H), interpolation=cv2.INTER_AREA)

    # ── 2. 25fps -> 24fps by time, then a LOOP DISSOLVE that consumes the head ──
    # A loop that dissolves its tail into frames 0..n-1 and then restarts at frame 0
    # jumps back n frames of motion at the wrap (that was the first construction
    # here, and the wrap measured 2px). The correct construction: the OUTPUT begins
    # at source frame n, and the last n output frames fade into source frames
    # 0..n-1 — so frame 265 ~ source n-1 and frame 0 = source n: continuous.
    # This needs 266 + n source frames at 24fps. --seam-blend 0 = plain cut.
    n_out_total = int(np.floor((N - 1) / fps * BASE_FPS)) + 1
    src_idx = [min(N - 1, int(round(i / BASE_FPS * fps))) for i in range(n_out_total)]
    nblend = a.seam_blend
    need = BASE_FRAMES + nblend
    if n_out_total < need:
        sys.exit(f"refusing: {n_out_total} frames at {BASE_FPS}fps, need {need} for 266 + a {nblend}-frame dissolve")
    small = [cv2.resize(cv2.cvtColor(frames[j], cv2.COLOR_BGR2GRAY), (96, 146),
                        interpolation=cv2.INTER_AREA).astype(np.float32) for j in src_idx]
    # choose the window start so the raw wrap (frame need-1 -> frame 0 of the window)
    # is already as close as possible before any blending
    # per-source-frame head motion (render px), for --window-by calm
    motion = None
    frontal = None
    if a.window_by in ("frontal", "steady"):
        # per-source-frame multi-scale NCC of the render's own frame-0 nose; the
        # window that keeps the most frames above the pose floor wins.
        nx, ny = int(round(cx - tpl.shape[1] * s / 2)), int(round(cy - tpl.shape[0] * s / 2))
        nw_, nh_ = int(round(tpl.shape[1] * s)), int(round(tpl.shape[0] * s))
        own0 = g0[ny:ny + nh_, nx:nx + nw_]
        scs = {round(float(sc), 2): cv2.resize(own0, (max(8, int(round(nw_ * sc))), max(8, int(round(nh_ * sc)))),
                                               interpolation=cv2.INTER_AREA if sc < 1 else cv2.INTER_CUBIC)
               for sc in np.arange(0.92, 1.081, 0.02)}
        conf_all = []
        for fr in frames:
            g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
            x0_, y0_ = max(0, nx - 80), max(0, ny - 80)
            win_ = g[y0_:min(h, ny + nh_ + 80), x0_:min(w, nx + nw_ + 80)]
            bm = -2.0
            for t in scs.values():
                if win_.shape[0] < t.shape[0] or win_.shape[1] < t.shape[1]:
                    continue
                bm = max(bm, float(cv2.minMaxLoc(cv2.matchTemplate(win_, t, cv2.TM_CCOEFF_NORMED))[1]))
            conf_all.append(bm)
        frontal = [conf_all[j] for j in src_idx]
    if a.window_by == "calm":
        nx, ny = int(round(cx - tpl.shape[1] * s / 2)), int(round(cy - tpl.shape[0] * s / 2))
        nw_, nh_ = int(round(tpl.shape[1] * s)), int(round(tpl.shape[0] * s))
        own0 = g0[ny:ny + nh_, nx:nx + nw_]
        trk = []
        for fr in frames:
            g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
            x0_, y0_ = max(0, nx - 80), max(0, ny - 80)
            r = cv2.matchTemplate(g[y0_:min(h, ny + nh_ + 80), x0_:min(w, nx + nw_ + 80)], own0, cv2.TM_CCOEFF_NORMED)
            _, mx, _, ml = cv2.minMaxLoc(r)
            trk.append(((x0_ + ml[0]) - nx, (y0_ + ml[1]) - ny))
        motion = [trk[j] for j in src_idx]
    best = None
    for st in range(0, n_out_total - need + 1):
        seam = float(np.mean(np.abs(small[st + need - 1] - small[st])))
        if frontal is not None and a.window_by == "steady":
            # simulate the CLIENT's gate over this window: hysteresis (on >= 0.95,
            # off < 0.93), a 12-frame (500ms) dwell, emergency-off at <= 0.91. The
            # window with the FEWEST switches wins — measured 2026-09-22 the frontal
            # window switched 15x in 11s (a nod every 0.7s), which no gate can hide.
            gate, changed, sw = True, -999, 0
            for k_, c in enumerate(frontal[st:st + need]):
                want = True if c >= 0.95 else False if c < 0.93 else gate
                if want != gate and ((k_ - changed >= 12) or (not want and c <= 0.91)):
                    gate, changed, sw = want, k_, sw + 1
            below = sum(1 for c in frontal[st:st + need] if c < 0.93)
            score = sw * 100.0 + below + seam
        elif frontal is not None:
            below = sum(1 for c in frontal[st:st + need] if c < 0.93)
            score = below * 10.0 + seam
        elif motion is not None:
            xs = [m[0] for m in motion[st:st + need]]; ys = [m[1] for m in motion[st:st + need]]
            rng = (max(xs) - min(xs)) + (max(ys) - min(ys))
            score = rng * 1.0 + seam * 0.5
        else:
            score = seam
        if best is None or score < best[0]:
            best = (score, st, seam)
    _, st, seam = best
    if motion is not None:
        xs = [m[0] for m in motion[st:st + need]]; ys = [m[1] for m in motion[st:st + need]]
        print(f"  CALM WINDOW: head range dx {min(xs)}..{max(xs)} dy {min(ys)}..{max(ys)} render px over the window")
    if frontal is not None:
        below = sum(1 for c in frontal[st:st + need] if c < 0.93)
        gate, changed, sw = True, -999, 0
        for k_, c in enumerate(frontal[st:st + need]):
            want = True if c >= 0.95 else False if c < 0.93 else gate
            if want != gate and ((k_ - changed >= 12) or (not want and c <= 0.91)):
                gate, changed, sw = want, k_, sw + 1
        print(f"  {a.window_by.upper()} WINDOW: {need - below}/{need} source frames at NCC >= 0.93; simulated gate switches over the window: {sw}")
    win = src_idx[st:st + need]                       # need frames
    print(f"  WINDOW: {need} frames from out {st} (src {win[0]}..{win[-1]}), raw wrap seam mean|d| {seam:.2f}")
    win_base = [to_base(frames[j]) for j in win]
    body = win_base[nblend:nblend + BASE_FRAMES - nblend]      # source n .. 265
    tail = []
    for k in range(nblend):
        wgt = (k + 1) / (nblend + 1)                          # 0 -> 1, never quite 1: the NEXT frame (out 0 = src n) completes it
        t = win_base[BASE_FRAMES + k]                         # source 266+k
        h = win_base[k]                                       # source k
        tail.append(cv2.addWeighted(t, 1.0 - wgt, h, wgt, 0.0))
    base = body + tail
    assert len(base) == BASE_FRAMES, len(base)
    if nblend:
        print(f"  SEAM BLEND: last {nblend} frames dissolve into source 0..{nblend - 1}; output frame 0 is source {nblend}")

    # ── 3. per-frame drift: base frame 0's own nose window into every base frame ─
    gb0 = cv2.cvtColor(base[0], cv2.COLOR_BGR2GRAY)
    nw, nh = int(round(EH_NOSE[2] * BASE_NOSE_SCALE)), int(round(EH_NOSE[3] * BASE_NOSE_SCALE))
    nx0, ny0 = int(round(nose_base[0] - nw / 2)), int(round(nose_base[1] - nh / 2))
    own = gb0[ny0:ny0 + nh, nx0:nx0 + nw]
    # MULTI-SCALE, like the bank builder's tracker: a talking head zooms slightly
    # as it nods, and a single-scale match reads that as lost confidence. Measured
    # on the speaking render 2026-09-22: single-scale left 145/266 frames under
    # the 0.93 pose floor; the builder's scale-searching tracker rated 81% of the
    # same footage frontal. Offsets are still reported at the frame-0 scale.
    pad = 60
    own_scales = {round(float(sc), 2): cv2.resize(own, (max(8, int(round(nw * sc))), max(8, int(round(nh * sc)))),
                                                   interpolation=cv2.INTER_AREA if sc < 1 else cv2.INTER_CUBIC)
                  for sc in np.arange(0.92, 1.081, 0.02)}
    dx, dy, dn = [], [], []
    for fr in base:
        g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        x0, y0 = max(0, nx0 - pad), max(0, ny0 - pad)
        x1, y1 = min(BASE_W, nx0 + nw + pad), min(BASE_H, ny0 + nh + pad)
        win = g[y0:y1, x0:x1]
        bestm = (-2.0, 0, 0)
        for sc, t in own_scales.items():
            if win.shape[0] < t.shape[0] or win.shape[1] < t.shape[1]:
                continue
            r = cv2.matchTemplate(win, t, cv2.TM_CCOEFF_NORMED)
            _, mx, _, ml = cv2.minMaxLoc(r)
            if mx > bestm[0]:
                # centre-based offset so a scaled template reports the same nose centre
                bestm = (float(mx), int(round(x0 + ml[0] + t.shape[1] / 2 - (nx0 + nw / 2))),
                         int(round(y0 + ml[1] + t.shape[0] / 2 - (ny0 + nh / 2))))
        dn.append(bestm[0]); dx.append(bestm[1]); dy.append(bestm[2])
    # Inside the dissolve the frame is a blend of two heads (tail ~+7px, head ~0px),
    # so the template match snaps to whichever dominates and quantises 2px steps.
    # The blended mouth's centroid moves LINEARLY across a cross-fade, so a linear
    # ramp from the last body frame's drift to frame 0's (0,0) is the truthful table
    # there — and it is what keeps every step <= 1px, which the anatomy test requires
    # ("2px reads as jitter"). Body frames keep their measured values untouched.
    if nblend:
        b0 = BASE_FRAMES - nblend - 1
        for k in range(nblend):
            t = (k + 1) / (nblend + 1)
            dx[b0 + 1 + k] = int(round(dx[b0] * (1 - t)))
            dy[b0 + 1 + k] = int(round(dy[b0] * (1 - t)))
    steps = max(max(abs(np.diff(dx))), max(abs(np.diff(dy))))
    print(f"  DRIFT: dx {min(dx)}..{max(dx)}  dy {min(dy)}..{max(dy)}  max step {steps}px  "
          f"NCC {min(dn):.3f}..{max(dn):.3f}  wrap 265->0: ({dx[-1] - dx[0]},{dy[-1] - dy[0]})")

    # ── 4. nose baseline per frame, the test's method, riding driftY ────────────
    nb_y = [nose_baseline(base[i], dy[i]) for i in range(BASE_FRAMES)]
    nb_arr = np.array(nb_y)
    rel = nb_arr - np.array(dy)
    print(f"  NOSE BASELINE: {np.nanmin(nb_arr):.0f}..{np.nanmax(nb_arr):.0f} (drift-relative "
          f"{np.nanmin(rel):.0f}..{np.nanmax(rel):.0f}), nan frames {int(np.isnan(nb_arr).sum())}")

    report = dict(
        src=a.src, src_size=[w, h], src_fps=fps, src_frames=N,
        anchor=dict(scale=s, centre=[cx, cy], ncc=ncc),
        crop=dict(x=cx0c, y=cy0c, w=cw, h=ch, k=k, nose_in_base=list(nose_base),
                  shipped_nose=list(BASE_NOSE_CENTRE)),
        window=dict(out_start=st, out_total=n_out_total, src_first=win[0], src_last=win[-1], seam=seam),
        drift_x=dx, drift_y=dy, drift_ncc=[round(v, 4) for v in dn],
        nose_baseline_y=[None if np.isnan(v) else int(round(v)) for v in nb_y],
        nostril_window=dict(x0=NOSE_X0, x1=NOSE_X1, y0=NOSE_Y0, y1=NOSE_Y1),
        fit=a.fit,
        out=dict(width=BASE_W, height=BASE_H, fps=BASE_FPS, frames=BASE_FRAMES),
    )
    os.makedirs(a.out, exist_ok=True)
    def _np_safe(o):
        # numpy scalars/arrays sneak into the report through cv2/np math; JSON
        # cannot take them. tolist() gives plain Python numbers.
        if hasattr(o, "tolist"):
            return o.tolist()
        raise TypeError(f"not JSON serialisable: {type(o).__name__}")
    with open(os.path.join(a.out, "base_measure.json"), "w") as fh:
        json.dump(report, fh, indent=1, default=_np_safe)
    print(f"  wrote {a.out}/base_measure.json")

    if not a.write:
        print("  (dry run — pass --write to emit base_loop.mp4 + base_loop_frame0.jpg)")
        return
    mp4 = os.path.join(a.out, "base_loop.mp4")
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "bgr24",
                          "-s", f"{BASE_W}x{BASE_H}", "-r", str(BASE_FPS), "-i", "-",
                          "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
                          "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], stdin=subprocess.PIPE)
    for fr in base:
        p.stdin.write(np.ascontiguousarray(fr).tobytes())
    p.stdin.close(); p.wait()
    cv2.imwrite(os.path.join(a.out, "base_loop_frame0.jpg"), base[0], [cv2.IMWRITE_JPEG_QUALITY, 94])
    ww, hh, ff, nn = probe(mp4)
    print(f"  wrote {mp4}: {ww}x{hh} @{ff:.0f}fps {nn} frames; frame0 jpg written")


if __name__ == "__main__":
    main()
