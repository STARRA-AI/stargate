/**
 * HER MOUTH IS CLOCKED OFF THE AUDIO, AND IT MOVES THROUGH SHAPES.
 *
 * THREE PROPERTIES THIS PINS — stated as what the code DOES, not as a repair
 * history. (An earlier version of this header described all three as defects
 * fixed on the call leg. That was wrong: at HEAD the realtime call leg had no
 * text-viseme wiring at all, so none of them could have happened on a call. The
 * typed-chat TTS leg did run on a wall clock against an estimated duration, and
 * items 2 and 3 were real there.)
 *
 *  1. THE POSITION IS READ FROM THE AUDIO, not guessed. Progress is a playback
 *     position over a duration. Because the call leg's denominator GROWS
 *     mid-utterance (audio received so far is a lower bound on the total),
 *     progress = position/duration would walk BACKWARD on every extension — so
 *     every rescale re-pivots, and a ratchet backs that up.
 *  2. THE SHAPES ARE INTERPOLATED, not stepped. sampleTextViseme returns the
 *     point between the bracketing cues, so openness and roundness are
 *     continuous on a bank that is continuous in both axes. (The FRAMES are
 *     quantized — see the ceiling note on sampleTextViseme.)
 *  3. SHAPES ARE COARTICULATED, not computed in isolation. A one-frame consonant
 *     no longer reaches the same aperture as a long vowel.
 *
 * Pure tests — no DOM, no audio, no canvas. Green here is evidence about the
 * arithmetic, NOT evidence that her mouth looks alive: that is decided by
 * watching her on a live turn.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  admissibleShapes,
  armTextVisemes,
  beginTextVisemesOnce,
  coarticulationReach,
  COART_MIN_REACH,
  extendTextVisemeDuration,
  nearestAdmissible,
  resetTextVisemes,
  sampleArmedTextViseme,
  sampleTextViseme,
  scheduleTextVisemes,
  setTextVisemeClockSource,
  textVisemeWeight,
  setTextVisemePosition,
  shapeMouth,
  type TextVisemeCue,
} from "../src/lib/voice/text-visemes";

const LINE = "I am right here with you and I am listening carefully";

describe("the mouth clock takes the AUDIO position over the wall clock", () => {
  beforeEach(() => resetTextVisemes());

  it("a fed position wins over performance.now()", () => {
    armTextVisemes(LINE, 1000);
    beginTextVisemesOnce(0);
    const wall = sampleArmedTextViseme(100); // wall clock: 10% in
    assert.ok(wall);

    resetTextVisemes();
    armTextVisemes(LINE, 1000);
    beginTextVisemesOnce(0);
    setTextVisemePosition(900); // the audio says 90% in
    const fed = sampleArmedTextViseme(100); // same wall clock, different answer
    assert.ok(fed);
    assert.ok(
      fed.t > wall.t,
      `the fed position must drive the schedule (fed t=${fed.t}, wall t=${wall.t})`,
    );
  });

  it("an installed clock source outranks a stale scalar position", () => {
    armTextVisemes(LINE, 1000);
    beginTextVisemesOnce(0);
    setTextVisemePosition(0);
    let audioMs = 0;
    setTextVisemeClockSource(() => audioMs);
    const a = sampleArmedTextViseme(0);
    audioMs = 800;
    const b = sampleArmedTextViseme(0); // wall clock and scalar both unchanged
    assert.ok(a && b);
    assert.ok(b.t > a.t, "the clock is re-read every tick, never cached");
  });

  it("a clock that throws falls back instead of breaking her mouth", () => {
    armTextVisemes(LINE, 1000);
    beginTextVisemesOnce(0);
    setTextVisemeClockSource(() => {
      throw new Error("audio context closed");
    });
    const cue = sampleArmedTextViseme(500);
    assert.ok(cue, "a broken clock must degrade to the wall clock, not to null");
  });

  it("with NO position fed, the wall-clock behaviour is unchanged", () => {
    armTextVisemes(LINE, 1000);
    beginTextVisemesOnce(0);
    const quarter = sampleArmedTextViseme(250);
    const half = sampleArmedTextViseme(500);
    const end = sampleArmedTextViseme(1000);
    assert.ok(quarter && half && end);
    assert.ok(quarter.t < half.t && half.t < end.t);
  });
});

describe("progress NEVER steps backward", () => {
  beforeEach(() => resetTextVisemes());

  it("extending the duration mid-utterance holds the position she is at", () => {
    armTextVisemes(LINE, 1000);
    beginTextVisemesOnce(0);
    let audioMs = 500;
    setTextVisemeClockSource(() => audioMs);
    const before = sampleArmedTextViseme(0); // 500/1000 = halfway
    assert.ok(before);

    // The call leg's hard lower bound on the turn grows. The OLD arithmetic
    // gave 500/2000 = a quarter — her mouth walked back.
    extendTextVisemeDuration(2000);
    const after = sampleArmedTextViseme(0);
    assert.ok(after);
    assert.equal(after.t, before.t, "a rescale must preserve the position, not rewind it");

    // ...and it keeps going FORWARD from there, at the new slower rate.
    audioMs = 700;
    const later = sampleArmedTextViseme(0);
    assert.ok(later);
    assert.ok(later.t >= before.t);
  });

  it("thirty extensions across a turn never produce a single backward step", () => {
    armTextVisemes(LINE, 800);
    beginTextVisemesOnce(0);
    let audioMs = 0;
    setTextVisemeClockSource(() => audioMs);
    let lastT = -1;
    for (let i = 1; i <= 30; i += 1) {
      audioMs = i * 100;
      // Audio arrives faster than it plays — exactly the shape that made the
      // denominator ratchet upward mid-sentence.
      extendTextVisemeDuration(600 + i * 120);
      const cue = sampleArmedTextViseme(0);
      assert.ok(cue);
      assert.ok(cue.t >= lastT, `step ${i}: t went backward (${cue.t} < ${lastT})`);
      lastT = cue.t;
    }
  });

  it("re-arming with MORE text keeps the running clock but rescales the timeline", () => {
    armTextVisemes("Copy that.", 1000);
    beginTextVisemesOnce(0);
    const audioMs = 400;
    setTextVisemeClockSource(() => audioMs);
    const mid = sampleArmedTextViseme(0);
    assert.ok(mid, "sentence one is playing");

    // Sentence two arrives while her voice is still running.
    armTextVisemes("Copy that. The order is in.", 2000, { keepClock: true });
    const after = sampleArmedTextViseme(0);
    assert.ok(after, "keepClock must not drop her mouth to audio-only mid-turn");

    // Without keepClock the clock is NOT running — that is the fresh-turn path.
    armTextVisemes("Copy that. The order is in.", 2000);
    assert.equal(
      sampleArmedTextViseme(0),
      null,
      "a fresh arm waits for begin(), so her mouth can never lead her voice",
    );
  });
});

describe("shapes are interpolated, closures are not", () => {
  const A: TextVisemeCue = { t: 0, openness: 0, roundness: 0.5, closed: false };
  const B: TextVisemeCue = { t: 0.5, openness: 1, roundness: 0, closed: false };
  const pair = [A, B];

  it("returns the point BETWEEN the bracketing cues, not the one behind", () => {
    const q = sampleTextViseme(pair, 0.25);
    assert.ok(q);
    assert.ok(Math.abs(q.openness - 0.5) < 1e-9, `openness=${q.openness}`);
    assert.ok(Math.abs(q.roundness - 0.25) < 1e-9, `roundness=${q.roundness}`);
  });

  it("moves in small steps, never a snap", () => {
    let prev = sampleTextViseme(pair, 0.001);
    assert.ok(prev);
    for (let p = 0.002; p < 0.5; p += 0.001) {
      const cur = sampleTextViseme(pair, p);
      assert.ok(cur);
      assert.ok(
        Math.abs(cur.roundness - prev.roundness) < 0.01,
        `roundness jumped ${Math.abs(cur.roundness - prev.roundness)} at p=${p}`,
      );
      prev = cur;
    }
  });

  it("holds the last cue past the end and the first before the start", () => {
    assert.deepStrictEqual(sampleTextViseme(pair, 4), B);
    assert.deepStrictEqual(sampleTextViseme(pair, 0), A);
    assert.deepStrictEqual(sampleTextViseme(pair, -1), A);
  });

  it("keeps `closed` a HARD boolean so a bilabial still fully shuts", () => {
    const cues: TextVisemeCue[] = [
      { t: 0, openness: 0.6, roundness: 0.2, closed: false },
      { t: 0.4, openness: 0, roundness: 0.5, closed: true },
      { t: 0.6, openness: 0.5, roundness: 0.2, closed: false },
    ];
    const inClosure = sampleTextViseme(cues, 0.45);
    assert.ok(inClosure);
    assert.equal(inClosure.closed, true, "no blended half-closed lips");
    // And the renderer takes it all the way shut however loud she is.
    assert.equal(shapeMouth(1, 0.9, inClosure).openness, 0);
  });

  it("a real word with an /m/ is sampled closed somewhere in its closure", () => {
    const cues = scheduleTextVisemes("mama", 60);
    let sawClosed = false;
    for (let p = 0; p <= 1; p += 0.01) {
      const cue = sampleTextViseme(cues, p);
      if (cue && cue.closed) sawClosed = true;
    }
    assert.ok(sawClosed, "/m/ must be visible as a closure on the sampled track");
  });
});

describe("coarticulation — duration-dependent shapes, nearest admissible", () => {
  it("reach is bounded, monotone, and full only for a long unit", () => {
    assert.equal(coarticulationReach(10), COART_MIN_REACH);
    assert.equal(coarticulationReach(0), COART_MIN_REACH);
    assert.equal(coarticulationReach(Number.NaN), COART_MIN_REACH);
    assert.equal(coarticulationReach(500), 1);
    const short = coarticulationReach(60);
    const mid = coarticulationReach(90);
    assert.ok(short < mid && mid < 1, `${short} < ${mid} < 1`);
  });

  it("a long unit's admissible set is the target itself", () => {
    const set = admissibleShapes(
      { openness: 0, roundness: 0.5 },
      { openness: 0.9, roundness: 0.18 },
      400,
    );
    assert.equal(set.length, 1);
    assert.deepEqual(set[0], { openness: 0.9, roundness: 0.18 });
  });

  it("a short unit may NOT reach the full shape", () => {
    const from = { openness: 0, roundness: 0.5 };
    const target = { openness: 0.9, roundness: 0.18 };
    const set = admissibleShapes(from, target, 40);
    assert.ok(set.length > 1, "a short unit needs a reduced member to choose");
    const picked = nearestAdmissible(from, set);
    assert.ok(picked.openness < target.openness, "a short unit undershoots");
    assert.ok(picked.openness > from.openness, "but it still moves");
  });

  /**
   * NAMED PRECISELY, because the old name ("a real 2D choice") claimed something
   * the production path does not do. Over the set admissibleShapes actually
   * builds, nearestAdmissible is deterministic — the reduced member is never
   * further from `from` than the full target, so it always resolves to
   * `reach >= 1 ? full : reduced`. The 2D distance only becomes load-bearing over
   * a WIDER set, which is why the helper is kept and tested as a general helper.
   */
  it("takes the full target when the unit is long enough to reach it", () => {
    const at = { openness: 0.9, roundness: 0.18 };
    const set = admissibleShapes(at, { openness: 0.9, roundness: 0.18 }, 400);
    assert.equal(set.length, 1, "a long unit has only the full target to land on");
    assert.deepEqual(nearestAdmissible(at, set), { openness: 0.9, roundness: 0.18 });
  });

  it("over the two-member production set the pick is deterministic, not a search", () => {
    const from = { openness: 0.1, roundness: 0.1 };
    const target = { openness: 0.9, roundness: 0.9 };
    const set = admissibleShapes(from, target, 40); // short: reach < 1
    assert.equal(set.length, 2, "[full, reduced]");
    assert.deepEqual(
      nearestAdmissible(from, set),
      set[1],
      "the reduced member is by construction the nearer one — no search happens",
    );
  });

  it("as a GENERAL 2D helper it does pick the nearer member of a wider set", () => {
    // A hand-built set, NOT one admissibleShapes produces: this is the property
    // that makes the helper worth keeping for a future wider set.
    const chosen = nearestAdmissible({ openness: 0.3, roundness: 0.3 }, [
      { openness: 0.9, roundness: 0.9 },
      { openness: 0.35, roundness: 0.35 },
      { openness: 0.05, roundness: 0.8 },
    ]);
    assert.deepEqual(chosen, { openness: 0.35, roundness: 0.35 });
  });

  it("the SAME vowel opens less when it is short — the fix for a stamped mouth", () => {
    const fast = scheduleTextVisemes("sa", 20); // ~40ms on the vowel
    const slow = scheduleTextVisemes("sa", 120); // ~240ms on the vowel
    const peak = (cues: TextVisemeCue[]) =>
      cues.reduce((m, c) => (c.openness > m ? c.openness : m), 0);
    assert.ok(
      peak(fast) < peak(slow) - 0.1,
      `short=${peak(fast)} must be visibly less open than long=${peak(slow)}`,
    );
  });

  it("anticipates the NEXT sound instead of treating each one alone", () => {
    const beforeRound = scheduleTextVisemes("eeoo", 120);
    const beforeSpread = scheduleTextVisemes("eess", 120);
    // cues[0] is the leading rest; cues[1] is the /ee/ in both.
    assert.ok(beforeRound[1] && beforeSpread[1]);
    assert.ok(
      beforeRound[1].roundness > beforeSpread[1].roundness,
      `ee before oo (${beforeRound[1].roundness}) must be rounder than ee before ss (${beforeSpread[1].roundness})`,
    );
  });

  it("still tells oo from ee by a mile, and still shuts on /m/", () => {
    const oo = scheduleTextVisemes("oo", 120)[1];
    const ee = scheduleTextVisemes("ee", 120)[1];
    assert.ok(oo && ee);
    assert.ok(oo.roundness - ee.roundness > 0.5, `oo=${oo.roundness} ee=${ee.roundness}`);
    assert.ok(scheduleTextVisemes("mmm", 60).some((c) => c.closed));
  });

  it("stays inside 0..1 on both axes, ordered in time, for real prose", () => {
    const cues = scheduleTextVisemes(LINE, 52);
    assert.ok(cues.length > 5);
    let last = -1;
    for (const c of cues) {
      assert.ok(c.t >= last, "cues must be ordered in time");
      last = c.t;
      assert.ok(c.openness >= 0 && c.openness <= 1, `openness ${c.openness}`);
      assert.ok(c.roundness >= 0 && c.roundness <= 1, `roundness ${c.roundness}`);
    }
  });
});

