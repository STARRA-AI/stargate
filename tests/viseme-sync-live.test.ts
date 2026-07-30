/**
 * Mouth-sync LIVE-PATH logic — the pure state machines added to fix her mouth
 * drifting, popping and dropping out during real speech.
 *
 * Everything here runs with plain numbers: no DOM, no AudioContext, no rAF.
 * The React/WebAudio wiring that consumes these helpers is NOT covered here
 * (it cannot be, in this harness) — see the report for what was verified how.
 *
 * Run: npx --yes tsx --test tests/*.test.ts   (package.json -> test:v2)
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_OUTPUT_DELAY_MS,
  OPENNESS_SILENT_EPSILON,
  OPENNESS_STALL_MS,
  POSE_CONFIDENCE_CUTOFF,
  POSE_CONFIDENCE_FLOOR,
  audioOutputDelayMs,
  createCrossfadeGate,
  createMouthSmoother,
  createOpennessRing,
  createStallGate,
  poseVisibility,
} from "../src/lib/voice/viseme-sync";

// ── pose ramp ──────────────────────────────────────────────────────────────
// anchor.json's `confidence` is the raw NCC of a rigid nose template: it falls
// as her head rotates off the reference pose. A hard >= 0.93 cut hid the patch
// for 14.1% of frames in ~0.5s and ~1.2s RUNS, handing her mouth back to the
// filmed lips mid-word. A ramp dissolves instead of cutting.
describe("mouth sync — pose confidence ramps, never cliff-edges", () => {
  it("is fully visible at and above the floor", () => {
    assert.equal(poseVisibility({ x: 0, y: 0, w: 1, h: 1, confidence: 1 }), 1);
    assert.equal(
      poseVisibility({ x: 0, y: 0, w: 1, h: 1, confidence: POSE_CONFIDENCE_FLOOR }),
      1,
    );
  });

  it("is fully hidden at and below the cutoff", () => {
    assert.equal(
      poseVisibility({ x: 0, y: 0, w: 1, h: 1, confidence: POSE_CONFIDENCE_CUTOFF }),
      0,
    );
    assert.equal(poseVisibility({ x: 0, y: 0, w: 1, h: 1, confidence: 0.5 }), 0);
  });

  it("ramps monotonically across the band instead of cutting", () => {
    const mid = (POSE_CONFIDENCE_FLOOR + POSE_CONFIDENCE_CUTOFF) / 2;
    const v = poseVisibility({ x: 0, y: 0, w: 1, h: 1, confidence: mid });
    assert.ok(v > 0.4 && v < 0.6, `expected ~0.5, got ${v}`);
    // strictly increasing through the band
    let prev = -1;
    for (let c = POSE_CONFIDENCE_CUTOFF; c <= POSE_CONFIDENCE_FLOOR; c += 0.01) {
      const cur = poseVisibility({ x: 0, y: 0, w: 1, h: 1, confidence: c });
      assert.ok(cur >= prev, `not monotonic at ${c}: ${cur} < ${prev}`);
      prev = cur;
    }
  });

  it("covers the real worst frame of the shipped track (NCC 0.828) partially, not zero", () => {
    // frame 18 of public/avatar/visemes/anchor.json, inside the 7-20 run
    const v = poseVisibility({ x: 294, y: 385, w: 140, h: 100, confidence: 0.828 });
    assert.ok(v > 0, "the worst frame of run 1 must still show SOME patch");
    assert.ok(v < 1, "and must not be at full strength");
  });

  it("treats a missing box or garbage confidence as hidden, never NaN", () => {
    assert.equal(poseVisibility(null), 0);
    assert.equal(poseVisibility(undefined), 0);
    assert.equal(
      poseVisibility({ x: 0, y: 0, w: 1, h: 1, confidence: Number.NaN }),
      0,
    );
  });
});

// ── output-latency compensation ────────────────────────────────────────────
// An AnalyserNode reports audio BEFORE the DAC plays it, so her mouth LEADS the
// sound. Both fields are absent on the macOS 12 WKWebView, so every read has to
// degrade to 0 rather than to NaN (NaN would freeze the ring lookup).
describe("mouth sync — audio output delay", () => {
  it("sums baseLatency + outputLatency into milliseconds", () => {
    assert.equal(audioOutputDelayMs({ baseLatency: 0.01, outputLatency: 0.02 }), 30);
  });

  it("falls back to 0 when the fields are missing (macOS 12 WKWebView)", () => {
    assert.equal(audioOutputDelayMs({}), 0);
    assert.equal(audioOutputDelayMs(null), 0);
    assert.equal(audioOutputDelayMs(undefined), 0);
    assert.equal(audioOutputDelayMs({ baseLatency: undefined, outputLatency: undefined }), 0);
  });

  it("ignores a single garbage field but keeps the good one", () => {
    assert.equal(audioOutputDelayMs({ baseLatency: Number.NaN, outputLatency: 0.02 }), 20);
    assert.equal(audioOutputDelayMs({ baseLatency: 0.01, outputLatency: -5 }), 10);
  });

  it("clamps a bogus reading so it can never freeze her mouth", () => {
    assert.equal(audioOutputDelayMs({ outputLatency: 99 }), MAX_OUTPUT_DELAY_MS);
    assert.ok(MAX_OUTPUT_DELAY_MS <= 400);
  });
});

// ── openness ring ──────────────────────────────────────────────────────────
describe("mouth sync — openness ring buffer (latency compensation)", () => {
  it("reads back a value written at the same timestamp", () => {
    const ring = createOpennessRing(8);
    ring.push(1000, 0.5);
    assert.equal(ring.sample(1000), 0.5);
  });

  it("returns 0 while empty, so a cold ring shows a closed mouth not NaN", () => {
    assert.equal(createOpennessRing(8).sample(1000), 0);
  });

  it("interpolates between two samples", () => {
    const ring = createOpennessRing(8);
    ring.push(1000, 0);
    ring.push(1100, 1);
    assert.equal(ring.sample(1050), 0.5);
    assert.equal(ring.sample(1025), 0.25);
  });

  it("delays by the requested amount — the whole point of the buffer", () => {
    const ring = createOpennessRing(64);
    // 16ms frames of a rising ramp
    for (let i = 0; i <= 20; i++) ring.push(1000 + i * 16, i / 20);
    const now = 1000 + 20 * 16;
    const live = ring.sample(now);
    const delayed = ring.sample(now - 160); // 160ms behind
    assert.equal(live, 1);
    assert.ok(delayed < live, "a delayed read must lag the live value");
    assert.ok(Math.abs(delayed - 0.5) < 0.01, `expected ~0.5, got ${delayed}`);
  });

  it("clamps a read before the oldest sample to the oldest value", () => {
    const ring = createOpennessRing(8);
    ring.push(1000, 0.4);
    ring.push(1100, 0.9);
    assert.equal(ring.sample(0), 0.4);
  });

  it("clamps a read past the newest sample to the newest value", () => {
    const ring = createOpennessRing(8);
    ring.push(1000, 0.4);
    ring.push(1100, 0.9);
    assert.equal(ring.sample(99999), 0.9);
  });

  it("overwrites oldest-first once capacity is reached and stays ordered", () => {
    const ring = createOpennessRing(4);
    for (let i = 0; i < 10; i++) ring.push(1000 + i * 10, i / 10);
    assert.equal(ring.size(), 4);
    // newest is i=9 at t=1090
    assert.equal(ring.sample(1090), 0.9);
    // oldest retained is i=6 at t=1060; anything older clamps to it
    assert.ok(Math.abs(ring.sample(0) - 0.6) < 1e-9, `got ${ring.sample(0)}`);
  });

  it("survives garbage input without poisoning later reads", () => {
    const ring = createOpennessRing(8);
    ring.push(Number.NaN, 0.5);
    ring.push(1000, Number.NaN);
    ring.push(1100, Number.POSITIVE_INFINITY);
    assert.equal(ring.size(), 0, "non-finite pushes must be dropped");
    ring.push(1200, 0.7);
    assert.equal(ring.sample(1200), 0.7);
  });

  it("clamps stored values into 0..1", () => {
    const ring = createOpennessRing(8);
    ring.push(1000, 5);
    ring.push(1100, -3);
    assert.equal(ring.sample(1000), 1);
    assert.equal(ring.sample(1100), 0);
  });

  it("a non-finite read time returns the newest value, not NaN", () => {
    const ring = createOpennessRing(8);
    ring.push(1000, 0.3);
    assert.equal(ring.sample(Number.NaN), 0.3);
  });

  it("reset empties it", () => {
    const ring = createOpennessRing(8);
    ring.push(1000, 0.3);
    ring.reset();
    assert.equal(ring.size(), 0);
    assert.equal(ring.sample(1000), 0);
  });
});

// ── stall gate ─────────────────────────────────────────────────────────────
// If the analyser never sees audio (the real bug: TTS played through a bare
// `new Audio()` with no analyser at all), openness pins at 0 and the bank's
// FLOOR frame — v00, openness 0.0814, a slightly OPEN mouth — got stamped over
// her filmed mouth for the whole reply. Detect the stall and hide the canvas.
describe("mouth sync — silent-analyser stall gate", () => {
  it("stays open while there is any audio", () => {
    const gate = createStallGate();
    for (let i = 0; i < 100; i++) {
      assert.equal(gate.update(0.4, 16), false, `stalled at frame ${i}`);
    }
  });

  it("does not trip before the stall window elapses", () => {
    const gate = createStallGate();
    assert.equal(gate.update(0, 100), false);
    assert.equal(gate.update(0, 100), false);
  });

  it("trips once openness has been zero past the window", () => {
    const gate = createStallGate();
    let tripped = false;
    for (let t = 0; t <= OPENNESS_STALL_MS + 100; t += 16) {
      tripped = gate.update(0, 16);
    }
    assert.equal(tripped, true, "a permanently silent analyser must hide the patch");
  });

  it("recovers the instant real audio arrives", () => {
    const gate = createStallGate();
    for (let t = 0; t <= OPENNESS_STALL_MS + 100; t += 16) gate.update(0, 16);
    assert.equal(gate.update(0.5, 16), false, "audio must un-hide her mouth at once");
    assert.equal(gate.update(0, 16), false, "and the timer must restart from there");
  });

  it("does not accumulate across a reset (a new utterance starts clean)", () => {
    const gate = createStallGate();
    for (let t = 0; t <= OPENNESS_STALL_MS + 100; t += 16) gate.update(0, 16);
    gate.reset();
    assert.equal(gate.update(0, 16), false);
  });

  it("treats a garbage dt as zero elapsed rather than instantly tripping", () => {
    const gate = createStallGate();
    assert.equal(gate.update(0, Number.NaN), false);
    assert.equal(gate.update(0, Number.POSITIVE_INFINITY), false);
    assert.equal(gate.update(0, -50), false);
  });

  it("a real silent gap between words does NOT trip it at 60fps", () => {
    // a ~120ms inter-word pause is shorter than the window, so her mouth keeps
    // its patch and simply closes — it must not flicker back to filmed lips.
    const gate = createStallGate();
    let tripped = false;
    for (let t = 0; t < 120; t += 16) tripped = gate.update(0, 16);
    assert.equal(tripped, false);
  });

  // ── THE WARM-DECAY HOLE (board finding) ─────────────────────────────────
  // Every test above starts the gate COLD, feeding it a literal 0. In the real
  // renderer the gate is fed `smoother.step(...)`, and createMouthSmoother is a
  // one-pole (`v += (t - v) * alpha`): once v is non-zero it decays
  // asymptotically and is NEVER exactly 0 again. With `openness > 0` the gate
  // therefore only ever tripped from a cold start — so the frozen half-open
  // stamp it exists to prevent could still be drawn for the whole reply.
  it("trips when a WARM one-pole decay approaches zero without reaching it", () => {
    const smoother = createMouthSmoother();
    const gate = createStallGate();
    // 320ms of real speech: the smoother is now warm.
    for (let t = 0; t < 320; t += 16) gate.update(smoother.step(0.5, 16), 16);
    assert.ok(smoother.value() > 0.4, "smoother should be warm before the silence");

    // Then the analyser dies: 9.6s of true silence at 60fps.
    let tripped = false;
    for (let t = 0; t < 9600; t += 16) tripped = gate.update(smoother.step(0, 16), 16);

    assert.ok(
      smoother.value() > 0,
      `one-pole never reaches exactly 0 (got ${smoother.value()})`,
    );
    assert.equal(
      tripped,
      true,
      `a dead analyser must hide the patch even from a warm decay (openness ${smoother.value()})`,
    );
  });

  it("treats a level far below visible movement as silence", () => {
    const gate = createStallGate();
    let tripped = false;
    // 1e-30 is arithmetically non-zero and visually nothing at all.
    for (let t = 0; t <= OPENNESS_STALL_MS + 100; t += 16) tripped = gate.update(1e-30, 16);
    assert.equal(tripped, true);
  });

  it("still holds open for any level that could actually move her mouth", () => {
    // The bank's most-closed frame is openness 0.0814, so anything the renderer
    // can draw is orders of magnitude above the epsilon.
    const gate = createStallGate();
    let tripped = false;
    for (let t = 0; t <= OPENNESS_STALL_MS + 100; t += 16) tripped = gate.update(0.0814, 16);
    assert.equal(tripped, false, "a drawable openness must never read as a stall");
    assert.ok(
      OPENNESS_SILENT_EPSILON < 0.0814 / 10,
      "the epsilon must sit far below the most-closed drawable frame",
    );
  });
});

// ── crossfade generation gate ───────────────────────────────────────────────
// StarraClipFace registers a per-crossfade `transitionend` settle that publishes
// the incoming <video> as the visible layer. A second crossfade inside
// CROSSFADE_MS used to leave the FIRST settle live: fading that element back out
// fired it, and it pointed frontElRef at a now-HIDDEN layer — killing the mouth
// patch for the rest of the speaking turn. A monotonic token makes any settle
// from a superseded crossfade a no-op.
describe("mouth sync — crossfade generation gate", () => {
  it("the freshly begun crossfade is the current one", () => {
    const gate = createCrossfadeGate();
    const gen = gate.begin();
    assert.equal(gate.isCurrent(gen), true);
  });

  it("a superseded crossfade's settle is a no-op", () => {
    const gate = createCrossfadeGate();
    const a = gate.begin(); // barge-in -> idle
    const b = gate.begin(); // queued utterance -> back to talking.mp4
    assert.notEqual(a, b);
    assert.equal(gate.isCurrent(a), false, "A's stale settle must not publish a hidden layer");
    assert.equal(gate.isCurrent(b), true);
  });

  it("tokens are monotonic, so a token can never be reused", () => {
    const gate = createCrossfadeGate();
    let prev = gate.begin();
    for (let i = 0; i < 50; i++) {
      const next = gate.begin();
      assert.ok(next > prev, "tokens must increase");
      prev = next;
    }
  });

  it("cancelAll invalidates even the newest crossfade (unmount)", () => {
    const gate = createCrossfadeGate();
    const gen = gate.begin();
    gate.cancelAll();
    assert.equal(gate.isCurrent(gen), false);
  });

  it("never treats a bogus token as current", () => {
    const gate = createCrossfadeGate();
    gate.begin();
    assert.equal(gate.isCurrent(Number.NaN), false);
    assert.equal(gate.isCurrent(0), false);
    assert.equal(gate.isCurrent(Number.POSITIVE_INFINITY), false);
  });
});
