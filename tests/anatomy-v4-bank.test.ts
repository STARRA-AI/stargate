/**
 * ANATOMY v4 — the base-loop body + the mouth bank that is composited onto it.
 *
 * WHAT THIS ROUND ACTUALLY CHANGED, and why every assertion below matters:
 * public/avatar/body/base_loop.mp4 is a CONTINUOUS body whose mouth is AT REST
 * for all 266 frames. It carries no speech at all. So the composited patch is
 * not decoration — it is the only thing that makes her look like she is talking.
 * If the v4 bank silently fails to parse, or the ceiling stops clamping, or the
 * closure stops resolving from the JSON, she plays an 11s loop of a woman with a
 * shut mouth while her voice comes out. That is the failure these tests exist to
 * catch.
 *
 * Everything here is PURE (parsers, the clamp, the closure resolution, the tone
 * arithmetic, the placement + drift lookups) plus a set of assertions against the
 * REAL shipped assets on disk — no fixtures standing in for her footage.
 *
 * Run: npx --yes tsx --test tests/*.test.ts   (package.json -> test:v2)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  BASE_LOOP_FPS,
  BASE_LOOP_FRAMES,
  BANK3_URL,
  DEFAULT_OPENNESS_CEILING,
  TONE_PATCH_WEIGHT,
  applyToneOffsets,
  bankPatchExtent,
  baseBoxAt,
  baseDriftAt,
  channelMeans,
  clampOpenness,
  parseVisemeBank2,
  parseVisemeBank4,
  patchPlacement,
  pickVisemeFrame4,
  toneMatchOffsets,
  type VisemeBank4,
} from "../src/lib/voice/viseme-sync";
import {
  CONTINUOUS_BODY_CLIP,
  CROSSFADE_MS,
  IDLE_POOL,
  SPEAKING_CLIP,
  STARRA_CLIPS,
  isIdlePoolMember,
} from "../src/lib/voice/starra-clip-map";

const PUB = path.join(process.cwd(), "public");
const BANK_PATH = path.join(PUB, "avatar", "visemes3", "bank.json");
const rawBank: unknown = JSON.parse(readFileSync(BANK_PATH, "utf8"));
const bank4 = parseVisemeBank4(rawBank);

/** PNG pixel size straight out of the IHDR — no image library, no dependency. */
function pngSize(file: string): { w: number; h: number } | null {
  const buf = readFileSync(file);
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null; // \x89PNG
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ── the v4 parser ───────────────────────────────────────────────────────────

describe("v4 bank — the shipped visemes3/bank.json parses", () => {
  it("parses, and reports the fields the renderer needs", () => {
    assert.ok(bank4, "public/avatar/visemes3/bank.json must parse as v4");
    assert.equal(bank4.version, 4);
    assert.equal(bank4.base, "/avatar/body/base_loop.mp4");
    // 24 = closure + 23 distinct grid entries: FIVE roundness columns x FIVE
    // openness rungs (--full-range), minus the cells that resolved to a frame
    // another cell already claimed. Cut 2026-09-22 from an InfiniteTalk render of
    // her SPEAKING (561 frames, 457 pose-eligible, a true 0px closure), composited
    // onto a base loop cut from an InfiniteTalk render of her LISTENING — the same
    // portrait and model, so the two register at NCC 0.9938.
    //
    // History: 16 entries (three openness rungs, ceiling 0.55) read as a pasted-on
    // mouth; 25 came from widening the ladder on the old footage; 24 is the same
    // ladder on footage where she is actually talking.
    assert.equal(bank4.frames.length, 24);
    assert.ok(bank4.width > 0 && bank4.height > 0 && bank4.fps > 0);
  });

  it("carries baseBox + registration on EVERY entry (no patch may be unplaceable)", () => {
    assert.ok(bank4);
    for (const f of bank4.frames) {
      assert.ok(f.baseBox, `${f.id} has no baseBox`);
      assert.ok(f.baseBox.w > 0 && f.baseBox.h > 0, `${f.id} baseBox is degenerate`);
      assert.ok(Number.isFinite(f.baseBox.x) && Number.isFinite(f.baseBox.y));
      assert.ok(
        Number.isFinite(f.registration) && f.registration > 0,
        `${f.id} has no registration score`,
      );
    }
  });

  it("reads opennessCeiling and closedId from the FILE, not from a constant", () => {
    assert.ok(bank4);
    // 1.0 since 2026-09-22. The old 0.55 was set because wide entries "read as a
    // SHOUT when composited (verified by eye)" — but that judgement predates the
    // v4 registration fix, when every patch was registered individually and slid
    // up into her nose. Re-judged on a contact sheet after the fix
    // (scripts/viseme-contact-sheet.py): the 0.76-1.00 entries read as ordinary
    // open-mouth speech. The clamp was amputating half her range for a defect
    // that had already been fixed elsewhere.
    assert.equal(bank4.opennessCeiling, 1.0);
    // The PRESSED closure (aperture 2px, lips touching in 91% of centre-band
    // columns — the file's own provenance fields). The old bank pointed away
    // from m_closed because its per-entry registration floated the crop into
    // her nose; the 2026-07-30 rebuild places every entry on ONE rigid mapping,
    // and the pressed closure composites correctly (verified on real frames).
    assert.equal(bank4.closedId, "m_closed");
    const closed = bank4.frames.find((f) => f.id === bank4.closedId);
    assert.ok(closed);
    assert.equal(closed.openness, 0, "the closure must be genuinely shut");
  });

  it("no shipped entry sits above the ceiling", () => {
    assert.ok(bank4);
    for (const f of bank4.frames) {
      assert.ok(
        f.openness <= bank4.opennessCeiling,
        `${f.id} openness ${f.openness} exceeds ceiling ${bank4.opennessCeiling}`,
      );
    }
  });

  it("REJECTS a v1 and a v2 bank so the caller falls back instead of misreading", () => {
    assert.equal(parseVisemeBank4({ version: 1, width: 8, height: 8, fps: 24, frames: [] }), null);
    assert.equal(
      parseVisemeBank4({
        version: 2,
        width: 8,
        height: 8,
        fps: 24,
        frames: [{ id: "a", file: "/a.png", openness: 0, roundness: 0 }],
      }),
      null,
    );
  });

  it("the v2 parser still parses a v2 bank (the fallback rung is intact)", () => {
    const v2 = parseVisemeBank2({
      version: 2,
      source: "/avatar/clips/talking.mp4",
      width: 170,
      height: 130,
      fps: 24,
      closedId: "shut",
      frames: [
        { id: "shut", file: "/a.png", openness: 0, roundness: 0.5 },
        { id: "open", file: "/b.png", openness: 0.9, roundness: 0.2 },
      ],
    });
    assert.ok(v2, "a valid v2 bank must still parse");
    assert.equal(v2.version, 2);
    assert.equal(v2.closedId, "shut");
  });

  it("a MALFORMED bank returns null and NEVER throws", () => {
    const bad: unknown[] = [
      null,
      undefined,
      0,
      "",
      "{}",
      [],
      {},
      { version: 4 },
      { version: 4, width: 0, height: 8, fps: 24, frames: [] },
      { version: 4, width: 8, height: 8, fps: 24, frames: [] },
      { version: 4, width: 8, height: 8, fps: 24, frames: "nope" },
      { version: 4, width: 8, height: 8, fps: 24, frames: [null] },
      // a frame with NO baseBox is unplaceable: the whole bank must be refused
      {
        version: 4,
        width: 8,
        height: 8,
        fps: 24,
        frames: [{ id: "a", file: "/a.png", openness: 0, roundness: 0 }],
      },
      // a DEGENERATE baseBox is equally unplaceable
      {
        version: 4,
        width: 8,
        height: 8,
        fps: 24,
        frames: [
          { id: "a", file: "/a.png", openness: 0, roundness: 0, baseBox: { x: 1, y: 1, w: 0, h: 4 } },
        ],
      },
      { version: 4, width: 8, height: 8, fps: 24, frames: [{ baseBox: { x: 1, y: 1, w: 2, h: 2 } }] },
    ];
    for (const b of bad) {
      assert.doesNotThrow(() => parseVisemeBank4(b), `threw on ${JSON.stringify(b)}`);
      assert.equal(parseVisemeBank4(b), null, `accepted ${JSON.stringify(b)}`);
    }
  });

  it("a missing/invalid opennessCeiling degrades to no clamping, not to zero", () => {
    const b = parseVisemeBank4({
      version: 4,
      width: 8,
      height: 8,
      fps: 24,
      base: "/x.mp4",
      frames: [
        { id: "a", file: "/a.png", openness: 0.9, roundness: 0.5, baseBox: { x: 0, y: 0, w: 4, h: 4 } },
      ],
    });
    assert.ok(b);
    assert.equal(b.opennessCeiling, DEFAULT_OPENNESS_CEILING);
    assert.equal(DEFAULT_OPENNESS_CEILING, 1);
  });

  it("a closedId naming no real frame is DROPPED, never left dangling", () => {
    const b = parseVisemeBank4({
      version: 4,
      width: 8,
      height: 8,
      fps: 24,
      closedId: "ghost",
      frames: [
        { id: "a", file: "/a.png", openness: 0.2, roundness: 0.5, baseBox: { x: 0, y: 0, w: 4, h: 4 } },
      ],
    });
    assert.ok(b);
    assert.equal(b.closedId, null);
  });
});

// ── the openness CEILING ────────────────────────────────────────────────────

describe("v4 — openness clamps to the ceiling instead of overflowing the ladder", () => {
  it("clampOpenness holds anything above the ceiling AT the ceiling", () => {
    assert.equal(clampOpenness(1, 0.55), 0.55);
    assert.equal(clampOpenness(0.9, 0.55), 0.55);
    assert.equal(clampOpenness(0.55, 0.55), 0.55);
    assert.equal(clampOpenness(0.3, 0.55), 0.3);
    assert.equal(clampOpenness(0, 0.55), 0);
  });

  it("clampOpenness is TOTAL — garbage in never produces NaN out", () => {
    // A NON-FINITE reading is SHUT, not wide open. This matches the convention
    // already established in viseme-sync.ts (pickVisemeFrame line 320 and
    // pickVisemeFrame2 line 806 both do `isFinite(openness) ? clamp01(o) : 0`),
    // and it is the safe direction: garbage must never fling her mouth open.
    assert.equal(clampOpenness(NaN, 0.55), 0);
    assert.equal(clampOpenness(Infinity, 0.55), 0);
    assert.equal(clampOpenness(-1, 0.55), 0);
    assert.equal(clampOpenness(0.4, NaN), 0.4);
    assert.equal(clampOpenness(0.4, 0), 0.4);
    assert.equal(clampOpenness(2, 5), 1); // a ceiling above 1 cannot lift openness past 1
  });

  it("a FULL-VOLUME passage now reaches the TOP of the real ladder", () => {
    assert.ok(bank4);
    const top = Math.max(...bank4.frames.map((f) => f.openness));
    assert.equal(top, 1, "the ladder must reach a fully open real frame");

    // THE REGRESSION THIS REPLACES. This test used to assert `top === 0.5238`
    // and that openness 1.0 and openness 0.55 resolve to the SAME frame —
    // encoding the clamp as correct behaviour. It was the clamp that made her
    // mouth look pasted on: nearest-neighbour could not reach past half however
    // loud she got, because clampOpenness flattened the request first.
    //
    // The property that actually matters is that LOUDER OPENS HER MOUTH MORE,
    // at every roundness, rather than saturating half way.
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const loud = pickVisemeFrame4(bank4, 1, r);
      const mid = pickVisemeFrame4(bank4, 0.5, r);
      assert.ok(loud && mid, `no pick at roundness ${r}`);
      assert.ok(
        loud.openness > mid.openness,
        `at roundness ${r} a full-volume pick (${loud.id} @ ${loud.openness}) is not wider ` +
          `than a half-volume pick (${mid.id} @ ${mid.openness})`,
      );
      assert.ok(
        loud.openness <= bank4.opennessCeiling,
        `${loud.id} at ${loud.openness} exceeds the ${bank4.opennessCeiling} ceiling`,
      );
    }

    // Still never past the widest thing actually filmed. The ceiling is 1.0 now,
    // but 1.0 is the footage's own maximum aperture (48px), not a synthesised
    // gape — openness is normalised to that max by the builder.
    for (const r of [0, 0.5, 1]) {
      const p = pickVisemeFrame4(bank4, 1, r);
      assert.ok(p && p.openness <= top);
    }
  });

  it("the clamp cannot be defeated by a non-finite reading", () => {
    assert.ok(bank4);
    assert.doesNotThrow(() => pickVisemeFrame4(bank4, NaN, NaN));
    assert.ok(pickVisemeFrame4(bank4, Infinity, -Infinity));
    assert.equal(pickVisemeFrame4(null, 0.5, 0.5), null);
    assert.equal(pickVisemeFrame4(undefined, 0.5, 0.5), null);
  });
});