/**
 * THE LEVEL CLAIMS IN THE COART DOCSTRING ARE THE MEASURED ONES.
 *
 * The docstring above COART_SHORT_MS states what coarticulation does to her
 * openness levels. A comment asserting a measurement is not evidence — a
 * previous revision of that docstring carried numbers that were simply wrong
 * (48 units / 27 at floor / mean +11.5%). So the numbers live here, where they
 * are recomputed on every run and a constant drifting breaks the build instead
 * of quietly making the comment a lie.
 *
 * HEAD's baselines are literals, taken once from
 * `git show HEAD:src/lib/voice/text-visemes.ts` (pre-coarticulation
 * scheduleTextVisemes, same sentence, same ms/weight). They cannot be recomputed
 * here without vendoring that file, so they are pinned as the fixed reference
 * they are.
 */
describe("the level claims in the COART docstring are the measured ones", () => {
  const SENTENCE = "I am right here with you and I am listening carefully";
  /** Pre-coarticulation schedule, measured from git HEAD. Rate-independent. */
  const HEAD_MEAN_NON_CLOSED = 0.2745;
  const HEAD_PEAK = 0.9;

  function levels(mpw: number) {
    const cues = scheduleTextVisemes(SENTENCE, mpw);
    const nonClosed = cues.filter((c) => !c.closed);
    const total = textVisemeWeight(SENTENCE) * mpw;
    let atFloor = 0;
    let atFull = 0;
    for (let i = 0; i < cues.length; i++) {
      const next = i + 1 < cues.length ? cues[i + 1].t : 1;
      const reach = coarticulationReach((next - cues[i].t) * total);
      if (reach <= COART_MIN_REACH + 1e-9) atFloor += 1;
      if (reach >= 1) atFull += 1;
    }
    return {
      units: cues.length,
      atFloor,
      atFull,
      mean: nonClosed.reduce((a, c) => a + c.openness, 0) / nonClosed.length,
      peak: Math.max(...cues.map((c) => c.openness)),
    };
  }

  it("at her calibrated 52ms/weight: 49 units, 16 at the reach floor, none at full", () => {
    // 28 -> 16 on 2026-10-04 when cues moved from their unit's ONSET to its
    // CENTRE: the inter-cue interval became (w_i + w_i+1)/2 instead of w_i, so
    // short units get a longer travel window and fall off the reach floor.
    // RE-MEASURED, not relaxed — this is still an exact pin, the shapes are
    // byte-identical (mean/peak below are unchanged), and the two assertions
    // that follow still hold their original windows.
    const m = levels(52);
    assert.equal(m.units, 49, "unit count");
    assert.equal(m.atFloor, 16, "units pinned at COART_MIN_REACH");
    assert.equal(m.atFull, 0, "on normal prose at this rate the `full` branch is never taken");
  });

  it("raises the MEAN about 11% and cuts the open-vowel PEAK about 8% — both, not 'unchanged'", () => {
    const m = levels(52);
    const meanPct = ((m.mean - HEAD_MEAN_NON_CLOSED) / HEAD_MEAN_NON_CLOSED) * 100;
    const peakPct = ((m.peak - HEAD_PEAK) / HEAD_PEAK) * 100;
    // Windows, not exact equality: the point is the DIRECTION and the rough
    // magnitude, so retuning a constant a little does not fail the build, while
    // flipping a sign or losing the effect does.
    assert.ok(
      meanPct > 8 && meanPct < 14,
      `mean non-closed openness should rise ~10.7%, got ${meanPct.toFixed(1)}% (${m.mean.toFixed(4)})`,
    );
    assert.ok(
      peakPct < -5 && peakPct > -11,
      `open-vowel peak should fall ~7.6%, got ${peakPct.toFixed(1)}% (${m.peak.toFixed(4)})`,
    );
  });

  it("bites hardest at the FAST rate — at 85ms/weight the peak is untouched", () => {
    const slow = levels(85);
    assert.ok(slow.atFull > 10, `long units should reach full at a slow rate, got ${slow.atFull}`);
    assert.ok(
      Math.abs(slow.peak - HEAD_PEAK) < 1e-6,
      `peak must be untouched at 85ms/weight, got ${slow.peak}`,
    );
  });
});
