/**
 * THE TEST THAT DID NOT EXIST.
 *
 * Classic, 2026-10-04: "she is not speaking. we cannot hear her and her lips
 * are not synced." The call path had 1964 passing tests at that moment. It
 * could, because the string "destination" appears in ZERO files under tests/
 * and the "never silent" suite is entirely regex over source text — a green
 * suite was fully compatible with total silence.
 *
 * These tests exercise real behaviour instead: a suspended context, a gesture,
 * and an assertion that she became audible. They fail if the recovery is
 * removed, which is the whole point — a test that cannot fail proves nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ensureAudible, type AudibleContext } from "../src/lib/voice/playback-unblock";

/** A fake AudioContext whose state we drive by hand. */
function fakeCtx(state: string) {
  const ctx = {
    state,
    resumeCalls: 0,
    resume() {
      this.resumeCalls++;
      return undefined; // the older WebKit form — deliberately not a promise
    },
  };
  return ctx as typeof ctx & AudibleContext;
}

/** Seams with controllable gesture firing and deferred-check firing. */
function harness(ctx: ReturnType<typeof fakeCtx>, opts?: { getContext?: () => AudibleContext | null }) {
  const reports: string[] = [];
  let gestureHandler: (() => void) | null = null;
  let deferred: (() => void) | null = null;
  let detaches = 0;
  let cancels = 0;

  const seams = {
    getContext: opts?.getContext ?? (() => ctx),
    resume: (c: AudibleContext) => {
      (c as ReturnType<typeof fakeCtx>).resume();
    },
    armGesture: (handler: () => void) => {
      gestureHandler = handler;
      return () => {
        detaches++;
        gestureHandler = null;
      };
    },
    report: (kind: "blocked" | "recovered") => {
      reports.push(kind);
    },
    defer: (fn: () => void, _ms: number) => {
      deferred = fn;
      return () => {
        cancels++;
        deferred = null;
      };
    },
    graceMs: 700,
  };

  return {
    seams,
    reports,
    fireGesture: () => gestureHandler?.(),
    fireGrace: () => deferred?.(),
    hasGesture: () => gestureHandler !== null,
    detaches: () => detaches,
    cancels: () => cancels,
  };
}

describe("a running playback context is left completely alone", () => {
  test("arms nothing, resumes nothing — safe to call on every audio frame", () => {
    const ctx = fakeCtx("running");
    const h = harness(ctx);
    const handle = ensureAudible(ctx, h.seams);

    assert.equal(handle.armed, false, "a healthy context must not arm recovery");
    assert.equal(ctx.resumeCalls, 0, "a running context must never be resumed again");
    assert.equal(h.hasGesture(), false, "no listener may be left on the window");
    assert.deepEqual(h.reports, [], "a healthy call must never post an ALERT");
  });
});

describe("a suspended playback context — she is inaudible and her mouth clock is frozen", () => {
  test("takes one immediate resume attempt and arms gesture recovery", () => {
    const ctx = fakeCtx("suspended");
    const h = harness(ctx);
    const handle = ensureAudible(ctx, h.seams);

    assert.equal(ctx.resumeCalls, 1, "must try to resume her the moment it is noticed");
    assert.equal(handle.armed, true);
    assert.equal(h.hasGesture(), true, "his next click must be able to unblock her");
  });

  test("DOES NOT cry wolf: no report before the grace check, because resume() is async", () => {
    const ctx = fakeCtx("suspended");
    const h = harness(ctx);
    ensureAudible(ctx, h.seams);

    assert.deepEqual(
      h.reports,
      [],
      "reporting synchronously would ALERT on every healthy call whose resume lands late",
    );
  });

  test("a resume that lands during the grace window stays silent — and disarms", () => {
    const ctx = fakeCtx("suspended");
    const h = harness(ctx);
    const handle = ensureAudible(ctx, h.seams);

    ctx.state = "running"; // the queued resume took, as it does on a healthy call
    h.fireGrace();

    assert.deepEqual(h.reports, [], "she became audible on her own — he must not see an ALERT");
    assert.equal(handle.armed, false, "recovery must disarm once she is audible");
    assert.equal(h.detaches(), 1, "the window listener must be removed");
  });

  test("still suspended after the grace window — the failure is LOUD, exactly once", () => {
    const ctx = fakeCtx("suspended");
    const h = harness(ctx);
    ensureAudible(ctx, h.seams);

    h.fireGrace();
    h.fireGrace(); // a second check must not double-report

    assert.deepEqual(h.reports, ["blocked"], "silence must never be the only symptom");
  });
});