// ── the CLOSURE, resolved from the JSON ─────────────────────────────────────

describe("v4 — the closure comes from the bank's closedId, not a hardcoded id", () => {
  it("a shut mouth resolves to whatever the FILE names, at any roundness", () => {
    assert.ok(bank4);
    for (const r of [0, 0.2, 0.5, 0.8, 1]) {
      assert.equal(pickVisemeFrame4(bank4, 0, r)?.id, bank4.closedId);
      assert.equal(pickVisemeFrame4(bank4, 0.01, r)?.id, bank4.closedId);
    }
  });

  it("re-point closedId and the closure FOLLOWS it (no id is baked into the code)", () => {
    assert.ok(bank4);
    const repointed: VisemeBank4 = { ...bank4, closedId: "m02" };
    assert.equal(pickVisemeFrame4(repointed, 0, 0.5)?.id, "m02");
    const none: VisemeBank4 = { ...bank4, closedId: null };
    const p = pickVisemeFrame4(none, 0, 0.5);
    assert.ok(p, "a bank with no closure must still return a nearest frame");
  });
});

// ── the TONE MATCH ──────────────────────────────────────────────────────────

describe("v4 tone match — identity when the means already agree", () => {
  it("equal means produce a ZERO offset on every channel", () => {
    assert.deepEqual(toneMatchOffsets([100, 110, 120], [100, 110, 120]), [0, 0, 0]);
    assert.deepEqual(toneMatchOffsets([0, 0, 0], [0, 0, 0]), [0, 0, 0]);
    assert.deepEqual(toneMatchOffsets([255, 255, 255], [255, 255, 255]), [0, 0, 0]);
  });

  it("a zero offset leaves the pixels BYTE-IDENTICAL", () => {
    const before = [10, 20, 30, 255, 200, 201, 202, 128];
    const after = before.slice();
    applyToneOffsets(after, [0, 0, 0]);
    assert.deepEqual(after, before);
  });

  it("shifts the patch toward the base by exactly (1 - TONE_PATCH_WEIGHT)", () => {
    // the build arithmetic: target = patch*0.35 + base*0.65, so the additive
    // offset is 0.65*(base - patch)
    const offs = toneMatchOffsets([100, 100, 100], [200, 100, 50]);
    assert.equal(TONE_PATCH_WEIGHT, 0.35);
    assert.ok(Math.abs(offs[0] - 65) < 1e-9, `R offset ${offs[0]}`);
    assert.equal(offs[1], 0);
    assert.ok(Math.abs(offs[2] + 32.5) < 1e-9, `B offset ${offs[2]}`);
  });

  it("applying the offset lands the patch mean ON the blend target", () => {
    const rgba = [100, 100, 100, 255, 100, 100, 100, 255];
    const base: [number, number, number] = [200, 60, 100];
    const patch = channelMeans(rgba);
    assert.ok(patch);
    applyToneOffsets(rgba, toneMatchOffsets(patch, base));
    const after = channelMeans(rgba);
    assert.ok(after);
    for (let c = 0; c < 3; c++) {
      const want = patch[c] * TONE_PATCH_WEIGHT + base[c] * (1 - TONE_PATCH_WEIGHT);
      assert.ok(Math.abs(after[c] - want) <= 1, `channel ${c}: ${after[c]} vs ${want}`);
    }
  });

  it("clamps at the byte ends rather than wrapping", () => {
    const rgba = [250, 5, 128, 255];
    applyToneOffsets(rgba, [100, -100, 0]);
    assert.equal(rgba[0], 255);
    assert.equal(rgba[1], 0);
    assert.equal(rgba[2], 128);
    assert.equal(rgba[3], 255, "alpha must never be touched");
  });

  it("channelMeans skips fully transparent pixels and refuses a bad buffer", () => {
    // one opaque black pixel + one transparent white one -> mean must be 0
    assert.deepEqual(channelMeans([0, 0, 0, 255, 255, 255, 255, 0]), [0, 0, 0]);
    assert.equal(channelMeans([]), null);
    assert.equal(channelMeans([1, 2, 3]), null);
    assert.equal(channelMeans([0, 0, 0, 0]), null, "all-transparent has no measurable mean");
  });

  it("toneMatchOffsets is TOTAL — non-finite means produce no shift", () => {
    assert.deepEqual(toneMatchOffsets([NaN, 1, 1], [1, 1, 1]), [0, 0, 0]);
    assert.deepEqual(toneMatchOffsets([1, 1, 1], [NaN, NaN, NaN]), [0, 0, 0]);
  });
});

