/**
 * HER TALKING — the bounded-timing primitives behind her voice path.
 *
 * WHY THESE ARE PURE AND TESTED HERE. Two confirmed bugs in her voice path were
 * both TIMING bugs, and neither is observable without a browser:
 *
 *   BUG A — the Piper leg raced a 4s deadline against `speakPiper`, which
 *   resolves on its audio element's `ended` (piper-runtime.ts). So the deadline
 *   bounded the WHOLE UTTERANCE: any reply longer than 4 seconds was cut off
 *   mid-word and then re-spoken in full by the next fallback engine, in a
 *   different voice. The fix must bound SYNTHESIS and then PLAY-START, and let
 *   playback of any length run to the end — which is exactly what
 *   `withSynthesisDeadline` + `remainingAudioMs` encode.
 *
 *   BUG B — the Web Speech leg resolved ONLY on `u.onend` / `u.onerror`. A
 *   dropped utterance left that promise pending forever, pinning hudState to
 *   "speaking" and starving the wake loop (useVoiceLoop.ts). The fix is a
 *   watchdog whose window must NEVER cut a healthy long reply short —
 *   `webSpeechWatchdogMs` is that arithmetic, pinned down here rather than
 *   guessed at.
 *
 * THE INVARIANT EVERY TEST BELOW DEFENDS: a bound may end a WEDGE, never a
 * healthy utterance. Her voice outranks every one of these timers.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  WEBSPEECH_MIN_WATCHDOG_MS,
  WEBSPEECH_MS_PER_CHAR,
  beginUtterance,
  isCurrentUtterance,
  webSpeechWatchdogMs,
  withSynthesisDeadline,
} from "../src/lib/voice/speak";
import { remainingAudioMs } from "../src/lib/voice/piper-runtime";
import { callResume, settleWithin } from "../src/lib/voice/useVoiceCall";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A promise that NEVER settles — the shape of every bug fixed here. */
const forever = <T>(): Promise<T> => new Promise<T>(() => {});

describe("withSynthesisDeadline — bounds getting sound out, never the sound", () => {
  it("returns the work's value when it settles inside the deadline", async () => {
    let timeouts = 0;
    const out = await withSynthesisDeadline<boolean>(
      async () => {
        await sleep(10);
        return true;
      },
      500,
      () => {
        timeouts += 1;
      },
    );
    assert.deepEqual(out, { value: true, timedOut: false });
    assert.equal(timeouts, 0, "a healthy utterance must not trip the deadline");
  });

  it("fires the deadline (once) when the work never settles", async () => {
    let timeouts = 0;
    const out = await withSynthesisDeadline<boolean>(
      () => forever<boolean>(),
      40,
      () => {
        timeouts += 1;
      },
    );
    assert.deepEqual(out, { value: null, timedOut: true });
    assert.equal(timeouts, 1);
    await sleep(80);
    assert.equal(timeouts, 1, "the abort hook must never fire twice");
  });

  it("ALWAYS stays armed — there is no way to disarm it into an unbounded await", async () => {
    let seen: unknown = null;
    const out = await withSynthesisDeadline<boolean>(
      (deadline) => {
        seen = deadline;
        return forever<boolean>();
      },
      30,
      () => {},
    );
    assert.equal(out.timedOut, true, "an un-extended deadline must still fire");
    assert.ok(seen && typeof seen === "object");
    assert.equal(
      "disarm" in (seen as object),
      false,
      "exposing disarm() would re-introduce the unbounded await this exists to kill",
    );
    assert.equal(typeof (seen as { extend?: unknown }).extend, "function");
  });

  it("extend() re-arms, so a step that reports progress buys its own window", async () => {
    let timeouts = 0;
    const out = await withSynthesisDeadline<boolean>(
      async (deadline) => {
        await sleep(15);
        deadline.extend(400); // "synthesis done — now bound play-start"
        await sleep(90); // would have blown the original 40ms deadline
        return true;
      },
      40,
      () => {
        timeouts += 1;
      },
    );
    assert.deepEqual(out, { value: true, timedOut: false });
    assert.equal(timeouts, 0);
  });

  it("repeated extend() lets an utterance of ANY length finish (BUG A's fix)", async () => {
    let timeouts = 0;
    const out = await withSynthesisDeadline<boolean>(
      async (deadline) => {
        // Stands in for `timeupdate` firing ~4x/second through a long reply.
        for (let i = 0; i < 8; i++) {
          await sleep(20);
          deadline.extend(60);
        }
        return true;
      },
      30, // the ORIGINAL bug: this 30ms would have bounded all 160ms of playback
      () => {
        timeouts += 1;
      },
    );
    assert.deepEqual(out, { value: true, timedOut: false });
    assert.equal(timeouts, 0, "progress must keep a healthy utterance alive");
  });

  it("a rejected work promise resolves as a plain miss, and never rejects", async () => {
    let timeouts = 0;
    const out = await withSynthesisDeadline<boolean>(
      async () => {
        await sleep(5);
        throw new Error("synth blew up");
      },
      500,
      () => {
        timeouts += 1;
      },
    );
    assert.deepEqual(out, { value: null, timedOut: false });
    assert.equal(timeouts, 0, "a rejection is not a timeout — do not abort twice");
  });

  it("a work factory that throws SYNCHRONOUSLY resolves instead of exploding", async () => {
    const out = await withSynthesisDeadline<boolean>(
      () => {
        throw new Error("import blew up");
      },
      500,
      () => {},
    );
    assert.deepEqual(out, { value: null, timedOut: false });
  });

  it("a throwing abort hook cannot take her voice down with it", async () => {
    const out = await withSynthesisDeadline<boolean>(
      () => forever<boolean>(),
      30,
      () => {
        throw new Error("abort hook blew up");
      },
    );
    assert.deepEqual(out, { value: null, timedOut: true });
  });
});