describe("his next gesture is what brings her voice through", () => {
  test("a gesture resumes the LIVE context, reports recovery, and detaches", () => {
    const ctx = fakeCtx("suspended");
    const h = harness(ctx);
    const handle = ensureAudible(ctx, h.seams);

    h.fireGrace(); // he has been told she is blocked
    assert.deepEqual(h.reports, ["blocked"]);

    // He clicks the deck. The browser's autoplay policy now permits the resume.
    ctx.state = "running";
    h.fireGesture();

    assert.ok(ctx.resumeCalls >= 2, "the gesture must actually attempt the resume");
    assert.deepEqual(h.reports, ["blocked", "recovered"], "he must be told she is back");
    assert.equal(handle.armed, false);
    assert.equal(h.detaches(), 1, "a one-shot recovery must not keep listening forever");
  });

  test("a gesture that does NOT unblock her keeps listening for the next one", () => {
    const ctx = fakeCtx("suspended");
    const h = harness(ctx);
    const handle = ensureAudible(ctx, h.seams);

    h.fireGesture(); // still suspended afterwards

    assert.equal(handle.armed, true, "one failed gesture must not give up on her");
    assert.equal(h.hasGesture(), true);
    assert.equal(h.detaches(), 0);
  });

  test("re-reads the live context — never resumes a dead handle from a previous call", () => {
    const ctx = fakeCtx("suspended");
    const h = harness(ctx, { getContext: () => null }); // the call ended
    const handle = ensureAudible(ctx, h.seams);

    const before = ctx.resumeCalls;
    h.fireGesture();

    assert.equal(ctx.resumeCalls, before, "a torn-down call must not be resumed");
    assert.equal(handle.armed, false, "it must dispose itself instead");
  });
});

describe("teardown", () => {
  test("dispose removes the listener and cancels the grace check", () => {
    const ctx = fakeCtx("suspended");
    const h = harness(ctx);
    const handle = ensureAudible(ctx, h.seams);

    handle.dispose();

    assert.equal(h.detaches(), 1, "a window listener outliving its call is a leak");
    assert.equal(h.cancels(), 1, "a pending ALERT must not fire after the call is gone");
    assert.equal(handle.armed, false);
  });

  test("dispose is idempotent", () => {
    const ctx = fakeCtx("suspended");
    const h = harness(ctx);
    const handle = ensureAudible(ctx, h.seams);

    handle.dispose();
    handle.dispose();

    assert.equal(h.detaches(), 1);
    assert.equal(h.cancels(), 1);
  });

  test("a report after dispose never reaches him", () => {
    const ctx = fakeCtx("suspended");
    const h = harness(ctx);
    const handle = ensureAudible(ctx, h.seams);

    handle.dispose();
    h.fireGrace(); // the timer had already been cancelled, but prove the guard

    assert.deepEqual(h.reports, []);
  });
});

describe("the wiring is actually connected (regex is the weakest check — it is here only as a tripwire)", () => {
  test("schedulePlayback gates on context state, and connect() proves the resume took", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/lib/voice/useVoiceCall.ts", "utf8");

    assert.match(
      src,
      /if \(ctx\.state !== "running"\) ensurePlaybackRunning\(ctx\)/,
      "the one place that proves audio exists must check it can be heard",
    );
    assert.match(
      src,
      /await settleWithin\(callResume\(playbackContext\), RESUME_TIMEOUT_MS\);[\s\S]{0,900}?ensurePlaybackRunning\(playbackContext\)/,
      "connect() must check the OUTCOME of the bounded resume, not just bound it",
    );
  });
});