// ── PLACEMENT + the measured base-loop drift ────────────────────────────────

describe("v4 placement — the patch is centred under the mask and lands on its box", () => {
  it("centres a smaller patch in the shared canvas and compensates the origin", () => {
    const p = patchPlacement({ x: 213, y: 205, w: 125, h: 89 }, 131, 93);
    assert.ok(p);
    assert.equal(p.drawX, 3);
    assert.equal(p.drawY, 2);
    // origin + drawOffset must put the patch's left/top back ON its baseBox
    assert.equal(p.originX + p.drawX, 213);
    assert.equal(p.originY + p.drawY, 205);
  });

  it("an exact-fit patch needs no offset at all", () => {
    const p = patchPlacement({ x: 212, y: 220, w: 131, h: 93 }, 131, 93);
    assert.ok(p);
    assert.equal(p.drawX, 0);
    assert.equal(p.drawY, 0);
    assert.equal(p.originX, 212);
    assert.equal(p.originY, 220);
  });

  it("refuses a canvas too small for the box rather than cropping her mouth", () => {
    assert.equal(patchPlacement({ x: 0, y: 0, w: 200, h: 10 }, 131, 93), null);
    assert.equal(patchPlacement({ x: 0, y: 0, w: 10, h: 200 }, 131, 93), null);
    assert.equal(patchPlacement({ x: 0, y: 0, w: 0, h: 0 }, 131, 93), null);
  });

  it("bankPatchExtent sizes the canvas to the LARGEST shipped box", () => {
    assert.ok(bank4);
    const ext = bankPatchExtent(bank4.frames);
    assert.ok(ext);
    assert.equal(ext.w, Math.max(...bank4.frames.map((f) => f.baseBox.w)));
    assert.equal(ext.h, Math.max(...bank4.frames.map((f) => f.baseBox.h)));
    for (const f of bank4.frames) {
      assert.ok(patchPlacement(f.baseBox, ext.w, ext.h), `${f.id} does not fit the canvas`);
    }
    assert.equal(bankPatchExtent([]), null);
  });

  it("the drift table covers the whole loop and is TOTAL at every input", () => {
    assert.equal(BASE_LOOP_FRAMES, 266);
    assert.equal(BASE_LOOP_FPS, 24);
    for (let i = 0; i < BASE_LOOP_FRAMES; i++) {
      const d = baseDriftAt(i);
      assert.ok(Number.isFinite(d.dx) && Number.isFinite(d.dy), `frame ${i} drift is not finite`);
      assert.ok(Math.abs(d.dx) <= 12 && Math.abs(d.dy) <= 20, `frame ${i} drift ${d.dx},${d.dy}`);
    }
    // out of range CLAMPS to the ends; garbage is a no-op, never a NaN box
    assert.deepEqual(baseDriftAt(-5), baseDriftAt(0));
    assert.deepEqual(baseDriftAt(9999), baseDriftAt(BASE_LOOP_FRAMES - 1));
    assert.deepEqual(baseDriftAt(NaN), { dx: 0, dy: 0 });
    assert.deepEqual(baseDriftAt(Infinity), baseDriftAt(BASE_LOOP_FRAMES - 1));
  });

  it("the drift track is SMOOTH and seam-continuous (no visible mouth jump)", () => {
    let worst = 0;
    for (let i = 1; i < BASE_LOOP_FRAMES; i++) {
      const a = baseDriftAt(i - 1);
      const b = baseDriftAt(i);
      worst = Math.max(worst, Math.abs(b.dx - a.dx), Math.abs(b.dy - a.dy));
    }
    assert.ok(worst <= 1, `per-frame drift step is ${worst}px — that would read as jitter`);
    const first = baseDriftAt(0);
    const last = baseDriftAt(BASE_LOOP_FRAMES - 1);
    assert.ok(
      Math.abs(first.dx - last.dx) <= 1 && Math.abs(first.dy - last.dy) <= 1,
      `loop seam jumps ${first.dx - last.dx},${first.dy - last.dy}px`,
    );
  });

  it("baseBoxAt shifts the box by the drift and keeps its size", () => {
    assert.ok(bank4);
    const box = bank4.frames[0].baseBox;
    for (const i of [0, 41, 132, 265]) {
      const d = baseDriftAt(i);
      const moved = baseBoxAt(box, i);
      assert.equal(moved.x, box.x + d.dx);
      assert.equal(moved.y, box.y + d.dy);
      assert.equal(moved.w, box.w);
      assert.equal(moved.h, box.h);
    }
    // frame 0 is the frame the boxes were measured on: it must be the identity
    assert.deepEqual(baseBoxAt(box, 0), { x: box.x, y: box.y, w: box.w, h: box.h });
  });
});