describe("webSpeechWatchdogMs — a window that can only catch a WEDGE (BUG B)", () => {
  it("floors short lines, which are shorter than the queue delay before onstart", () => {
    assert.equal(webSpeechWatchdogMs("Copy.".length, 0.95), WEBSPEECH_MIN_WATCHDOG_MS);
    assert.equal(webSpeechWatchdogMs(0, 0.95), WEBSPEECH_MIN_WATCHDOG_MS);
  });

  it("gives a realistic 60-SECOND reply at least 1.5x its real duration", () => {
    // ARITHMETIC. A real TTS voice runs ~175 wpm; STARRA_RATE is 0.95
    // (voice-select.ts:12) => ~166 wpm delivered. 60s of speech is therefore
    // ~166 words, and English averages ~6 chars/word incl. the space => ~996
    // chars. The window must comfortably exceed the 60_000ms it really takes.
    const chars = 996;
    const window = webSpeechWatchdogMs(chars, 0.95);
    assert.ok(
      window >= 60_000 * 1.5,
      `a 60s reply must not be cut short: got ${window}ms for ${chars} chars`,
    );
    assert.equal(window, Math.ceil((chars * WEBSPEECH_MS_PER_CHAR) / 0.95));
  });

  it("gives a 30-second reply the same proportional headroom", () => {
    const window = webSpeechWatchdogMs(498, 0.95);
    assert.ok(window >= 30_000 * 1.5, `got ${window}ms`);
  });

  it("scales with the delivery rate — a faster voice needs a shorter window", () => {
    assert.ok(webSpeechWatchdogMs(4000, 2) < webSpeechWatchdogMs(4000, 1));
    assert.ok(webSpeechWatchdogMs(4000, 0.5) > webSpeechWatchdogMs(4000, 1));
  });

  it("never shrinks as the text grows", () => {
    let prev = 0;
    for (const n of [0, 10, 100, 500, 1000, 5000, 20000]) {
      const w = webSpeechWatchdogMs(n, 0.95);
      assert.ok(w >= prev, `non-monotonic at ${n}: ${w} < ${prev}`);
      prev = w;
    }
  });

  it("treats junk inputs as the floor rather than as zero (never a 0ms window)", () => {
    for (const rate of [0, -1, NaN, Infinity]) {
      assert.ok(webSpeechWatchdogMs(50, rate) >= WEBSPEECH_MIN_WATCHDOG_MS);
    }
    for (const chars of [-5, NaN, Infinity]) {
      assert.ok(webSpeechWatchdogMs(chars, 0.95) >= WEBSPEECH_MIN_WATCHDOG_MS);
    }
  });
});

