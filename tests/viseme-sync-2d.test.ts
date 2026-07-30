/**
 * Mouth sync — the 2-D bank: loader/validator, the 2-D nearest-cell lookup, the
 * bilabial closure threshold, and the roundness smoother. All PURE.
 *
 * WHY THIS SUITE EXISTS. The shipped 1-D bank is indexed by ONE scalar, so "oo"
 * and "ah" render as the SAME mouth whenever they are equally loud, and nothing
 * in it is actually shut. Worse, measured: SIX of the eight shipped frames are
 * visibly CLOSED mouths (v04 openness 0.563 src f103, v05 openness 0.688 src
 * f225), so the shipped openness scale is not monotonic in aperture at all.
 *
 * Run: npx --yes tsx --test tests/*.test.ts   (package.json -> test:v2)
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CLOSURE_OPENNESS,
  F2_NEUTRAL,
  F2_SPAN,
  OPENNESS_AXIS_WEIGHT,
  ROUNDNESS_TAU_MS,
  createRoundnessSmoother,
  parseVisemeBank,
  parseVisemeBank2,
  pickVisemeFrame2,
  roundnessFromAudio,
  type VisemeBank2,
} from "../src/lib/voice/viseme-sync";

// ── fixtures ────────────────────────────────────────────────────────────────
const entry = (
  id: string,
  openness: number,
  roundness: number,
  label = "x",
): VisemeBank2["frames"][number] => ({
  id,
  file: `/avatar/visemes/${id}.png`,
  openness,
  roundness,
  sourceFrame: 0,
  poseConfidence: 0.99,
  label,
  approximation: false,
});

const rawBank2 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 2,
  source: "/avatar/clips/talking.mp4",
  width: 140,
  height: 100,
  fps: 30,
  closedId: "shut",
  frames: [
    { ...entry("shut", 0, 0.5, "closed") },
    { ...entry("oo", 1, 0.9, "oo") },
    { ...entry("ah", 1, 0.1, "ah") },
  ],
  ...over,
});

const bank2 = (frames: VisemeBank2["frames"], closedId = "shut"): VisemeBank2 => ({
  version: 2,
  source: "/avatar/clips/talking.mp4",
  width: 140,
  height: 100,
  fps: 30,
  closedId,
  frames,
});

// ── the validator ───────────────────────────────────────────────────────────
describe("2-D bank — the loader validates, and NEVER throws", () => {
  it("parses a well-formed v2 bank", () => {
    const b = parseVisemeBank2(rawBank2());
    assert.ok(b, "a well-formed v2 bank must parse");
    assert.equal(b.version, 2);
    assert.equal(b.frames.length, 3);
    assert.equal(b.closedId, "shut");
  });

  it("REFUSES a v1 bank — that is the 1-D shape, and must fall back instead", () => {
    assert.equal(parseVisemeBank2(rawBank2({ version: 1 })), null);
  });

  it("refuses frames missing the roundness axis (that is the whole point of v2)", () => {
    const raw = rawBank2({
      frames: [{ id: "a", file: "/a.png", openness: 0.5, sourceFrame: 0 }],
    });
    assert.equal(parseVisemeBank2(raw), null);
  });

  it("refuses an empty or non-array frame list, and bad dimensions", () => {
    assert.equal(parseVisemeBank2(rawBank2({ frames: [] })), null);
    assert.equal(parseVisemeBank2(rawBank2({ frames: "nope" })), null);
    assert.equal(parseVisemeBank2(rawBank2({ width: 0 })), null);
    assert.equal(parseVisemeBank2(rawBank2({ fps: -1 })), null);
  });

  it("never throws on hostile input — a bad file must not break her face", () => {
    for (const bad of [null, undefined, 42, "str", [], {}, { version: 2 },
      { version: 2, frames: [null] }, NaN]) {
      assert.doesNotThrow(() => parseVisemeBank2(bad));
      assert.equal(parseVisemeBank2(bad), null);
    }
  });

  it("clamps both axes into 0..1 rather than trusting the file", () => {
    const b = parseVisemeBank2(
      rawBank2({ frames: [{ ...entry("a", 9, -4) }, { ...entry("b", 0.5, 0.5) }] }),
    );
    assert.ok(b);
    const a = b.frames.find((f) => f.id === "a");
    assert.ok(a);
    assert.equal(a.openness, 1);
    assert.equal(a.roundness, 0);
  });

  it("drops a closedId that names no real frame, rather than dangling", () => {
    const b = parseVisemeBank2(rawBank2({ closedId: "ghost" }));
    assert.ok(b);
    assert.equal(b.closedId, null, "a closedId with no matching frame must become null");
  });
});

// ── the 2-D lookup: the actual defect being fixed ───────────────────────────
describe("2-D lookup — 'oo' and 'ah' stop being the same mouth", () => {
  const frames = [entry("shut", 0, 0.5, "closed"), entry("oo", 1, 0.9, "oo"),
    entry("ah", 1, 0.1, "ah")];

  it("picks the ROUNDED frame for a rounded vowel at full openness", () => {
    const p = pickVisemeFrame2(bank2(frames), 1, 0.9);
    assert.equal(p?.id, "oo");
  });

  it("picks the SPREAD frame for a spread vowel at the SAME openness", () => {
    const p = pickVisemeFrame2(bank2(frames), 1, 0.1);
    assert.equal(p?.id, "ah");
  });

  it("is the same openness in both cases — so ONLY roundness decided it", () => {
    const a = pickVisemeFrame2(bank2(frames), 1, 0.9);
    const b = pickVisemeFrame2(bank2(frames), 1, 0.1);
    assert.notEqual(a?.id, b?.id, "1-D lookup would return the same frame here");
    assert.equal(a?.openness, b?.openness);
  });

  it("lets OPENNESS dominate, because it is the better-measured axis", () => {
    // right openness + wrong roundness must beat wrong openness + right roundness
    const f = [entry("rightOpen", 0.8, 0.0), entry("rightRound", 0.2, 1.0)];
    const p = pickVisemeFrame2(bank2(f, "none"), 0.8, 1.0);
    assert.equal(p?.id, "rightOpen");
    assert.ok(OPENNESS_AXIS_WEIGHT > 1, "openness must be weighted above roundness");
  });

  it("returns null for an empty/absent bank instead of throwing", () => {
    assert.equal(pickVisemeFrame2(null, 0.5, 0.5), null);
    assert.equal(pickVisemeFrame2(undefined, 0.5, 0.5), null);
    assert.equal(pickVisemeFrame2(bank2([], "x"), 0.5, 0.5), null);
  });

  it("treats non-finite input as neutral rather than poisoning the search", () => {
    assert.doesNotThrow(() => pickVisemeFrame2(bank2(frames), NaN, NaN));
    assert.ok(pickVisemeFrame2(bank2(frames), NaN, NaN));
    assert.ok(pickVisemeFrame2(bank2(frames), Infinity, -Infinity));
  });
});

// ── bilabial closure ────────────────────────────────────────────────────────
describe("2-D lookup — /m/ /b/ /p/ actually SHUT", () => {
  // the real defect: with a floor of openness 0.0814 nothing in the 1-D bank was
  // ever closed, so a bilabial could not be drawn at all.
  const frames = [
    entry("leastOpen", 0.08, 0.5, "uh"),
    entry("shut", 0.0, 0.5, "closed"),
    entry("wide", 0.9, 0.5, "ah"),
  ];

  it("selects the dedicated CLOSED frame below the closure threshold", () => {
    const p = pickVisemeFrame2(bank2(frames), CLOSURE_OPENNESS * 0.5, 0.5);
    assert.equal(p?.id, "shut", "must force the real closure, not the least-open frame");
  });

  it("forces closure regardless of what roundness says", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 1]) {
      assert.equal(pickVisemeFrame2(bank2(frames), 0, r)?.id, "shut");
    }
  });

  it("does NOT force closure once she is genuinely open", () => {
    const p = pickVisemeFrame2(bank2(frames), 0.9, 0.5);
    assert.equal(p?.id, "wide");
  });

  it("falls back to nearest when the bank declares no closed frame", () => {
    const p = pickVisemeFrame2(bank2(frames, "missing"), 0, 0.5);
    assert.ok(p, "no closedId must still return a frame");
    assert.equal(p?.id, "shut", "nearest by openness is still the shut one here");
  });

  it("the threshold is small — it must not swallow real speech", () => {
    assert.ok(CLOSURE_OPENNESS > 0 && CLOSURE_OPENNESS <= 0.15,
      `CLOSURE_OPENNESS=${CLOSURE_OPENNESS} must be a small positive floor`);
  });
});

// ── the audio roundness feature ─────────────────────────────────────────────
describe("roundness from audio — a calibrated formant proxy, not a guess", () => {
  // AnalyserNode byte spectrum: bin i covers i*(sampleRate/2)/bins Hz.
  // A vowel is TWO formants, and both matter (recalibrated 2026-07-30 on
  // recorded speech — see the calibration note in viseme-sync.ts): F2 separates
  // rounded (u/o: ~700-1100Hz) from spread (i/e: ~1800-2800Hz), and F1
  // separates the open unrounded /a/ (F1 600-1000Hz) from BOTH — without the
  // F1 penalty, /a/ read as fully rounded and every back vowel became a pucker.
  // Single-bump spectra were retired with that fix: a lone 800Hz peak is
  // ambiguous between /u/'s F2 and /a/'s F1, which is exactly the ambiguity the
  // old formula fell into. A vowel model needs both formants.
  const spectrum = (hzEnergy: (hz: number) => number, bins = 512, sr = 48000): Uint8Array => {
    const a = new Uint8Array(bins);
    for (let i = 0; i < bins; i++) {
      const hz = (i * (sr / 2)) / bins;
      a[i] = Math.max(0, Math.min(255, Math.round(hzEnergy(hz))));
    }
    return a;
  };
  const bump = (centre: number, width: number, amp: number) => (hz: number) =>
    amp * Math.exp(-((hz - centre) ** 2) / (2 * width * width));
  const vowel = (f1: number, f2: number) => (hz: number) =>
    40 + bump(f1, 180, 170)(hz) + bump(f2, 260, 140)(hz);

  it("reads HIGH roundness for a rounded vowel (u: F1 300, F2 800)", () => {
    const r = roundnessFromAudio(spectrum(vowel(300, 800)), 48000);
    assert.ok(r > 0.6, `rounded spectrum should read rounded, got ${r}`);
  });

  it("reads LOW roundness for a spread vowel (i: F1 300, F2 2400)", () => {
    const r = roundnessFromAudio(spectrum(vowel(300, 2400)), 48000);
    assert.ok(r < 0.4, `spread spectrum should read spread, got ${r}`);
  });

  it("does NOT read the open unrounded /a/ as a pucker (the fixed defect)", () => {
    // F1 750 / F2 1200 — low F2 like a rounded vowel, but HIGH F1. The old
    // formula returned 1.0 here (fully rounded -> the "oo" patch on every
    // "ah"); the F1 penalty must keep it at or below neutral.
    const r = roundnessFromAudio(spectrum(vowel(750, 1200)), 48000);
    assert.ok(r <= 0.5, `open /a/ must not read rounded, got ${r}`);
  });

  it("separates rounded from spread by a wide margin", () => {
    const rounded = roundnessFromAudio(spectrum(vowel(300, 800)), 48000);
    const spread = roundnessFromAudio(spectrum(vowel(300, 2400)), 48000);
    assert.ok(rounded - spread > 0.3,
      `want clear separation, got rounded=${rounded} spread=${spread}`);
  });

  it("returns NEUTRAL (0.5) when there is nothing to measure", () => {
    assert.equal(roundnessFromAudio(null, 48000), 0.5);
    assert.equal(roundnessFromAudio(undefined, 48000), 0.5);
    assert.equal(roundnessFromAudio(new Uint8Array(0), 48000), 0.5);
    assert.equal(roundnessFromAudio(new Uint8Array(512), 48000), 0.5, "silence -> neutral");
  });

  it("always returns a finite 0..1 value, whatever the sample rate", () => {
    for (const sr of [8000, 16000, 44100, 48000, 96000, 0, -1, NaN]) {
      const r = roundnessFromAudio(spectrum(bump(1500, 300, 150)), sr);
      assert.ok(Number.isFinite(r), `sr=${sr} produced ${r}`);
      assert.ok(r >= 0 && r <= 1, `sr=${sr} produced out-of-range ${r}`);
    }
  });

  it("is calibrated on the measured decision boundary", () => {
    // Recalibrated 2026-07-30 on recorded speech with band MEANS (class means:
    // f2ratio rounded 0.363-0.383 / spread 0.438-0.449 -> neutral 0.42). The
    // old sum-based boundary (0.6275) was mostly bin-count bias — the mid band
    // holds ~2x the low band's bins.
    assert.ok(F2_NEUTRAL > 0.3 && F2_NEUTRAL < 0.6, "boundary from say-voice measurement");
    assert.ok(F2_SPAN > 0, "span must be positive");
  });
});

// ── the roundness smoother ──────────────────────────────────────────────────
describe("roundness smoother — lips round SLOWER than the jaw drops", () => {
  it("converges toward its target", () => {
    const s = createRoundnessSmoother();
    let v = 0.5;
    for (let i = 0; i < 200; i++) v = s.step(1, 16);
    assert.ok(v > 0.95, `should approach 1, got ${v}`);
  });

  it("starts NEUTRAL, not at zero — zero would mean 'fully spread'", () => {
    assert.equal(createRoundnessSmoother().value(), 0.5);
  });

  it("is SLOWER than the openness attack, so rounding cannot jitter", () => {
    assert.ok(ROUNDNESS_TAU_MS > 35,
      `ROUNDNESS_TAU_MS=${ROUNDNESS_TAU_MS} must exceed ATTACK_MS (35)`);
  });

  it("moves less than an openness-speed smoother would in one frame", () => {
    const s = createRoundnessSmoother();
    const after = s.step(1, 16);
    const fastAlpha = 1 - Math.exp(-16 / 35);
    const fast = 0.5 + (1 - 0.5) * fastAlpha;
    assert.ok(after < fast, `roundness ${after} must lag an openness-rate ${fast}`);
  });

  it("clamps, survives NaN, and resets to neutral", () => {
    const s = createRoundnessSmoother();
    assert.equal(s.step(NaN, 16), 0.5, "NaN target must hold, not poison");
    for (let i = 0; i < 300; i++) s.step(5, 16);
    assert.ok(s.value() <= 1);
    for (let i = 0; i < 300; i++) s.step(-5, 16);
    assert.ok(s.value() >= 0);
    s.reset();
    assert.equal(s.value(), 0.5);
  });

  it("ignores non-advancing time rather than snapping", () => {
    const s = createRoundnessSmoother();
    const before = s.value();
    assert.equal(s.step(1, 0), before);
    assert.equal(s.step(1, -5), before);
    assert.equal(s.step(1, NaN), before);
  });
});

// ── the REAL shipped 2-D assets, not fixtures ───────────────────────────────
// These read public/avatar/visemes/bank2.json off disk and assert the properties
// the rebuild exists to deliver. They fail loudly if the bank is ever re-authored
// in a way that breaks what the renderer assumes.
describe("2-D bank — the SHIPPED bank2.json delivers what it claims", () => {
  const ASSETS = path.join(process.cwd(), "public", "avatar", "visemes");
  const raw = JSON.parse(readFileSync(path.join(ASSETS, "bank2.json"), "utf8"));
  const b2 = parseVisemeBank2(raw);
  const v1 = parseVisemeBank(
    JSON.parse(readFileSync(path.join(ASSETS, "bank.json"), "utf8")),
  );

  it("parses, and was cut from the clip the renderer paints over", () => {
    assert.ok(b2, "shipped bank2.json must parse");
    assert.equal(b2.source, "/avatar/clips/talking.mp4");
  });

  it("matches the 1-D bank's patch geometry, or the loader would refuse it", () => {
    assert.ok(b2 && v1);
    assert.equal(b2.width, v1.width);
    assert.equal(b2.height, v1.height);
  });

  it("every referenced PNG actually exists on disk", () => {
    assert.ok(b2);
    for (const f of b2.frames) {
      const p = path.join(ASSETS, f.file.split("/").pop() as string);
      assert.ok(existsSync(p), `missing patch image for ${f.id}: ${f.file}`);
    }
  });

  it("declares a CLOSED frame that is genuinely shut", () => {
    assert.ok(b2);
    assert.ok(b2.closedId, "a dedicated bilabial frame must be declared");
    const shut = b2.frames.find((f) => f.id === b2.closedId);
    assert.ok(shut, "closedId must resolve to a real frame");
    assert.ok(shut.openness <= 0.02,
      `the closed frame must be shut, got openness ${shut.openness}`);
    assert.equal(shut.label, "closed");
  });

  it("THE FIX: 'oo' and 'ah' exist at the same openness with different lips", () => {
    assert.ok(b2);
    const open = b2.frames.filter((f) => f.openness > 0.9);
    assert.ok(open.length >= 2, "need at least two wide-open shapes");
    const spread = open.reduce((a, f) => (f.roundness < a.roundness ? f : a), open[0]);
    const round = open.reduce((a, f) => (f.roundness > a.roundness ? f : a), open[0]);
    assert.notEqual(spread.id, round.id);
    assert.ok(round.roundness - spread.roundness > 0.3,
      `rounded ${round.roundness} vs spread ${spread.roundness} must differ materially`);
    // and they must be at comparable openness, or openness alone explained it
    assert.ok(Math.abs(round.openness - spread.openness) < 0.15,
      "the two shapes must sit at comparable openness for this to be a 2-D win");
  });

  it("the lookup returns DIFFERENT frames for rounded vs spread when loud", () => {
    assert.ok(b2);
    const a = pickVisemeFrame2(b2, 0.95, 0.95);
    const c = pickVisemeFrame2(b2, 0.95, 0.05);
    assert.ok(a && c);
    assert.notEqual(a.id, c.id, "this is precisely what the 1-D bank could not do");
  });

  it("the lookup FORCES the real closure on a bilabial", () => {
    assert.ok(b2);
    for (const r of [0, 0.5, 1]) {
      assert.equal(pickVisemeFrame2(b2, 0.01, r)?.id, b2.closedId);
    }
  });

  it("is HONEST about coverage — approximations are flagged, not hidden", () => {
    assert.ok(b2);
    const approx = b2.frames.filter((f) => f.approximation);
    // her footage is bimodal in openness, so some requested cells MUST be
    // approximations; a bank claiming none would be lying about her clip.
    assert.ok(approx.length > 0, "expected some cells to be flagged approximate");
    assert.ok(approx.length < b2.frames.length, "not everything can be an approximation");
    assert.equal(typeof raw.coverage?.note, "string", "coverage must be documented");
    assert.equal(raw.coverage?.opennessBimodal, true);
  });

  it("records real provenance for every entry — no invented frames", () => {
    assert.ok(b2);
    for (const f of b2.frames) {
      assert.ok(Number.isInteger(f.sourceFrame) && f.sourceFrame >= 0,
        `${f.id} must name the real source frame it was cut from`);
      assert.ok(f.poseConfidence > 0 && f.poseConfidence <= 1);
      assert.ok(f.label.length > 0, `${f.id} must carry a human-readable label`);
    }
    assert.equal(raw.builder, "scripts/build-viseme-bank-2d.py");
  });

  it("spans openness far better than the 1-D bank it replaces", () => {
    assert.ok(b2 && v1);
    // The shipped 1-D bank's floor is v00 at openness 0.0814 — NOTHING in it is
    // shut, which is why /m/ /b/ /p/ could not be drawn at all.
    assert.ok(v1.frames[0].openness > 0.05,
      "documenting the 1-D defect: its most-closed frame is still open");
    assert.ok(b2.frames[0].openness <= 0.02,
      "the 2-D bank does reach a real closure");
  });
});