// ── NOSE CLEARANCE + LIP COVERAGE — the anatomy invariant (2026-07-30) ──────
//
// MEASURED from the footage itself by scripts/measure_mouth_alignment.py:
// per-frame NOSE BASELINE of base_loop.mp4 (the lowest row of the dark nostril
// mass, luminance method, drift-compensated windows; drift-relative spread was
// 238..241 across all 266 frames — a 3px band, confirming rigid head motion).
// The defect this pins out: the pre-rebuild bank put every patch's box top
// 19-36px ABOVE this baseline (solid mask alpha up to 17.3px above it, 266/266
// frames) — the patch visibly cut into her nose.
const NOSE_BASELINE_Y: readonly number[] = [
  274, 274, 274, 274, 274, 274, 274, 274, 275, 275, 275, 275, 275, 276, 276, 276, 276, 276, 277, 277, 277, 277,
  277, 277, 277, 277, 277, 276, 276, 276, 275, 275, 276, 276, 276, 275, 275, 275, 275, 275, 275, 275, 274, 274,
  274, 274, 274, 274, 274, 273, 273, 273, 273, 273, 273, 273, 273, 273, 273, 273, 273, 273, 273, 273, 273, 273,
  273, 273, 273, 273, 273, 273, 273, 273, 273, 273, 273, 274, 274, 274, 275, 275, 275, 275, 275, 275, 275, 275,
  275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274,
  274, 274, 273, 273, 273, 273, 273, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274,
  274, 274, 273, 273, 273, 273, 273, 273, 274, 274, 274, 274, 275, 275, 275, 276, 276, 276, 276, 276, 276, 276,
  276, 277, 277, 277, 277, 277, 277, 277, 277, 277, 277, 277, 276, 276, 276, 276, 276, 275, 275, 275, 275, 275,
  275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 274, 274,
  274, 274, 273, 273, 273, 273, 273, 273, 273, 273, 273, 272, 272, 272, 272, 272, 272, 272, 273, 273, 273, 274,
  274, 274, 274, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 275, 274, 274,
  274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274, 274,
  274, 274,
];
// The measured lip geometry (drift-relative, base_loop 552x720 coords),
// MEASURED 2026-09-22 with the bank builder's own lip_mask (skin-luminance gated,
// windowed, component-filtered — the detector that cut the bank; the alignment
// tool's plain a* threshold over-segments this footage and was NOT used):
// FULL-FRAME BASE (2026-09-22, "WE WANT HER FROM THE WAIST UP"): the whole
// 768x1168 render scaled to 552x840, nose at (321.6, 243.7):
//   base's resting lips   y 288.. (top is 288 on all 266 frames),  x 295..360
//   patches' OWN lips     y 288..353,                               x 284..364
// InfiniteTalk articulates wider than the old take, which is why the box is
// 152x102 at (248,278): the mask's SOLID ellipse must hold the corners and the
// lower lip of the open vowels, or they render half-faded. The box must hold
// all of it, with feather room below.
const LIP_TOP_MIN = 287;
const PATCH_LIP_BOTTOM_MAX = 353;
const PATCH_LIP_X = { min: 284, max: 364 };

