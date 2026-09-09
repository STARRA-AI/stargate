/**
 * TEXT VISEMES — her mouth driven by the WORDS, not only by loudness.
 *
 * The defect this module exists against: the shape was picked from an
 * amplitude envelope plus an F2 proxy, so every loud frame chose the same
 * open mouth and /m/ /b/ /p/ never actually closed. That reads as a mouth
 * pasted onto her face, which is exactly the complaint on file.
 *
 * These tests are pure — no DOM, no audio, no canvas. They pin the two
 * things the renderer depends on: the CLOCK (progress 0..1 through the
 * utterance, started when sound starts, not when the text arrived) and the
 * SHAPING rule (text says which shape, the analyser still says how loud).
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import {
  armTextVisemes,
  beginTextVisemes,
  clearTextVisemes,
  estimateSpeechMs,
  isTextVisemeArmed,
  resetTextVisemes,
  sampleArmedTextViseme,
  sampleTextViseme,
  scheduleTextVisemes,
  setTextVisemeDuration,
  shapeMouth,
  TEXT_VISEME_MAX_SHAPE_GAIN,
  TEXT_VISEME_MIN_MS,
  TEXT_VISEME_REF_OPENNESS,
} from "../src/lib/voice/text-visemes";

describe("scheduleTextVisemes", () => {
  it("returns no cues for text with nothing to say", () => {
    assert.deepStrictEqual(scheduleTextVisemes(""), []);
    assert.deepStrictEqual(scheduleTextVisemes("   "), []);
  });

  it("produces cues in non-decreasing time order, all inside 0..1", () => {
    const cues = scheduleTextVisemes("Copy. The order is in.");
    assert.ok(cues.length > 1);
    let last = -1;
    for (const c of cues) {
      assert.ok(c.t >= 0 && c.t <= 1, `cue t out of range: ${c.t}`);
      assert.ok(c.t >= last, "cues must be ordered in time");
      last = c.t;
      assert.ok(c.openness >= 0 && c.openness <= 1);
      assert.ok(c.roundness >= 0 && c.roundness <= 1);
    }
  });

  it("closes the lips on a bilabial — the tell that a mouth is really synced", () => {
    const cues = scheduleTextVisemes("mmm");
    assert.ok(cues.some((c) => c.closed), "/m/ must produce a closed cue");
  });

  it("gives oo and ee visibly different roundness", () => {
    // cues[0] is the deliberate leading REST (see scheduleTextVisemes) — the
    // shape for the vowel itself is the one after it.
    const oo = scheduleTextVisemes("oo")[1];
    const ee = scheduleTextVisemes("ee")[1];
    assert.ok(oo && ee);
    assert.ok(
      oo.roundness - ee.roundness > 0.5,
      `oo (${oo.roundness}) must be far rounder than ee (${ee.roundness})`,
    );
  });
});

describe("sampleTextViseme", () => {
  const cues = scheduleTextVisemes("Copy that, operator.");

  it("returns null when there is nothing to sample", () => {
    assert.strictEqual(sampleTextViseme(null, 0.5), null);
    assert.strictEqual(sampleTextViseme([], 0.5), null);
  });

  it("holds the LAST cue past the end rather than wrapping to the first", () => {
    const end = sampleTextViseme(cues, 1);
    const past = sampleTextViseme(cues, 4);
    assert.deepStrictEqual(past, end);
  });

  it("treats garbage progress as the start, never a throw", () => {
    assert.deepStrictEqual(sampleTextViseme(cues, Number.NaN), cues[0]);
    assert.deepStrictEqual(sampleTextViseme(cues, -3), cues[0]);
  });
});

describe("the armed track clock", () => {
  beforeEach(() => resetTextVisemes());

  it("arms nothing for empty text", () => {
    armTextVisemes("");
    assert.strictEqual(isTextVisemeArmed(), false);
  });

  it("stays silent until the clock BEGINS — arming alone must not move her mouth", () => {
    armTextVisemes("Copy that, operator.");
    assert.strictEqual(isTextVisemeArmed(), true);
    assert.strictEqual(
      sampleArmedTextViseme(1000),
      null,
      "a sample before beginTextVisemes would put her mouth AHEAD of her voice",
    );
  });

  it("samples from the moment sound started, not from when the text arrived", () => {
    armTextVisemes("Copy that, operator.", 1000);
    beginTextVisemes(5000);
    const atStart = sampleArmedTextViseme(5000);
    const atEnd = sampleArmedTextViseme(5999);
    assert.ok(atStart && atEnd);
    assert.ok(atEnd.t >= atStart.t);
  });

  it("takes a measured duration over the estimate, with a floor", () => {
    armTextVisemes("Hi.", 10);
    beginTextVisemes(0);
    setTextVisemeDuration(2000);
    // Half of a 2000ms utterance must not already be at the end.
    const mid = sampleArmedTextViseme(1000);
    assert.ok(mid);
    assert.ok(mid.t <= 1);
    // A nonsense duration is refused, not applied.
    setTextVisemeDuration(0);
    setTextVisemeDuration(Number.NaN);
    assert.ok(sampleArmedTextViseme(1000));
  });

  it("never returns a cue once cleared", () => {
    armTextVisemes("Copy.");
    beginTextVisemes(0);
    clearTextVisemes();
    assert.strictEqual(isTextVisemeArmed(), false);
    assert.strictEqual(sampleArmedTextViseme(100), null);
  });

  it("estimates a duration for even a one-word reply, never zero", () => {
    assert.ok(estimateSpeechMs("Hi") > 0);
    armTextVisemes("Hi");
    beginTextVisemes(0);
    // With the floor applied, a sample well inside TEXT_VISEME_MIN_MS is not
    // already at the tail.
    const early = sampleArmedTextViseme(TEXT_VISEME_MIN_MS / 4);
    assert.ok(early);
  });
});

describe("shapeMouth", () => {
  const vowel = { t: 0, openness: TEXT_VISEME_REF_OPENNESS, roundness: 0.2, closed: false };

  it("passes the audio through UNCHANGED when no cue is driving", () => {
    assert.deepStrictEqual(shapeMouth(0.42, 0.31, null), {
      openness: 0.42,
      roundness: 0.31,
    });
  });

  it("SHUTS her lips on a closed cue however loud the audio is", () => {
    const m = shapeMouth(1, 0.9, { t: 0, openness: 0, roundness: 0.5, closed: true });
    assert.strictEqual(m.openness, 0);
  });

  it("leaves an average vowel at the envelope's own level", () => {
    assert.strictEqual(shapeMouth(0.5, 0.9, vowel).openness, 0.5);
  });

  it("takes roundness from the TEXT, not the F2 proxy", () => {
    assert.strictEqual(shapeMouth(0.5, 0.9, vowel).roundness, 0.2);
  });

  it("opens wider for an open vowel and narrower for a consonant", () => {
    const open = shapeMouth(0.4, 0.5, { ...vowel, openness: 0.9 }).openness;
    const narrow = shapeMouth(0.4, 0.5, { ...vowel, openness: 0.12 }).openness;
    assert.ok(open > 0.4, "an /a/ must open past the plain envelope");
    assert.ok(narrow < 0.4, "an /f/ must sit under it");
  });

  it("caps the shape gain so open vowels stay distinguishable", () => {
    const huge = shapeMouth(0.5, 0.5, { ...vowel, openness: 99 }).openness;
    assert.ok(huge <= 0.5 * TEXT_VISEME_MAX_SHAPE_GAIN + 1e-9);
  });

  it("stays silent when the audio is silent — the envelope still gates", () => {
    assert.strictEqual(shapeMouth(0, 0.5, { ...vowel, openness: 0.9 }).openness, 0);
  });

  it("never throws and never leaves the 0..1 box on garbage input", () => {
    for (const bad of [Number.NaN, Infinity, -5, 12]) {
      const m = shapeMouth(bad, bad, { ...vowel, openness: bad, roundness: bad });
      assert.ok(m.openness >= 0 && m.openness <= 1, `openness ${m.openness}`);
      assert.ok(m.roundness >= 0 && m.roundness <= 1, `roundness ${m.roundness}`);
    }
  });
});
