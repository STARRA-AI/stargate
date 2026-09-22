#!/usr/bin/env python3
"""
measure-speaking-render.py — MEASURE an InfiniteTalk render of her before cutting
anything from it. Read-only. Writes one JSON report to --out.

WHY THIS EXISTS (2026-09-22). Classic set the bar: the live call must look like the
InfiniteTalk clips. The free real-time face is base_loop.mp4 + composited mouth
patches, so the way to get there without a GPU or a per-minute bill is to cut
BOTH the base loop AND the mouth bank from ONE InfiniteTalk render of her actually
speaking. Before any cut, three numbers decide the plan and they must be measured,
not assumed:

  1. WHERE HER FACE IS in the new footage, relative to the shipped base_loop.mp4.
     Solved by matching the e-heavy NOSE template (the one build-viseme-bank-3.py
     tracks with, 100x85 at (330,300) on e heavy frame 0) into the render's frame 0
     over a scale range. Speech cannot deform the nose, so it is the rigid anchor.
     The shipped v4 mapping puts that same nose at (273.5, 213.5) in base_loop
     pixels at scale 0.625 — so a crop that lands the new nose there, at the same
     on-screen size, keeps V4_BOX, the drift-table contract, BASE_LOOP_FRAMES and
     every test unchanged.

  2. HOW MUCH HER HEAD MOVES, frame by frame. The client follows base_loop's head
     with BASE_DRIFT_X/Y (viseme-sync.ts) — per-frame nose offsets relative to
     frame 0, measured by template match. A new base needs a new table, produced
     the same way. This script measures it for the whole render.

  3. HOW STILL AND HOW SHUT SHE IS IN THE PADDED SILENCE (1.5s head, 2.0s tail).
     If InfiniteTalk holds her mouth at rest and her head steady while the audio is
     silent, an 11-second silence-only render is the cleanest possible base loop
     (genuine idle motion: blinks, breath, sway). If it does not, the base has to
     be assembled from this render's own idle stretches instead. The aperture and
     drift numbers over the silent frames are what decide that.

Aperture is measured the way the bank builder measures it, in spirit: inside the
mouth window (the e-heavy MOUTH box carried through the same nose transform), the
tallest run of dark, non-skin pixels down the centre columns. Same threshold idea
(L below a fraction of the skin's L), no landmark model, no learned anything.

    python3 scripts/measure-speaking-render.py --src render.mp4 --out report.json \
        [--silence-head 1.5 --silence-tail 2.0] [--nose-tpl path] [--frame0 path]

Needs ffmpeg, numpy, cv2 (the scratch venv). $0, offline.
"""
import argparse
import json
import os
import subprocess
import sys

import cv2
import numpy as np

# ── e heavy reference geometry, from build-viseme-bank-3.py (measured there) ──
EH_W, EH_H = 768, 1168
EH_NOSE = (330, 300, 100, 85)          # x, y, w, h on e heavy frame 0
EH_MOUTH = (288, 358, 196, 140)
# Where the v4 rigid mapping put that nose in the shipped 552x720 base_loop
# (printed by build-viseme-bank-3.py --v4 this session): scale 0.625, centre
# (273.5, 213.5), NCC 0.9822.
BASE_W, BASE_H = 552, 720
BASE_NOSE_CENTRE = (273.5, 213.5)
BASE_NOSE_SCALE = 0.625               # e-heavy px -> base px


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate,nb_frames",
         "-of", "csv=p=0", path], capture_output=True, text=True, check=True).stdout.strip()
    w, h, fr, nb = out.split(",")
    num, den = fr.split("/")
    return int(w), int(h), float(num) / float(den), int(nb) if nb.isdigit() else None


def decode(path, w, h):
    """Sequential BGR frames via ffmpeg rawvideo — no seeks, no drift."""
    n = w * h * 3
    p = subprocess.Popen(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo",
                          "-pix_fmt", "bgr24", "-"], stdout=subprocess.PIPE)
    try:
        while True:
            buf = p.stdout.read(n)
            if len(buf) < n:
                break
            yield np.frombuffer(buf, np.uint8).reshape(h, w, 3)
    finally:
        p.stdout.close()
        p.wait()