describe("v4 anatomy invariant — the patch clears her nose and holds her lips", () => {
  it("every entry shares ONE uniform baseBox (mask geometry cannot flicker)", () => {
    assert.ok(bank4);
    const first = bank4.frames[0].baseBox;
    for (const f of bank4.frames) {
      assert.deepEqual(
        f.baseBox,
        first,
        `${f.id} baseBox differs — per-entry registration slid the old "oo" crops into her nose`,
      );
    }
  });

  it("the patch top edge clears the measured nose baseline on 266/266 frames", () => {
    assert.ok(bank4);
    assert.equal(NOSE_BASELINE_Y.length, BASE_LOOP_FRAMES);
    for (const f of bank4.frames) {
      for (let i = 0; i < BASE_LOOP_FRAMES; i++) {
        const box = baseBoxAt(f.baseBox, i);
        assert.ok(
          box.y > NOSE_BASELINE_Y[i],
          `${f.id} frame ${i}: patch top ${box.y} does not clear the nose baseline ${NOSE_BASELINE_Y[i]}`,
        );
      }
    }
  });

  it("while still covering the lips fully, with feather room below", () => {
    assert.ok(bank4);
    for (const f of bank4.frames) {
      const b = f.baseBox;
      assert.ok(b.y <= LIP_TOP_MIN, `${f.id}: box top ${b.y} starts below the lip top ${LIP_TOP_MIN}`);
      assert.ok(
        b.y + b.h >= PATCH_LIP_BOTTOM_MAX + 15,
        `${f.id}: box bottom ${b.y + b.h} leaves no feather room under the lip bottom ${PATCH_LIP_BOTTOM_MAX}`,
      );
      assert.ok(b.x <= PATCH_LIP_X.min && b.x + b.w >= PATCH_LIP_X.max, `${f.id}: lip corners outside the box`);
    }
  });
});

