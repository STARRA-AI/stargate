/**
 * MOUTH ARTICULATION — every sound, not just O's (2026-07-30).
 *
 * THE DEFECT THIS PINS OUT, root-caused with numbers before the fix: driving
 * the SHIPPED path with synthetic vowel spectra, AH / OH / OO all saturated
 * roundnessFromAudio to ~1.0 (every voiced vowel's F1 lands in the low band,
 * and AH's F2 ~1200Hz fell in NEITHER band), so the end-to-end pick returned
 * the "oo" pucker for every back/central vowel — "everything looks like an O".
 * A second bias: the bands were SUMMED and the mid band holds ~2x the low
 * band's bins, so flat noise read as strongly spread.
 *
 * These tests drive DISTINCT spread-vs-rounded-vs-open input vectors through
 * the SHIPPED pick path (roundnessFromAudio -> createRoundnessSmoother ->
 * pickVisemeFrame4 on the REAL bank on disk) and require distinct bank frames
 * out the other end. If the calibration, the smoother, the weighting, or the
 * bank's roundness coverage regresses, a vowel collapses onto the wrong column
 * and this file fails.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  createMouthSmoother,
  createRoundnessSmoother,
  opennessFromAudio,
  parseVisemeBank4,
  pickVisemeFrame4,
  roundnessFromAudio,
} from "../src/lib/voice/viseme-sync";

const BANK_PATH = path.join(process.cwd(), "public", "avatar", "visemes3", "bank.json");
const rawBank = JSON.parse(readFileSync(BANK_PATH, "utf8")) as {
  frames: { id: string; roundness: number; widthPx?: number }[];
};
const bank4 = parseVisemeBank4(rawBank);

// ── synthetic inputs: a vowel is TWO formants over a voice floor ────────────
const SR = 48000;
const BINS = 1024; // AnalyserNode fftSize 2048

function spectrum(fn: (hz: number) => number): Uint8Array {
  const a = new Uint8Array(BINS);
  for (let i = 0; i < BINS; i++) {
    const hz = (i * (SR / 2)) / BINS;
    a[i] = Math.max(0, Math.min(255, Math.round(fn(hz))));
  }
  return a;
}
const bump = (c: number, w: number, amp: number) => (hz: number) =>
  amp * Math.exp(-((hz - c) ** 2) / (2 * w * w));
const vowel = (f1: number, f2: number) => (hz: number) =>
  30 + 30 * Math.exp(-hz / 3000) + bump(f1, 180, 150)(hz) + bump(f2, 260, 110)(hz);

const SPECTRA = {
  ee: spectrum(vowel(300, 2300)), // spread: high F2
  oo: spectrum(vowel(350, 800)), //  rounded: low F2, low F1
  ah: spectrum(vowel(750, 1200)), // open UNROUNDED: low F2 but HIGH F1
};

/** A speaking-loudness time-domain block (RMS ~0.085, far above the 0.006 floor). */
const TIME = (() => {
  const t = new Float32Array(1024);
  for (let i = 0; i < t.length; i++) t[i] = 0.12 * Math.sin(i / 3);
  return t;
})();

/** The SHIPPED runtime chain: smoothers at 60fps for `ms`, then the v4 pick. */
function speakFor(ms: number, freq: Uint8Array) {
  const osm = createMouthSmoother();
  const rsm = createRoundnessSmoother();
  let o = 0;
  let r = 0.5;
  for (let t = 0; t < ms; t += 16.7) {
    o = osm.step(opennessFromAudio(TIME, freq), 16.7);
    r = rsm.step(roundnessFromAudio(freq, SR), 16.7);
  }
  return { o, r, pick: pickVisemeFrame4(bank4, o, r) };
}

