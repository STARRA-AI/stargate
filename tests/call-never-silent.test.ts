/**
 * A BROKEN CALL MUST NEVER PRESENT AS A WORKING QUIET ONE.
 *
 * WHY THIS FILE IS A TEST AND NOT A COMMENT: on 2026-08-06 Classic reported
 * "the call feature is fucked i can't even hear her at all" — no audio, no
 * transcript row, and no ears-struggling cue. Two independent code paths could
 * each produce exactly that, and neither left any evidence behind:
 *
 *   1. `runKimiTurn` did `if (!res.ok || !res.body) return;` — a dead
 *      /api/chat (auth expired, model decommissioned, TPM 413) produced total
 *      silence with no feed line, no UI state, nothing to debug from.
 *
 *   2. `suppressResponseAudioRef` is raised to drop a response we cancelled,
 *      and cleared by `response.done` — which a CANCELLED response is not
 *      guaranteed to send. One unsolicited response could latch the local audio
 *      mute for the entire remaining call.
 *
 * Both are invisible when they regress: the call still connects, she still
 * "works", she is just silent forever. Only a test catches that.
 *
 * These are source-shape assertions (same idiom as call-one-voice.test.ts)
 * because the failure is structural — a `return` with no reporting beside it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = "src/lib/voice/useVoiceCall.ts";
const src = readFileSync(join(REPO, HOOK), "utf8");

/** Slice [from, to) and prove the slice is real, so a rename fails loudly. */
const between = (from: string, to: string) => {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `slice start not found: ${from}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `slice end not found after start: ${to}`);
  return src.slice(start, end);
};

describe("a dead brain is LOUD, never silent", () => {
  it("a non-OK /api/chat reports before it returns", () => {
    const branch = between("if (!res.ok || !res.body) {", "// Same SSE frame parsing");
    assert.match(branch, /postFeedLine\(/, "a failed brain call must reach the ops feed");
    assert.match(branch, /kimiEarsStruggling\(/, "and must light the visible state");
    assert.match(branch, /res\.status/, "and must name the status code");
  });

  it("the bare silent return is gone", () => {
    assert.doesNotMatch(
      src,
      /if \(!res\.ok \|\| !res\.body\) return;/,
      "this exact line cost Classic a night of a mute call",
    );
  });

  it("a real network failure is distinguished from a legitimate abort", () => {
    const branch = between("} catch (err) {", "if (ac.signal.aborted) return;");
    assert.match(branch, /aborted/, "an abort is normal and stays silent");
    assert.match(branch, /postFeedLine\(/, "anything else must be reported");
    assert.match(branch, /kimiEarsStruggling\(/);
  });
});

describe("the audio mute can never outlive its response", () => {
  it("EVERY site that raises the mute also arms the release timer", () => {
    // The flag is raised by the one-voice guard and by kimi barge-in. If a
    // future path raises it without arming the dead-man timer, that path can
    // silence the rest of the call.
    const raises = [...src.matchAll(/suppressResponseAudioRef\.current = true;/g)];
    assert.ok(raises.length >= 2, "expected the one-voice guard and the barge-in path");
    for (const m of raises) {
      const after = src.slice(m.index!, m.index! + 1400);
      assert.match(
        after,
        /armSuppressionRelease\(\)/,
        "a raised mute with no release timer can latch for the whole call",
      );
    }
  });

  it("the release timer exists and is bounded", () => {
    assert.match(src, /const SUPPRESSION_MAX_MS = [\d_]+;/, "the ceiling must be a named constant");
    const ms = Number(/const SUPPRESSION_MAX_MS = ([\d_]+);/.exec(src)![1].replace(/_/g, ""));
    assert.ok(ms > 0 && ms <= 5000, `ceiling must be short and real, got ${ms}ms`);
  });

  it("the timer is cleared on teardown so it cannot cross calls", () => {
    assert.match(
      src,
      /window\.clearTimeout\(suppressReleaseTimerRef\.current\)/,
      "a pending release must not fire into the next call",
    );
  });

  it("the one-voice guard still actually guards", () => {
    // Guarding against the tempting "fix": clearing the mute immediately after
    // raising it would stop the latch AND defeat the guard, letting the
    // stranger's audio through — the exact bug that started all of this.
    const guard = between("case \"response.created\": {", "case \"response.output_audio.done\"");
    assert.match(guard, /suppressResponseAudioRef\.current = true;/);
    assert.match(guard, /response\.cancel/);
    assert.doesNotMatch(
      guard,
      /suppressResponseAudioRef\.current = true;[\s\S]{0,200}?suppressResponseAudioRef\.current = false;/,
      "the mute must not be cleared in the same breath it is raised",
    );
  });
});