// ── the REAL assets on disk ─────────────────────────────────────────────────

describe("v4 assets — every shipped patch is real, present and already at base scale", () => {
  it("every entry's PNG exists", () => {
    assert.ok(bank4);
    for (const f of bank4.frames) {
      const p = path.join(PUB, f.file.replace(/^\//, ""));
      assert.ok(existsSync(p), `missing patch ${f.file}`);
    }
  });

  it("every PNG's PIXEL size equals its baseBox — so the runtime must NOT rescale", () => {
    assert.ok(bank4);
    for (const f of bank4.frames) {
      const size = pngSize(path.join(PUB, f.file.replace(/^\//, "")));
      assert.ok(size, `${f.file} is not a readable PNG`);
      assert.equal(size.w, f.baseBox.w, `${f.id}: png ${size.w}px vs baseBox ${f.baseBox.w}px`);
      assert.equal(size.h, f.baseBox.h, `${f.id}: png ${size.h}px vs baseBox ${f.baseBox.h}px`);
    }
  });

  it("the base clip the bank names is the one the deck actually plays", () => {
    assert.ok(bank4);
    assert.equal(bank4.base, STARRA_CLIPS[CONTINUOUS_BODY_CLIP].file);
    assert.ok(
      existsSync(path.join(PUB, "avatar", "body", "base_loop.mp4")),
      "public/avatar/body/base_loop.mp4 is missing",
    );
  });

  it("BANK3_URL points at the shipped file", () => {
    assert.equal(BANK3_URL, "/avatar/visemes3/bank.json");
    assert.ok(existsSync(BANK_PATH));
  });
});

// ── the CONTINUOUS BODY in the clip map ─────────────────────────────────────

describe("the continuous body — one clip, never switched away from", () => {
  it("is registered, LOOPS, and its length matches the real file", () => {
    const clip = STARRA_CLIPS[CONTINUOUS_BODY_CLIP];
    assert.ok(clip, "CONTINUOUS_BODY_CLIP must exist in STARRA_CLIPS");
    assert.equal(clip.file, "/avatar/body/base_loop.mp4");
    assert.equal(clip.loop, true, "the body must loop forever — it is never handed off");
    assert.equal(clip.durationMs, 11083);
    // 266 frames at 24fps = 11.0833s. The clip map must agree with the asset.
    const measured = (BASE_LOOP_FRAMES / BASE_LOOP_FPS) * 1000;
    assert.ok(
      Math.abs(clip.durationMs - measured) < 2,
      `durationMs ${clip.durationMs} vs measured ${measured.toFixed(1)}`,
    );
  });

  it("is NOT an idle-pool member (it loops, so `ended` would never fire)", () => {
    assert.equal(isIdlePoolMember(CONTINUOUS_BODY_CLIP), false);
    assert.equal((IDLE_POOL as readonly string[]).includes(CONTINUOUS_BODY_CLIP), false);
  });

  it("does not repurpose SPEAKING_CLIP, and leaves every legacy export intact", () => {
    assert.notEqual(CONTINUOUS_BODY_CLIP, SPEAKING_CLIP);
    assert.equal(SPEAKING_CLIP, "talking");
    assert.equal(CROSSFADE_MS, 320);
    assert.deepEqual([...IDLE_POOL], ["idle_a1", "idle_c1", "idle_a2"]);
    for (const id of IDLE_POOL) {
      assert.ok(isIdlePoolMember(id), `${id} dropped out of the idle pool`);
    }
  });
});