describe("articulation — distinct sounds select distinct bank frames end-to-end", () => {
  it("the shipped bank parses and carries real visual spread on the roundness axis", () => {
    assert.ok(bank4, "visemes3/bank.json must parse as v4");
    // Five roundness columns need at least: a spread (<0.2), an intermediate
    // (0.2..0.8, exclusive of both ends) and a rounded (>0.8) entry among the
    // NON-closed frames — otherwise smoothed roundness has nothing to land on.
    const open = bank4.frames.filter((f) => f.openness > 0.1);
    assert.ok(open.some((f) => f.roundness < 0.2), "no spread open frame");
    assert.ok(open.some((f) => f.roundness > 0.8), "no rounded open frame");
    assert.ok(
      open.some((f) => f.roundness > 0.25 && f.roundness < 0.75),
      "no intermediate-roundness open frame — a smoothed short 'oo' has no target",
    );
    // and the spread is VISUAL, not just labelled: measured lip width must
    // actually widen as roundness falls (widthPx is the builder's measurement)
    const widths = rawBank.frames.filter((f) => typeof f.widthPx === "number");
    assert.ok(widths.length >= 10, "bank entries must carry measured widthPx");
    const spreadW = Math.max(...widths.filter((f) => f.roundness < 0.2).map((f) => f.widthPx as number));
    const roundW = Math.min(...widths.filter((f) => f.roundness > 0.8).map((f) => f.widthPx as number));
    assert.ok(
      spreadW - roundW >= 15,
      `spread lips (${spreadW}px) must be visibly wider than rounded (${roundW}px)`,
    );
  });

  it("EE vs OO: spread and rounded vowels pick DIFFERENT frames", () => {
    const ee = speakFor(150, SPECTRA.ee);
    const oo = speakFor(150, SPECTRA.oo);
    assert.ok(ee.pick && oo.pick);
    assert.notEqual(ee.pick.id, oo.pick.id, "spread and rounded picked the same frame");
    assert.ok(ee.pick.roundness < 0.35, `EE picked ${ee.pick.id} (r=${ee.pick.roundness}) — not a spread mouth`);
    assert.ok(oo.pick.roundness > 0.65, `OO picked ${oo.pick.id} (r=${oo.pick.roundness}) — not a rounded mouth`);
  });

  it("AH does not collapse onto the pucker (the filmed defect)", () => {
    const ah = speakFor(150, SPECTRA.ah);
    assert.ok(ah.pick);
    assert.ok(
      ah.pick.roundness < 0.75,
      `AH picked ${ah.pick.id} (r=${ah.pick.roundness}) — the old bug: every back vowel became "oo"`,
    );
    assert.ok(ah.o > 0.15, `AH must read as an open mouth, got openness ${ah.o}`);
    // and it is distinct from BOTH extremes
    assert.notEqual(ah.pick.id, speakFor(150, SPECTRA.oo).pick?.id);
  });

  it("a SUSTAINED oo reaches the full pucker; a SHORT oo still rounds", () => {
    const long = speakFor(400, SPECTRA.oo);
    assert.ok(long.pick);
    assert.ok(long.r > 0.8, `400ms of oo should saturate roundness, got ${long.r}`);
    assert.ok(long.pick.roundness > 0.8, `sustained oo picked ${long.pick.id}`);
    const short = speakFor(120, SPECTRA.oo);
    assert.ok(short.pick);
    assert.ok(
      short.pick.roundness > 0.5,
      `even 120ms of oo must pick a rounded-side frame, got ${short.pick.id} (r=${short.pick.roundness})`,
    );
  });

  it("silence forces the bilabial closure through the same path", () => {
    const silentTime = new Float32Array(1024); // all zero -> openness 0
    const osm = createMouthSmoother();
    let o = 0.4; // arrive from speech
    for (let t = 0; t < 400; t += 16.7) o = osm.step(opennessFromAudio(silentTime, null), 16.7);
    assert.ok(bank4);
    const pick = pickVisemeFrame4(bank4, o, 0.5);
    assert.ok(pick);
    assert.equal(pick.id, bank4.closedId, "silence must resolve to the closure frame");
  });

  it("roundness alone never moves the mouth: openness stays the dominant axis", () => {
    // At a genuinely shut mouth, every roundness still returns a closed frame —
    // the roundness axis refines WHICH mouth, never whether it is open.
    assert.ok(bank4);
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      const p = pickVisemeFrame4(bank4, 0.02, r);
      assert.ok(p);
      assert.ok(p.openness <= 0.05, `shut mouth at roundness ${r} picked ${p.id} (o=${p.openness})`);
    }
  });
});