def match_scaled(gray, tpl, scales):
    """Best (ncc, cx, cy, scale) of tpl in gray over the scale range."""
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


def aperture_px(bgr_mouth):
    """Tallest dark non-skin run down the centre columns of the mouth window."""
    lab = cv2.cvtColor(bgr_mouth, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = lab[:, :, 0]
    h, w = L.shape
    # skin reference: a band just under the nose, top of the window
    skin = float(np.median(L[max(0, h // 10):max(1, h // 4), w // 3:2 * w // 3]))
    if skin <= 1:
        return 0.0
    dark = L < 0.62 * skin
    best = 0
    for c in range(w // 2 - 10, w // 2 + 11):
        col = np.nonzero(dark[:, c])[0]
        if len(col) == 0:
            continue
        run = start = prev = col[0]
        for v in col[1:]:
            if v - prev <= 6:
                prev = v
            else:
                best = max(best, prev - start + 1)
                start = prev = v
        best = max(best, prev - start + 1)
    return float(best)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--nose-tpl", default=None, help="PNG of the e-heavy nose (default: cut from --eheavy)")
    ap.add_argument("--eheavy", default="/Users/starrallc/STARGATE/STARRA IS ALIVE!!!/e heavy.mp4")
    ap.add_argument("--silence-head", type=float, default=1.5)
    ap.add_argument("--silence-tail", type=float, default=2.0)
    a = ap.parse_args()

    w, h, fps, nb = probe(a.src)
    print(f"source {a.src}\n  {w}x{h} @ {fps:.3f}fps nb_frames={nb}")

    # nose template
    if a.nose_tpl and os.path.exists(a.nose_tpl):
        tpl = cv2.imread(a.nose_tpl, cv2.IMREAD_GRAYSCALE)
    else:
        f0 = next(decode(a.eheavy, EH_W, EH_H))
        x, y, tw, th = EH_NOSE
        tpl = cv2.cvtColor(f0[y:y + th, x:x + tw], cv2.COLOR_BGR2GRAY)

    frames = list(decode(a.src, w, h))
    N = len(frames)
    print(f"  decoded {N} frames")
    g0 = cv2.cvtColor(frames[0], cv2.COLOR_BGR2GRAY)

    # 1. anchor: e-heavy nose -> render frame 0 (coarse then fine scale search)
    ncc, cx, cy, s = match_scaled(g0, tpl, np.arange(0.60, 1.61, 0.05))
    ncc, cx, cy, s = match_scaled(g0, tpl, np.arange(max(0.3, s - 0.08), s + 0.081, 0.01))
    print(f"  ANCHOR e-heavy nose in render f0: scale {s:.3f} centre ({cx:.1f},{cy:.1f}) NCC {ncc:.4f}")

    # crop that lands the nose at the shipped base position/size:
    # render px -> base px factor k = BASE_NOSE_SCALE / s  (e-heavy->base over e-heavy->render)
    k = BASE_NOSE_SCALE / s
    crop_w, crop_h = BASE_W / k, BASE_H / k
    crop_x = cx - BASE_NOSE_CENTRE[0] / k
    crop_y = cy - BASE_NOSE_CENTRE[1] / k
    fits = crop_x >= 0 and crop_y >= 0 and crop_x + crop_w <= w and crop_y + crop_h <= h
    print(f"  CROP for a 552x720 base with the nose where the shipped one is: "
          f"x={crop_x:.1f} y={crop_y:.1f} w={crop_w:.1f} h={crop_h:.1f} (k={k:.4f}) fits={fits}")

    # 2. per-frame rigid drift: render's OWN frame-0 nose crop into every frame (render px)
    nx0, ny0 = int(round(cx - tpl.shape[1] * s / 2)), int(round(cy - tpl.shape[0] * s / 2))
    nw, nh = int(round(tpl.shape[1] * s)), int(round(tpl.shape[0] * s))
    own = g0[ny0:ny0 + nh, nx0:nx0 + nw]
    pad = 60
    drift = []
    for i, fr in enumerate(frames):
        g = cv2.cvtColor(fr, cv2.COLOR_BGR2GRAY)
        x0, y0 = max(0, nx0 - pad), max(0, ny0 - pad)
        x1, y1 = min(w, nx0 + nw + pad), min(h, ny0 + nh + pad)
        r = cv2.matchTemplate(g[y0:y1, x0:x1], own, cv2.TM_CCOEFF_NORMED)
        _, mx, _, ml = cv2.minMaxLoc(r)
        dx, dy = (x0 + ml[0]) - nx0, (y0 + ml[1]) - ny0
        drift.append((int(dx), int(dy), float(mx)))

    # 3. aperture per frame inside the carried-through mouth window (render px)
    mxr = cx + (EH_MOUTH[0] + EH_MOUTH[2] / 2 - (EH_NOSE[0] + EH_NOSE[2] / 2)) * s
    myr = cy + (EH_MOUTH[1] + EH_MOUTH[3] / 2 - (EH_NOSE[1] + EH_NOSE[3] / 2)) * s
    mw, mh = int(round(EH_MOUTH[2] * s)), int(round(EH_MOUTH[3] * s))
    ap_px = []
    for i, fr in enumerate(frames):
        dx, dy, _ = drift[i]
        x0 = int(round(mxr - mw / 2 + dx)); y0 = int(round(myr - mh / 2 + dy))
        x0 = max(0, min(w - mw, x0)); y0 = max(0, min(h - mh, y0))
        ap_px.append(aperture_px(fr[y0:y0 + mh, x0:x0 + mw]))

    ap_arr = np.array(ap_px)
    ddx = np.array([d[0] for d in drift]); ddy = np.array([d[1] for d in drift])
    dncc = np.array([d[2] for d in drift])

    head_n = int(round(a.silence_head * fps)); tail_n = int(round(a.silence_tail * fps))
    sil = np.zeros(N, bool); sil[:head_n] = True; sil[N - tail_n:] = True
    spk = ~sil

    def stats(mask, label):
        if not mask.any():
            return None
        d = dict(frames=int(mask.sum()),
                 aperture_px=dict(min=float(ap_arr[mask].min()), median=float(np.median(ap_arr[mask])),
                                  p90=float(np.percentile(ap_arr[mask], 90)), max=float(ap_arr[mask].max())),
                 drift_px=dict(dx_range=[int(ddx[mask].min()), int(ddx[mask].max())],
                               dy_range=[int(ddy[mask].min()), int(ddy[mask].max())],
                               max_step=int(max(np.abs(np.diff(ddx[mask])).max() if mask.sum() > 1 else 0,
                                                np.abs(np.diff(ddy[mask])).max() if mask.sum() > 1 else 0)),
                               ncc_min=float(dncc[mask].min())))
        print(f"  {label:9s}: {d['frames']:3d} frames | aperture median {d['aperture_px']['median']:.0f}px "
              f"p90 {d['aperture_px']['p90']:.0f} max {d['aperture_px']['max']:.0f} | drift dx {d['drift_px']['dx_range']} "
              f"dy {d['drift_px']['dy_range']} step<= {d['drift_px']['max_step']} ncc>= {d['drift_px']['ncc_min']:.3f}")
        return d

    print("\n  SILENCE vs SPEECH (the numbers that decide the base-loop plan):")
    s_sil = stats(sil, "silence")
    s_spk = stats(spk, "speech")

    report = dict(
        src=a.src, width=w, height=h, fps=fps, frames=N,
        anchor=dict(scale=s, centre=[cx, cy], ncc=ncc,
                    crop_for_base=dict(x=crop_x, y=crop_y, w=crop_w, h=crop_h, k=k, fits=fits)),
        mouth_window_render_px=dict(cx=mxr, cy=myr, w=mw, h=mh),
        silence_head_frames=head_n, silence_tail_frames=tail_n,
        silence=s_sil, speech=s_spk,
        per_frame=[dict(i=i, dx=drift[i][0], dy=drift[i][1], ncc=round(drift[i][2], 4), aperture=ap_px[i])
                   for i in range(N)],
    )
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w") as fh:
        json.dump(report, fh, indent=1)
    print(f"\n  wrote {a.out}")


if __name__ == "__main__":
    main()
