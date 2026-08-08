/**
 * THE SPHERE IS ONLY AS ALIVE AS THIS FILE.
 *
 * The deck's reactor moves because these three numbers move. Every one of these
 * assertions is a way the sphere could go dead or go wrong on screen while the
 * audio path itself stays perfectly healthy — which is exactly the class of bug
 * nobody notices until Classic is looking right at it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BAND_COUNT, readBands } from "../src/lib/voice/useAudioBands";

/** A stand-in for AnalyserNode — the real one needs a browser AudioContext. */
function fakeAnalyser(bins: number[]): AnalyserNode {
  return {
    frequencyBinCount: 16,
    getByteFrequencyData(a: Uint8Array) {
      for (let i = 0; i < a.length; i++) a[i] = bins[i] ?? 0;
    },
  } as unknown as AnalyserNode;
}

describe("readBands — her voice becomes three numbers", () => {
  it("normalizes byte bins to 0..1", () => {
    const out = new Float32Array(BAND_COUNT);
    readBands(fakeAnalyser([255, 128, 0]), out);
    assert.equal(out[0], 1);
    assert.ok(Math.abs(out[1] - 128 / 255) < 1e-6);
    assert.equal(out[2], 0);
  });

  it("a null analyser DECAYS toward silence instead of freezing", () => {
    // She stops speaking and the bus hands back null. Holding the last loud
    // frame would freeze the sphere mid-pulse — a deformed blob sitting on the
    // deck looking broken. It has to settle.
    const out = new Float32Array([1, 1, 1]);
    readBands(null, out);
    assert.ok(out[0] < 1, "must decay, not hold the last loud frame");
    assert.ok(out[0] >= 0, "must never go negative");
  });

  it("decays all the way to rest, not to a permanent twitch", () => {
    const out = new Float32Array([1, 1, 1]);
    for (let i = 0; i < 400; i++) readBands(null, out);
    for (let b = 0; b < BAND_COUNT; b++) {
      assert.ok(out[b] < 0.001, `band ${b} never settled: ${out[b]}`);
    }
  });

  it("never returns NaN — one NaN and the canvas draws nothing at all", () => {
    const out = new Float32Array(BAND_COUNT);
    readBands(fakeAnalyser([0, 0, 0]), out);
    for (let b = 0; b < BAND_COUNT; b++) assert.ok(Number.isFinite(out[b]));
    readBands(null, out);
    for (let b = 0; b < BAND_COUNT; b++) assert.ok(Number.isFinite(out[b]));
  });

  it("survives an analyser with fewer bins than bands we want", () => {
    const tiny = {
      frequencyBinCount: 1,
      getByteFrequencyData(a: Uint8Array) { a[0] = 200; },
    } as unknown as AnalyserNode;
    const out = new Float32Array(BAND_COUNT);
    readBands(tiny, out);
    for (let b = 0; b < BAND_COUNT; b++) assert.ok(Number.isFinite(out[b]));
  });

  it("rises immediately when she starts speaking — no lag on attack", () => {
    // Decay is smoothed; attack must not be, or her first syllable is missed.
    const out = new Float32Array(BAND_COUNT);
    readBands(fakeAnalyser([255, 255, 255]), out);
    assert.equal(out[0], 1, "attack must be instant");
  });
});
