#!/usr/bin/env python3
"""
apply-base-measure.py — write the MEASURED numbers of a new base loop into the two
places that hard-code them, so the client tracks the new head and the anatomy
test asserts against the new nose.

  src/lib/voice/viseme-sync.ts     BASE_DRIFT_X / BASE_DRIFT_Y  (266 ints each)
  tests/anatomy-v4-bank.test.ts    NOSE_BASELINE_Y              (266 ints)

Input is base_measure.json from scripts/cut-idle-base.py. Nothing is invented: the
arrays are the cutter's per-frame template-match drift (same method the shipped
tables were made with) and its nose baseline (measure_mouth_alignment.py's method,
verbatim). Frame 0 is asserted to be {0,0} — that is the contract baseBoxAt relies
on. Refuses to write if any array is not exactly BASE_LOOP_FRAMES long or if the
baseline has a NaN (that would be a frame where the nostril detector found nothing,
which needs a human look, not a silent fill).

    python3 scripts/apply-base-measure.py --measure DIR/base_measure.json [--write]
"""
import argparse
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SYNC = os.path.join(ROOT, "src/lib/voice/viseme-sync.ts")
TEST = os.path.join(ROOT, "tests/anatomy-v4-bank.test.ts")
FRAMES = 266


def fmt_rows(vals, per=22, indent="  "):
    rows = []
    for i in range(0, len(vals), per):
        rows.append(indent + ", ".join((f"{v:.3f}" if isinstance(v, float) else str(v)) for v in vals[i:i + per]) + ",")
    return "\n".join(rows)


def replace_array(src, name, vals, decl_re):
    """Replace the literal body of `name` = [ ... ] with vals. decl_re must match
    up to and including the opening bracket; the body runs to the first ']'."""
    m = re.search(decl_re, src)
    if not m:
        sys.exit(f"refusing: could not find {name} declaration")
    start = m.end()
    end = src.index("]", start)
    old_body = src[start:end]
    old_n = len([t for t in re.split(r"[,\s]+", old_body.strip()) if t])
    new_body = "\n" + fmt_rows(vals) + "\n"
    return src[:start] + new_body + src[end:], old_n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--measure", required=True)
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--target", choices=["base", "speak"], default="base",
                    help="base = BASE_DRIFT_X/Y + the test's NOSE_BASELINE_Y (the listening body); "
                         "speak = SPEAK_DRIFT_X/Y + SPEAK_CONF (the speaking body; its patch is "
                         "confidence-gated, so the tracker's NCC ships with the offsets).")
    a = ap.parse_args()
    m = json.load(open(a.measure))
    dx, dy, nb = m["drift_x"], m["drift_y"], m["nose_baseline_y"]

    if a.target == "speak":
        conf = [round(float(c), 3) for c in m["drift_ncc"]]
        for name, arr in (("drift_x", dx), ("drift_y", dy), ("drift_ncc", conf)):
            if len(arr) != FRAMES:
                sys.exit(f"refusing: {name} has {len(arr)} entries, need {FRAMES}")
        if dx[0] != 0 or dy[0] != 0:
            sys.exit(f"refusing: frame 0 drift must be (0,0), got ({dx[0]},{dy[0]})")
        if any(not (0.0 <= c <= 1.0) for c in conf):
            sys.exit("refusing: a confidence value is outside 0..1")
        sync = open(SYNC, encoding="utf-8").read()
        sync2, n1 = replace_array(sync, "SPEAK_DRIFT_X", dx, r"const SPEAK_DRIFT_X: readonly number\[\] = \[")
        sync2, n2 = replace_array(sync2, "SPEAK_DRIFT_Y", dy, r"const SPEAK_DRIFT_Y: readonly number\[\] = \[")
        sync2, n3 = replace_array(sync2, "SPEAK_CONF", conf, r"const SPEAK_CONF: readonly number\[\] = \[")
        below = sum(1 for c in conf if c < 0.93)
        print(f"SPEAK_DRIFT_X: {n1} -> {len(dx)} entries, range {min(dx)}..{max(dx)}")
        print(f"SPEAK_DRIFT_Y: {n2} -> {len(dy)} entries, range {min(dy)}..{max(dy)}")
        print(f"SPEAK_CONF   : {n3} -> {len(conf)} entries, {len(conf) - below}/{len(conf)} at >= 0.93 (patch shown), min {min(conf)}")
        if not a.write:
            print("(dry run — pass --write to rewrite viseme-sync.ts)")
            return
        open(SYNC, "w", encoding="utf-8").write(sync2)
        print(f"wrote {os.path.relpath(SYNC, ROOT)}")
        return

    for name, arr in (("drift_x", dx), ("drift_y", dy), ("nose_baseline_y", nb)):
        if len(arr) != FRAMES:
            sys.exit(f"refusing: {name} has {len(arr)} entries, need {FRAMES}")
    if dx[0] != 0 or dy[0] != 0:
        sys.exit(f"refusing: frame 0 drift must be (0,0), got ({dx[0]},{dy[0]}) — baseBoxAt's contract")
    if any(v is None for v in nb):
        bad = [i for i, v in enumerate(nb) if v is None]
        sys.exit(f"refusing: nose baseline is NaN on frames {bad[:10]}{'...' if len(bad) > 10 else ''}")

    sync = open(SYNC, encoding="utf-8").read()
    test = open(TEST, encoding="utf-8").read()

    sync2, n1 = replace_array(sync, "BASE_DRIFT_X", dx, r"const BASE_DRIFT_X: readonly number\[\] = \[")
    sync2, n2 = replace_array(sync2, "BASE_DRIFT_Y", dy, r"const BASE_DRIFT_Y: readonly number\[\] = \[")
    test2, n3 = replace_array(test, "NOSE_BASELINE_Y", nb, r"const NOSE_BASELINE_Y: readonly number\[\] = \[")

    print(f"BASE_DRIFT_X : {n1} -> {len(dx)} entries, range {min(dx)}..{max(dx)}")
    print(f"BASE_DRIFT_Y : {n2} -> {len(dy)} entries, range {min(dy)}..{max(dy)}")
    print(f"NOSE_BASELINE: {n3} -> {len(nb)} entries, range {min(nb)}..{max(nb)}")
    if not a.write:
        print("(dry run — pass --write to rewrite the two files)")
        return
    open(SYNC, "w", encoding="utf-8").write(sync2)
    open(TEST, "w", encoding="utf-8").write(test2)
    print(f"wrote {os.path.relpath(SYNC, ROOT)} and {os.path.relpath(TEST, ROOT)}")


if __name__ == "__main__":
    main()
