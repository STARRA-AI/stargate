"""
Composite every entry of one or more viseme banks onto base_loop frame 0 and lay
them out as a contact sheet, so a bank can be JUDGED BY EYE instead of by its
numbers.

This exists because the 0.55 openness ceiling in the shipped bank was set by
exactly this kind of judgement — the clampOpenness docstring in viseme-sync.ts
records that wider entries "read as a SHOUT when composited (verified by eye)" —
and there was no way to re-make that call after the v4 registration fix without
rebuilding the whole look by hand.

The compositing here MIRRORS the runtime: patch drawn at its baseBox under a
centred elliptical feathered mask (viseme-sync.ts patchPlacement / bankPatchExtent).
It is close, not byte-identical — good enough to answer "does this read as a
shout", which is the only question it is for.

    python scripts/viseme-contact-sheet.py OUT.png DIR [DIR ...]
"""
import json
import os
import sys

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BASE_LOOP = os.path.join(ROOT, "public/avatar/body/base_loop.mp4")
BASE_W, BASE_H = 552, 720

# The face window each tile shows: mouth box (212,242,131,78) plus nose above and
# chin below, so a patch that cuts into her nose is visible rather than cropped out.
CROP = (176, 168, 200, 216)  # x, y, w, h in base_loop pixels
TILE_SCALE = 1.6
LABEL_H = 34
COLS = 5


def base_frame0():
    import subprocess

    n = BASE_W * BASE_H * 3
    p = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", BASE_LOOP, "-frames:v", "1",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    )
    buf = p.stdout.read(n)
    p.stdout.close()
    p.wait()
    if len(buf) < n:
        sys.exit(f"could not read a frame from {BASE_LOOP}")
    return np.frombuffer(buf, np.uint8).reshape(BASE_H, BASE_W, 3).copy()


def feather(w, h):
    """Centred elliptical alpha, soft at the rim — the runtime's mask shape."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = (w - 1) / 2.0, (h - 1) / 2.0
    r = np.sqrt(((xx - cx) / (w * 0.52)) ** 2 + ((yy - cy) / (h * 0.52)) ** 2)
    a = np.clip((1.0 - r) / 0.28, 0.0, 1.0)
    return a[:, :, None]


def composite(base, patch, box):
    out = base.copy()
    x, y, w, h = box["x"], box["y"], box["w"], box["h"]
    if patch.shape[1] != w or patch.shape[0] != h:
        patch = cv2.resize(patch, (w, h), interpolation=cv2.INTER_AREA)
    a = feather(w, h)
    roi = out[y:y + h, x:x + w].astype(np.float32)
    out[y:y + h, x:x + w] = (patch.astype(np.float32) * a + roi * (1 - a)).astype(np.uint8)
    return out


def tile(base, entry, bank_dir, caption):
    fn = os.path.join(bank_dir, os.path.basename(entry["file"]))
    patch = cv2.imread(fn)
    if patch is None:
        return None
    comp = composite(base, patch, entry["baseBox"])
    cx, cy, cw, ch = CROP
    crop = comp[cy:cy + ch, cx:cx + cw]
    crop = cv2.resize(
        crop, (int(cw * TILE_SCALE), int(ch * TILE_SCALE)), interpolation=cv2.INTER_CUBIC
    )
    th, tw = crop.shape[:2]
    canvas = np.zeros((th + LABEL_H, tw, 3), np.uint8)
    canvas[:th] = crop
    cv2.putText(canvas, caption, (6, th + 14), cv2.FONT_HERSHEY_SIMPLEX, 0.40,
                (235, 235, 235), 1, cv2.LINE_AA)
    cv2.putText(canvas, entry.get("label", ""), (6, th + 28), cv2.FONT_HERSHEY_SIMPLEX,
                0.36, (150, 210, 255), 1, cv2.LINE_AA)
    return canvas


def sheet_for(base, bank_dir, name):
    with open(os.path.join(bank_dir, "bank.json")) as fh:
        bank = json.load(fh)
    frames = sorted(bank["frames"], key=lambda e: (e["openness"], -e["roundness"]))
    tiles = []
    for e in frames:
        cap = f"{e['id']}  o={e['openness']:.2f} r={e['roundness']:.2f}"
        t = tile(base, e, bank_dir, cap)
        if t is not None:
            tiles.append(t)
    if not tiles:
        sys.exit(f"no patches loaded from {bank_dir}")

    n = len(tiles)
    mx = max(e["openness"] for e in frames)
    title = f"{name} - {n} entries, openness tops out at {mx:.3f}"

    th, tw = tiles[0].shape[:2]
    rows = (n + COLS - 1) // COLS
    head = 40
    sheet = np.full((head + rows * th, COLS * tw, 3), 18, np.uint8)
    cv2.putText(sheet, title, (10, 27), cv2.FONT_HERSHEY_SIMPLEX, 0.70,
                (255, 255, 255), 2, cv2.LINE_AA)
    for i, t in enumerate(tiles):
        r, c = divmod(i, COLS)
        sheet[head + r * th:head + (r + 1) * th, c * tw:(c + 1) * tw] = t
    return sheet, n, mx


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    out_path = sys.argv[1]
    base = base_frame0()

    sheets = []
    for d in sys.argv[2:]:
        bank_dir = d if os.path.isabs(d) else os.path.join(ROOT, d)
        name = os.path.basename(bank_dir.rstrip("/"))
        s, n, mx = sheet_for(base, bank_dir, name)
        sheets.append(s)
        print(f"{name}: {n} entries, max openness {mx:.3f}")

    width = max(s.shape[1] for s in sheets)
    padded = []
    for s in sheets:
        if s.shape[1] < width:
            s = np.pad(s, ((0, 0), (0, width - s.shape[1]), (0, 0)), constant_values=18)
        padded.append(s)
        padded.append(np.full((8, width, 3), 90, np.uint8))
    cv2.imwrite(out_path, np.vstack(padded[:-1]))
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
