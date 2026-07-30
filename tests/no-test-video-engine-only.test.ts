/**
 * NO TEST VIDEO, NO IDLE FALLBACK — ENGINE OUTPUT ON EVERY SPEECH EVENT.
 *
 * Classic's order (2026-07-30, verbatim): "Replace the test winking video with
 * the engine's output on every speech event. When speech is detected — whether
 * you're listening to me or responding — the engine must generate and display
 * the proper lip-synced animation in its place. No test video, no fallback to
 * idle, just the engine's output synced to the audio."
 *
 * What that means in this codebase, pinned here so it cannot regress:
 *
 *   1. talking.mp4 (SPEAKING_CLIP — the clip with the MEASURED wink at
 *      t=1.33-1.43s) is NEVER PLAYED by the face. Not as a fallback, not on any
 *      branch. The export stays (anatomy-v4-bank.test.ts pins the legacy
 *      exports; the v2 bank names it as its source) but no video element ever
 *      receives it.
 *   2. The IDLE POOL is never played by the face either — base_loop.mp4 failing
 *      to load now RETRIES with capped backoff instead of switching clips.
 *   3. The mouth ENGINE is gated on AUDIO TRUTH, not the state machine's label:
 *      it runs whenever a live analyser exists, in EVERY mode. "Listening" with
 *      her audio flowing (barge-in, state lag) still animates; real silence is
 *      handled by the engine's own stall gate, which hides the patch.
 *
 * The gate and the backoff are pure and imported directly; the "never played"
 * claims are structural, so they are enforced on the SOURCE the same way
 * bus-adoption-import-graph.test.ts enforces its discipline — a comment cannot
 * fail, this can.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  nextBodyRetryDelay,
  shouldRunMouthEngine,
} from "../src/components/bridge/StarraClipFace";

const REPO = resolve(import.meta.dirname, "..");
const FACE_SRC = readFileSync(
  join(REPO, "src/components/bridge/StarraClipFace.tsx"),
  "utf8",
);

// Strip comments so a doc sentence mentioning the old behaviour can't fail the
// structural assertions below — only real code counts.
const FACE_CODE = FACE_SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(
  /^\s*\/\/.*$/gm,
  "",
);

describe("engine gate runs on audio truth, not the mode label", () => {
  const analyser = {} as AnalyserNode;

  it("runs in EVERY mode when an analyser exists — listening and responding alike", () => {
    // The input type has NO mode field: the compiler itself forbids wiring the
    // state machine's label back into this decision.
    assert.equal(
      shouldRunMouthEngine({ mouthSyncOn: true, active: true, analyser }),
      true,
    );
  });

  it("never runs without an analyser — no audio, nothing to sync", () => {
    assert.equal(
      shouldRunMouthEngine({ mouthSyncOn: true, active: true, analyser: null }),
      false,
    );
  });

  it("respects the kill switch and the closed overlay", () => {
    assert.equal(
      shouldRunMouthEngine({ mouthSyncOn: false, active: true, analyser }),
      false,
    );
    assert.equal(
      shouldRunMouthEngine({ mouthSyncOn: true, active: false, analyser }),
      false,
    );
  });
});

describe("base_loop failure retries — it never switches to another clip", () => {
  it("backs off 1s, 2s, 4s, then caps at 8s forever", () => {
    assert.equal(nextBodyRetryDelay(0), 1000);
    assert.equal(nextBodyRetryDelay(1), 2000);
    assert.equal(nextBodyRetryDelay(2), 4000);
    assert.equal(nextBodyRetryDelay(3), 8000);
    assert.equal(nextBodyRetryDelay(50), 8000);
  });

  it("is total: any attempt count yields a sane finite delay", () => {
    for (const n of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      const d = nextBodyRetryDelay(n as number);
      assert.ok(Number.isFinite(d) && d >= 1000 && d <= 8000, `attempt ${n} -> ${d}`);
    }
  });
});

describe("structural: the face has no path to the test video or the idle pool", () => {
  it("never plays SPEAKING_CLIP (talking.mp4, the winking clip)", () => {
    assert.ok(
      !/play\(\s*SPEAKING_CLIP/.test(FACE_CODE),
      "StarraClipFace must not play(SPEAKING_CLIP) on any branch",
    );
  });

  it("has no legacy clip-switch or idle-pool playback left", () => {
    for (const symbol of ["legacySwitch", "playIdle", "failToLegacy"]) {
      assert.ok(
        !new RegExp(`\\b${symbol}\\b`).test(FACE_CODE),
        `${symbol} must be gone from StarraClipFace`,
      );
    }
  });

  it("does not gate the engine on the speaking mode", () => {
    assert.ok(
      !/mode\s*!==?\s*"speaking"/.test(FACE_CODE),
      'the engine gate must not test mode !== "speaking"',
    );
  });

  it("wires the retry backoff into the body loader", () => {
    assert.ok(
      /nextBodyRetryDelay\(/.test(FACE_CODE.replace(/export function nextBodyRetryDelay\(/, "")),
      "the failure path must consume nextBodyRetryDelay",
    );
  });
});
