/**
 * FLUIDITY — the pass whose only acceptance test is Classic's: "FULLY FLUID LIKE
 * A REAL PERSON."
 *
 * Every number below is derived from the shipped assets or from the shipped
 * helpers, never chosen to make a test pass. Where a defect is being closed, the
 * OLD behaviour is measured in the same test, so the improvement is a measurement
 * and not a claim. A green assertion here is evidence about the table, NOT
 * evidence that her face looks alive — that is only ever decided by watching her.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  CROSSFADE_MS,
  SPEAKING_BODY_HOLD_MS,
} from "../src/lib/voice/starra-clip-map";
import {
  BODY_MOTION_ROLL_DEG,
  BODY_MOTION_RISE_PX,
  BODY_MOTION_SCALE,
  MOUTH_BLEND_ADJACENT_DIST,
  MOUTH_BLEND_FAR_DIST,
  MOUTH_BLEND_MAX_MS,
  MOUTH_BLEND_MIN_MS,
  MOUTH_REARM_OPENNESS,
  MOUTH_RELEASE_HOLD_MS,
  MOUTH_REST_OPENNESS,
  OPENNESS_AXIS_WEIGHT,
  OPENNESS_STALL_MS,
  RELEASE_MS,
  ROUNDNESS_AXIS_WEIGHT,
  bodyMotionFromEnergy,
  cellDistance,
  createMouthSmoother,
  createReleaseGate,
  createStallGate,
  mouthBlendMs,
  parseVisemeBank4,
  pickVisemeFrame4,
} from "../src/lib/voice/viseme-sync";

const ROOT = resolve(__dirname, "..");
const face = readFileSync(join(ROOT, "src/components/bridge/StarraClipFace.tsx"), "utf8");
const bank = parseVisemeBank4(
  JSON.parse(readFileSync(join(ROOT, "public/avatar/visemes3/bank.json"), "utf8")),
);

// ── 1. THE GHOSTED MOUTH ────────────────────────────────────────────────────
describe("the mouth dissolve is scaled by how far the shape jumped", () => {
  it("cellDistance uses the SAME weighted axes as the lookup it must agree with", () => {
    assert.equal(
      cellDistance({ openness: 0, roundness: 0.5 }, { openness: 1, roundness: 0.5 }),
      OPENNESS_AXIS_WEIGHT,
    );
    assert.equal(
      cellDistance({ openness: 0.5, roundness: 0 }, { openness: 0.5, roundness: 1 }),
      ROUNDNESS_AXIS_WEIGHT,
    );
    // Symmetric, and zero for the same cell (no dissolve at all on a repeat pick).
    const a = { openness: 0.26, roundness: 0.73 };
    const b = { openness: 0.5, roundness: 0.51 };
    assert.equal(cellDistance(a, b), cellDistance(b, a));
    assert.equal(cellDistance(a, a), 0);
  });

  it("is total: a missing or non-finite cell can never produce NaN", () => {
    assert.equal(cellDistance(null, { openness: 0, roundness: 0 }), Infinity);
    assert.equal(cellDistance(undefined, undefined), Infinity);
    const d = cellDistance(
      { openness: Number.NaN, roundness: Number.NaN },
      { openness: 0, roundness: 0.5 },
    );
    assert.ok(Number.isFinite(d), "NaN coordinates read as openness 0 / roundness 0.5");
    assert.equal(d, 0);
  });

  it("adjacent cells of the SHIPPED bank fall inside the adjacent threshold", () => {
    assert.ok(bank, "the shipped visemes3 bank must parse");
    const frames = bank!.frames;
    // For every entry, the distance to its NEAREST neighbour is what a continuous
    // driver walks one step at a time. Every one of them must count as adjacent,
    // or the short dissolve would never be used at all.
    let worstNearest = 0;
    for (const f of frames) {
      let nearest = Infinity;
      for (const g of frames) {
        if (g.id === f.id) continue;
        const d = cellDistance(f, g);
        if (d < nearest) nearest = d;
      }
      if (nearest > worstNearest) worstNearest = nearest;
    }
    assert.ok(
      worstNearest <= MOUTH_BLEND_ADJACENT_DIST,
      `the worst nearest-neighbour distance in the bank is ${worstNearest.toFixed(3)}, ` +
        `which must be <= MOUTH_BLEND_ADJACENT_DIST (${MOUTH_BLEND_ADJACENT_DIST})`,
    );
  });

  it("a one-row openness jump is adjacent, two rows is FAR", () => {
    // The shipped ladder's rows: 0, 0.0263, ~0.2368/0.2632, 0.5, ~0.7368, 0.9474, 1.
    const oneRow = cellDistance({ openness: 0.0, roundness: 0.5 }, { openness: 0.2632, roundness: 0.5 });
    const twoRows = cellDistance({ openness: 0.0, roundness: 0.5 }, { openness: 0.5, roundness: 0.5 });
    assert.ok(oneRow <= MOUTH_BLEND_ADJACENT_DIST, `one row = ${oneRow.toFixed(3)}`);
    assert.ok(twoRows >= MOUTH_BLEND_FAR_DIST, `two rows = ${twoRows.toFixed(3)}`);
    assert.equal(mouthBlendMs(oneRow), MOUTH_BLEND_MIN_MS);
    assert.equal(mouthBlendMs(twoRows), MOUTH_BLEND_MAX_MS);
  });

  it("mouthBlendMs is monotonic, clamped, and total", () => {
    let prev = -1;
    for (let d = 0; d <= 4; d += 0.05) {
      const v = mouthBlendMs(d);
      assert.ok(v >= MOUTH_BLEND_MIN_MS && v <= MOUTH_BLEND_MAX_MS, `blend ${v} out of range at d=${d}`);
      assert.ok(v >= prev - 1e-9, "must never decrease as the jump grows");
      prev = v;
    }
    assert.equal(mouthBlendMs(Number.NaN), MOUTH_BLEND_MAX_MS, "unknown jump takes the softer end");
    assert.equal(mouthBlendMs(Infinity), MOUTH_BLEND_MAX_MS);
    // A swapped min/max must not invert the ramp.
    assert.equal(mouthBlendMs(0, 40, 10), 10);
    assert.equal(mouthBlendMs(99, 40, 10), 40);
  });

  it("caps the visibly-ghosted band at one 60fps frame — it was 40ms", () => {
    // The ghosted band is alpha 0.25..0.75, i.e. HALF the dissolve's length.
    const ghostedNow = MOUTH_BLEND_MAX_MS / 2;
    const ghostedBefore = 80 / 2; // the shipped MOUTH_BLEND_MS before this pass
    assert.ok(ghostedNow <= 16.7, `worst-case ghosted band ${ghostedNow}ms must fit inside one 60fps frame`);
    assert.ok(ghostedNow < ghostedBefore / 2, "and it must be less than half of what it was");
  });
});

// ── 2. THE PATCH SURVIVES THE BODY CROSSFADE ────────────────────────────────
describe("the synced mouth is not suppressed for the whole 320ms body crossfade", () => {
  it("publishes the incoming layer as soon as it can paint, with the rollback intact", () => {
    assert.match(
      face,
      /if \(incoming\.readyState >= 2 && !incoming\.error\) \{\s*\n\s*frontElRef\.current = incoming;/,
      "the incoming layer is published the moment it is playable",
    );
    assert.match(
      face,
      /frontFadingUntilRef\.current = rafNow\(\) \+ CROSSFADE_MS \+ 80;/,
      "and the partial-opacity window is armed on the rAF clock the tick reads",
    );
    assert.match(
      face,
      /\} else \{\s*\n\s*frontElRef\.current = null;\s*\n\s*frontFadingUntilRef\.current = 0;/,
      "a layer that cannot paint yet publishes nothing — today's behaviour",
    );
  });

  it("the tick accepts a partial layer ONLY inside that window, only fading IN, and only once it DOMINATES", () => {
    // The window and the inline target, exactly as before...
    assert.match(
      face,
      /const fadeOpacity =\s*\n\s*now < frontFadingUntilRef\.current && video\.style\.opacity === "1"\s*\n\s*\? computedOpacity\(video\)\s*\n\s*: null;/,
    );
    // ...and the third condition, which is the one that removes the
    // misregistration: the incoming layer must be the picture the viewer sees.
    // A null (unreadable) computed opacity must NOT satisfy it.
    assert.match(
      face,
      /const fadingIn = fadeOpacity !== null && fadeOpacity > PATCH_FADE_MIN_OPACITY;/,
      "an unreadable computed opacity must fall through to the strict rule",
    );
    assert.match(face, /if \(!fadingIn && !isFullyOpaque\(video\)\) return hide\(\);/);
    // computedOpacity must read the LIVE value, not the inline target — the inline
    // value is "1" for the whole blend and would make the threshold meaningless.
    assert.match(
      face,
      /function computedOpacity\(el: HTMLElement\): number \| null \{[\s\S]*?window\.getComputedStyle\(el\)\.opacity/,
    );
    // The window must be closed on BOTH exits of a crossfade, or a later partial
    // layer would be trusted forever.
    const closes = face.match(/frontFadingUntilRef\.current = 0;/g) ?? [];
    assert.ok(closes.length >= 4, `expected the window to be closed on every exit, found ${closes.length}`);
  });

  it("does NOT let the 2s health heartbeat judge a layer mid-blend", () => {
    // The heartbeat used to see frontElRef === null for the whole blend and take
    // its lenient path. Publishing the incoming layer early would have handed it a
    // layer whose decoder can still drop — and its escalation (scheduleBodyRetry)
    // drops `back`.src, which DURING a blend is the outgoing layer still on
    // screen. That is the blank-frame bug, so the old semantics are explicit now.
    // NEGATED, not `<`: rafNow() returns NaN where performance.now() is
    // unreadable, and `NaN < deadline` is false — which would report "no fade in
    // flight" and hand this heartbeat a mid-blend layer, the dangerous answer.
    // `!(NaN >= deadline)` is true, which is the lenient old behaviour.
    assert.match(
      face,
      /const fadeInFlight =\s*\n\s*frontFadingUntilRef\.current > 0 && !\(rafNow\(\) >= frontFadingUntilRef\.current\);/,
    );
    assert.match(face, /const el = fadeInFlight \? null : frontElRef\.current;/);
    // The same NaN, evaluated both ways, must give the SAFE answer in each place.
    const deadline = 1234;
    assert.equal(Number.NaN < deadline, false, "the tick's form reads the window CLOSED under NaN");
    assert.equal(!(Number.NaN >= deadline), true, "the heartbeat's form reads a fade IN FLIGHT under NaN");
  });

  it("indexes the body frame off the PUBLISHED element's own clock", () => {
    assert.match(face, /const bodyFrame = bodyFrameAt\(video\.currentTime\);/);
    assert.match(face, /const box = bodyBoxAt\(bodyKind, pick\.baseBox, bodyFrame\)/);
  });
});

// ── 3. THE BODY SWITCH — MEASURED, AND NOT "FIXED" ──────────────────────────
describe("the body switch still starts the incoming clip at frame 0, on purpose", () => {
  it("keeps the seek at 0 and records the measurement that rejected a matched seek", () => {
    assert.match(face, /back\.currentTime = 0;/, "today's behaviour is kept");
    assert.match(face, /FRAME 0, DELIBERATELY — the seam-matched seek was MEASURED AND REJECTED/);
    // The numbers must stay in the source, or the next session repeats the work.
    assert.match(face, /base_loop's own loop seam \(265 -> 0\):\s+1\.687/);
    assert.match(face, /BEST POSSIBLE pair, base\[i\] -> speak\[j\]: min 4\.424/);
  });
});

// ── 4. THE RELEASE AFTER EVERY TURN ─────────────────────────────────────────
describe("her mouth lets go cleanly when she stops talking", () => {
  /** Run a silence through the REAL smoother and report when each gate fires. */
  const silenceAfterSpeech = (
    speakLevel: number,
    silenceMs: number,
    dt = 1000 / 60,
  ): { releaseAt: number; stallAt: number } => {
    const smoother = createMouthSmoother();
    const release = createReleaseGate();
    const stall = createStallGate();
    // 1s of speech at a normal level, exactly as a live turn arrives.
    for (let t = 0; t < 1000; t += dt) {
      const o = smoother.step(speakLevel, dt);
      release.step(o, dt);
      stall.update(o, dt);
    }
    let releaseAt = -1;
    let stallAt = -1;
    for (let t = 0; t < silenceMs; t += dt) {
      const o = smoother.step(0, dt);
      const r = release.step(o, dt);
      const s = stall.update(o, dt);
      if (r && releaseAt < 0) releaseAt = t;
      if (s && stallAt < 0) stallAt = t;
    }
    return { releaseAt, stallAt };
  };

  it("clears the frozen frame far sooner than the stall gate ever did", () => {
    const { releaseAt, stallAt } = silenceAfterSpeech(0.45, 3000);
    assert.ok(releaseAt > 0, "the release must fire");
    assert.ok(stallAt > 0, "the stall gate must also still fire");
    // MEASURED, not asserted from a comment: the stall gate cannot start counting
    // until the one-pole has decayed past 1e-3, which from 0.45 at RELEASE_MS=110
    // takes ~670ms on its own, so it fired at ~1.37s.
    assert.ok(stallAt > 1300, `the old path cleared at ${Math.round(stallAt)}ms`);
    assert.ok(releaseAt < 800, `the release must clear inside 800ms, measured ${Math.round(releaseAt)}ms`);
    assert.ok(
      stallAt - releaseAt > 550,
      `the release must be at least 550ms earlier; measured ${Math.round(stallAt - releaseAt)}ms`,
    );
  });

  it("tolerates the same real pause the stall gate was tuned for", () => {
    // OPENNESS_STALL_MS's own note names 250-600ms inter-PHRASE pauses as the
    // thing that must NOT clear her mouth. A 600ms gap must leave the patch up.
    const { releaseAt } = silenceAfterSpeech(0.45, 600);
    assert.equal(releaseAt, -1, "a 600ms inter-phrase pause must not release the mouth");
    assert.ok(MOUTH_RELEASE_HOLD_MS < OPENNESS_STALL_MS, "the hold is shorter than the stall window");
  });

  it("is MONOTONIC: once released, only real sound brings the patch back", () => {
    const g = createReleaseGate();
    // Silence past the hold.
    for (let t = 0; t <= MOUTH_RELEASE_HOLD_MS; t += 16) g.step(0, 16);
    assert.equal(g.step(0, 16), true);
    // The decay tail, a re-published layer, a body crossfade — none of these may
    // flicker it back on. Anything at or under the rest band stays released.
    assert.equal(g.step(MOUTH_REST_OPENNESS, 16), true);
    assert.equal(g.step(MOUTH_REST_OPENNESS * 0.9, 100), true);
    // Real sound, clear of the band, re-arms it at once.
    assert.equal(g.step(MOUTH_REARM_OPENNESS + 0.01, 16), false);
    assert.ok(MOUTH_REARM_OPENNESS > MOUTH_REST_OPENNESS, "the band must have hysteresis");
  });

  it("is total, and a long frame cannot jump the hold", () => {
    const g = createReleaseGate();
    assert.equal(g.step(Number.NaN, Number.NaN), false, "a non-finite dt advances nothing");
    // dt is clamped to 250ms exactly as the stall gate clamps it.
    const h = createReleaseGate(500);
    assert.equal(h.step(0, 10_000), false, "one 10s frame must not satisfy a 500ms hold");
    assert.equal(h.step(0, 250), true, "two clamped frames do reach it — 250 + 250");
    const bad = createReleaseGate(Number.NaN, Number.NaN, Number.NaN);
    for (let t = 0; t <= MOUTH_RELEASE_HOLD_MS; t += 50) bad.step(0, 50);
    assert.equal(bad.step(0, 50), true, "junk constants fall back to the defaults");
  });

  it("the rest band sits below anything the bank can draw as an open mouth", () => {
    assert.ok(bank, "the shipped bank must parse");
    // At the rest threshold the lookup must already be a CLOSED mouth, or the
    // release would be letting go of a visibly parted one.
    const pick = pickVisemeFrame4(bank, MOUTH_REST_OPENNESS, 0.5);
    assert.equal(pick?.id, bank!.closedId, "at rest the pick is the bilabial closure");
    assert.ok(RELEASE_MS > 0);
  });

  it("is wired into the tick, unconditionally advanced and latched", () => {
    assert.match(face, /const release = createReleaseGate\(\);/);
    assert.match(face, /const released = release\.step\(openness, dt\);/);
  });

  it("is applied ONLY on the listening body, never over her talking footage", () => {
    // THE DEFECT THIS CLOSES: an unconditional `if (released) return hide();`
    // before the body was known hid the patch while body_speak was still on
    // screen, so the end of every turn showed her real speak_loop footage mouthing
    // words in silence. A frozen shut mouth is the lesser artifact.
    assert.doesNotMatch(
      face,
      /^\s*if \(released\) return hide\(\);/m,
      "the release must not be applied before the body is known",
    );
    assert.match(face, /if \(released && bodyKind === "base"\) return hide\(\);/);
    // ORDERING IS THE FIX: the check must come AFTER bodyKind exists.
    const kindAt = face.indexOf("const bodyKind: BodyKind | null =");
    const relAt = face.indexOf('if (released && bodyKind === "base") return hide();');
    assert.ok(kindAt > 0 && relAt > kindAt, "the release check must sit below the bodyKind derivation");
  });

  it("MEASURES the overlap that makes the body condition necessary", () => {
    // Not asserted from a comment: run the real smoother and the real gate, then
    // compare when the release fires against when the body can still be speak.
    const { releaseAt } = silenceAfterSpeech(0.45, 3000);
    assert.ok(releaseAt > 0, "the release must fire");
    // The body holds body_speak for SPEAKING_BODY_HOLD_MS and then blends for
    // CROSSFADE_MS, so the listening body is not the picture until at least that.
    const bodyBackAt = SPEAKING_BODY_HOLD_MS + CROSSFADE_MS;
    assert.ok(
      releaseAt < bodyBackAt,
      `the release fires at ${Math.round(releaseAt)}ms, before the body is back at ${bodyBackAt}ms — ` +
        "so an unconditional hide() lands over her talking footage",
    );
    // And the size of the overlap, stated rather than implied.
    assert.ok(
      bodyBackAt - releaseAt >= 300,
      `overlap measured ${Math.round(bodyBackAt - releaseAt)}ms`,
    );
  });
});