describe("remainingAudioMs — the audio still owed, for a progress re-arm", () => {
  it("is the remaining duration in ms", () => {
    assert.equal(remainingAudioMs(5, 1), 4000);
    assert.equal(remainingAudioMs(0.5, 0), 500);
  });

  it("is 0 when the duration is unknown, so the caller falls back to its floor", () => {
    assert.equal(remainingAudioMs(NaN, 0), 0);
    assert.equal(remainingAudioMs(Infinity, 0), 0);
    assert.equal(remainingAudioMs(0, 0), 0);
    assert.equal(remainingAudioMs(-1, 0), 0);
  });

  it("never goes negative when currentTime has run past duration", () => {
    assert.equal(remainingAudioMs(5, 5), 0);
    assert.equal(remainingAudioMs(5, 9), 0);
  });

  it("assumes nothing has played when currentTime is unreadable", () => {
    assert.equal(remainingAudioMs(3, NaN), 3000);
    assert.equal(remainingAudioMs(3, -1), 3000);
  });
});

describe("utterance generations — a superseded turn may not blank a live one", () => {
  it("hands out a new generation each time and only the newest is current", () => {
    const first = beginUtterance();
    assert.equal(isCurrentUtterance(first), true);

    const second = beginUtterance();
    assert.notEqual(second, first);
    assert.equal(
      isCurrentUtterance(first),
      false,
      "the previous turn's late end/error/pause must become a no-op",
    );
    assert.equal(isCurrentUtterance(second), true);
  });

  it("is strictly monotonic, so a generation is never re-used", () => {
    const seen = new Set<number>();
    let prev = -Infinity;
    for (let i = 0; i < 20; i++) {
      const g = beginUtterance();
      assert.ok(g > prev, `generation went backwards: ${g} <= ${prev}`);
      assert.equal(seen.has(g), false, "a re-used generation would resurrect a stale publisher");
      seen.add(g);
      prev = g;
    }
  });

  it("never treats an unknown/never-issued generation as current", () => {
    const g = beginUtterance();
    assert.equal(isCurrentUtterance(g + 1), false);
    assert.equal(isCurrentUtterance(0), false);
    assert.equal(isCurrentUtterance(NaN), false);
  });
});

describe("settleWithin / callResume — the call leg's unbounded-await fix", () => {
  it("resolves a promise that NEVER settles (the actual bug at connect())", async () => {
    const t0 = Date.now();
    await settleWithin(forever<void>(), 40);
    const dt = Date.now() - t0;
    assert.ok(dt >= 30 && dt < 400, `expected ~40ms, got ${dt}ms`);
  });

  it("resolves as soon as the promise settles, without waiting out the bound", async () => {
    const t0 = Date.now();
    await settleWithin(sleep(5), 2_000);
    assert.ok(Date.now() - t0 < 500, "must not wait for the full bound");
  });

  it("never rejects, even when the awaited promise does", async () => {
    await settleWithin(Promise.reject(new Error("resume failed")), 2_000);
  });

  it("treats a NON-thenable as already settled (old WebKit resume() -> undefined)", async () => {
    const t0 = Date.now();
    await settleWithin(undefined, 10_000);
    assert.ok(Date.now() - t0 < 500, "undefined must not be awaited for 10s");
  });

  it("callResume returns undefined instead of throwing when resume() throws", () => {
    const ctx = {
      resume() {
        throw new Error("InvalidStateError");
      },
    } as unknown as AudioContext;
    assert.equal(callResume(ctx), undefined);
  });

  it("callResume returns undefined when the engine has no resume() at all", () => {
    assert.equal(callResume({} as unknown as AudioContext), undefined);
  });

  it("callResume passes a real promise straight through", async () => {
    const p = Promise.resolve();
    const ctx = { resume: () => p } as unknown as AudioContext;
    assert.equal(callResume(ctx), p);
    await p;
  });
});