// ── 5. THE BODY ANSWERS HER VOICE ───────────────────────────────────────────
describe("the body has a continuous response to her speech energy", () => {
  it("is the identity at zero gain or zero energy — today's still body", () => {
    for (const m of [bodyMotionFromEnergy(0, 0, 1), bodyMotionFromEnergy(1, 1, 0)]) {
      assert.equal(m.scale, 1);
      assert.equal(m.tx, 0);
      assert.equal(m.ty, 0);
      assert.equal(m.rotate, 0);
    }
  });

  it("never scales her DOWN, which would expose the letterbox behind her", () => {
    for (let e = 0; e <= 1; e += 0.05) {
      const m = bodyMotionFromEnergy(e, e / 2, 1);
      assert.ok(m.scale >= 1, `scale ${m.scale} at energy ${e}`);
      assert.ok(m.scale <= 1 + BODY_MOTION_SCALE, "and never past the declared amplitude");
      assert.ok(m.ty <= 0 && m.ty >= -BODY_MOTION_RISE_PX, `ty ${m.ty} out of range`);
    }
  });

  it("leans on EMPHASIS — a syllable above her running average, not on volume", () => {
    // Steady speech: fast == slow, so no lean at all.
    assert.equal(bodyMotionFromEnergy(0.6, 0.6, 1).rotate, 0);
    // A burst above the average leans one way; a dip leans the other.
    assert.ok(bodyMotionFromEnergy(0.8, 0.4, 1).rotate > 0);
    assert.ok(bodyMotionFromEnergy(0.2, 0.6, 1).rotate < 0);
    // Bounded, whatever the input.
    for (const [f, s] of [[1, 0], [0, 1], [1, 1], [0.5, 0]] as const) {
      const r = bodyMotionFromEnergy(f, s, 1).rotate;
      assert.ok(Math.abs(r) <= BODY_MOTION_ROLL_DEG, `lean ${r} exceeds the declared amplitude`);
    }
  });

  it("is total — junk in gives the identity out, never NaN in a transform", () => {
    for (const m of [
      bodyMotionFromEnergy(Number.NaN, Number.NaN, Number.NaN),
      bodyMotionFromEnergy(Infinity, -Infinity, 1),
      bodyMotionFromEnergy(5, -5, 1),
    ]) {
      assert.ok(Number.isFinite(m.scale) && Number.isFinite(m.ty) && Number.isFinite(m.rotate));
      assert.ok(m.scale >= 1 && m.scale <= 1 + BODY_MOTION_SCALE);
    }
  });

  it("rides the existing analyser and never transforms the HOST", () => {
    assert.match(face, /const stepBodyMotion = \(energy: number, dtMs: number\): void => \{/);
    assert.match(face, /stepBodyMotion\(openness, dt\);/, "fed the envelope the mouth loop already computed");
    // The host runs deck.css's own presence animation and the .is-collapsed zoom;
    // an inline transform there would silently defeat the collapsed window.
    assert.ok(
      !/hostRef\.current[\s\S]{0,80}\.style\.transform/.test(face),
      "the host's transform belongs to deck.css",
    );
    // The canvas must carry the SAME motion or the patch slides off her face.
    assert.match(face, /canvas\.style\.transform =\s*\n\s*`\$\{motionCss\}translate/);
    assert.match(face, /el\.style\.transformOrigin = "0 0";/);
    // Reduced motion and low power hold her still, exactly as deck.css does.
    assert.match(face, /prefers-reduced-motion: reduce/);
    assert.match(face, /classList\.contains\("low-power"\)/);
    // And the inline declaration is cleared on teardown, never `transform: none`
    // (which does not reset the individual translate/rotate/scale properties).
    assert.match(face, /el\.style\.transform = "";/);
  });
});
