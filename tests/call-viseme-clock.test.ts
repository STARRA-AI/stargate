/**
 * THE CALL LEG'S MOUTH CLOCK.
 *
 * WHAT THIS IS, stated without inventing a history: before this change the
 * realtime call leg had NO text-viseme wiring at all — it drove her mouth from
 * audio amplitude alone, so nothing on a call could step backward or pin to the
 * rest shape. The wiring is new here, and these tests pin the two ways it can
 * be wired WRONG:
 *
 *   1. THE PRIMITIVE. beginTextVisemes() re-stamps `startedAt` unconditionally.
 *      A publisher whose only per-audio hook lands many times a second (which is
 *      exactly the shape of the realtime leg) would reset the clock on every
 *      call: elapsed stays ~0, progress never advances, and
 *      sampleArmedTextViseme hands back cues[0] — the rest shape — for the whole
 *      utterance. beginTextVisemesOnce is the guard; the first two tests
 *      demonstrate both sides of it.
 *
 *   2. THE WIRING. The unit tests would stay green with the call leg calling the
 *      unguarded begin, or gating the clock on a per-turn flag instead of on the
 *      armed track. The source-text suite at the bottom is what pins the real
 *      call path.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeEach } from "node:test";

import {
  armTextVisemes,
  beginTextVisemes,
  beginTextVisemesOnce,
  clearTextVisemes,
  extendTextVisemeDuration,
  isTextVisemeStarted,
  resetTextVisemes,
  sampleArmedTextViseme,
  textVisemeWeight,
} from "../src/lib/voice/text-visemes";

const LINE = "I am right here with you and I am listening carefully";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("call leg mouth clock", () => {
  beforeEach(() => resetTextVisemes());

  it("THE HAZARD: re-stamping on every delta pins her mouth at the opening rest cue", () => {
    armTextVisemes(LINE, 4000);
    beginTextVisemes(0);
    let last = null;
    // 40 deltas across a 4s turn — the delta RATE the realtime leg sees. This
    // is what the unguarded primitive would do if a publisher used it; the call
    // leg does not (the wiring suite below pins that).
    for (let t = 100; t <= 4000; t += 100) {
      beginTextVisemes(t);
      last = sampleArmedTextViseme(t);
    }
    assert.ok(last, "a cue should still be produced");
    // elapsed is always ~0, so it never leaves cues[0] — the rest shape.
    assert.equal(last.openness, 0, "an unguarded begin holds her mouth shut/neutral all turn");
  });

  it("THE FIX: beginTextVisemesOnce anchors the clock so her mouth advances", () => {
    armTextVisemes(LINE, 4000);
    beginTextVisemesOnce(0);
    const shapes = new Set<string>();
    for (let t = 100; t <= 4000; t += 100) {
      beginTextVisemesOnce(t); // later deltas must NOT move the anchor
      const cue = sampleArmedTextViseme(t);
      if (cue) shapes.add(`${cue.openness}:${cue.roundness}:${cue.closed}`);
    }
    assert.ok(shapes.size > 3, `her mouth should move through shapes, saw ${shapes.size}`);
  });

  it("a fresh arm re-opens the clock for the next turn", () => {
    armTextVisemes(LINE, 4000);
    beginTextVisemesOnce(0);
    assert.ok(sampleArmedTextViseme(2000));
    armTextVisemes(LINE, 4000);
    beginTextVisemesOnce(10_000);
    const next = sampleArmedTextViseme(10_000);
    assert.ok(next);
    assert.equal(next.openness, 0, "a new turn starts back at rest");
  });

  it("extendTextVisemeDuration only ever grows — never jumps her mouth backwards", () => {
    armTextVisemes(LINE, 1000);
    beginTextVisemesOnce(0);
    extendTextVisemeDuration(3000);
    const grown = sampleArmedTextViseme(1500);
    extendTextVisemeDuration(500); // shorter: must be ignored
    const same = sampleArmedTextViseme(1500);
    assert.deepEqual(grown, same, "a shorter duration must not re-scale the timeline");
  });

  /**
   * ★ THE DEAD-END THIS DIVISION SHIPPED AND THIS TEST FORBIDS (2026-09-30).
   * The exact sequence a streamed reply produces:
   *   sentence 1 arms, begins, and gets a clock;
   *   her voice stops -> source.onended fires clearTextVisemes (the track dies);
   *   sentence 2 re-arms with the accumulated text and keepClock.
   * keepClock can only carry a RUNNING track over, and there is none left, so
   * the re-armed track is `started: false`. Nothing produced a cue from here to
   * the end of the reply. The publisher's gate has to notice that.
   */
  it("a mid-turn re-arm after the track was dropped is still gateable and still runs", () => {
    armTextVisemes("She is right here.", 1200);
    beginTextVisemesOnce(0);
    assert.equal(isTextVisemeStarted(), true, "sentence 1 is running");
    assert.ok(sampleArmedTextViseme(600), "sentence 1 produces shapes");

    // Her voice stopped between the two sentences' responses.
    clearTextVisemes();
    assert.equal(isTextVisemeStarted(), false, "the dropped track must read as NOT started");

    // Sentence 2 re-arms the accumulated utterance, asking to keep the clock.
    armTextVisemes("She is right here. She is listening carefully.", 2600, {
      keepClock: true,
    });
    // THE GATE: a per-turn boolean is still true here, so it would skip the
    // install and leave her mouth dead. isTextVisemeStarted() reports the truth.
    assert.equal(
      isTextVisemeStarted(),
      false,
      "keepClock cannot carry over a track that no longer exists — the gate must re-open",
    );
    beginTextVisemesOnce(1300);
    assert.equal(isTextVisemeStarted(), true);

    const cue = sampleArmedTextViseme(1900);
    assert.ok(cue, "sentence 2 must have a shape track — this is the dead-end assertion");
    const shapes = new Set();
    for (let t = 1300; t <= 3900; t += 100) {
      const c = sampleArmedTextViseme(t);
      if (c) shapes.add(`${c.openness}:${c.roundness}:${c.closed}`);
    }
    assert.ok(shapes.size > 3, `sentence 2's mouth must MOVE, saw ${shapes.size} shapes`);
  });

  /** keepClock on a track that IS still running must not restart her mouth. */
  it("a mid-turn re-arm while her voice is still going keeps the clock running", () => {
    armTextVisemes("She is right here.", 1200);
    beginTextVisemesOnce(0);
    assert.ok(sampleArmedTextViseme(600));
    armTextVisemes("She is right here. She is listening carefully.", 2600, {
      keepClock: true,
    });
    assert.equal(
      isTextVisemeStarted(),
      true,
      "a running track must be carried over, not restarted",
    );
    const cue = sampleArmedTextViseme(700);
    assert.ok(cue);
    // Word POSITION is what stays continuous: 600ms into a 1200ms sentence is
    // the same audio as 600ms into the 2600ms two-sentence schedule.
    assert.ok(cue.openness >= 0 && cue.openness <= 1);
  });

  it("textVisemeWeight gives a positive denominator that scales with length", () => {
    const short = textVisemeWeight("hi");
    const long = textVisemeWeight(LINE);
    assert.ok(short > 0, "weight must be positive");
    assert.ok(long > short, "a longer line must weigh more");
  });
});

/**
 * THE WIRING. The unit tests above prove the primitives. They would stay green
 * with useVoiceCall.ts still calling the unguarded begin on every delta — which
 * is exactly how this defect survived a 1,800-test suite. These assertions pin
 * the REAL call path, in the source-text idiom this repo already uses for the
 * one-voice guards (see tests/call-one-voice.test.ts).
 */
describe("the call leg is wired to the guarded clock", () => {
  const src = readFileSync(join(REPO, "src/lib/voice/useVoiceCall.ts"), "utf8");

  it("never imports the unguarded beginTextVisemes", () => {
    assert.doesNotMatch(
      src,
      /^\s*beginTextVisemes,\s*$/m,
      "the call leg must use beginTextVisemesOnce — the unguarded one re-stamps the clock on every delta",
    );
  });

  it("does not start her mouth clock in the audio-delta handler", () => {
    const handler = src.slice(
      src.indexOf('case "response.output_audio.delta":'),
      src.indexOf('case "response.created":'),
    );
    assert.ok(handler.length > 0, "the delta handler must still exist");
    assert.doesNotMatch(
      handler.slice(0, handler.indexOf("if (LIPSYNC_ENABLED)")),
      /beginTextVisemes/,
      "a delta ARRIVING is not sound LEAVING THE SPEAKERS — the clock starts in schedulePlayback",
    );
  });

  it("starts her mouth when she is audible, offset by the playback lead", () => {
    const fn = src.slice(src.indexOf("const schedulePlayback"));
    assert.match(fn, /startAt - ctx\.currentTime/, "the queue backlog must be measured");
    assert.match(
      fn,
      /beginTextVisemesOnce\(performance\.now\(\) \+ leadMs\)/,
      "the clock must be stamped at the audible moment, in the renderer's timeline",
    );
  });

  it("grows the schedule with the audio it has actually received", () => {
    const fn = src.slice(src.indexOf("const schedulePlayback"));
    assert.match(fn, /turnAudioMsRef\.current \+= buffer\.duration \* 1000/);
    assert.match(fn, /extendTextVisemeDuration\(turnAudioMsRef\.current\)/);
  });

  it("calibrates her real speaking rate when a turn's audio completes", () => {
    assert.match(
      src,
      /const measured = turnAudioMsRef\.current \/ turnWeightRef\.current;/,
      "the rate must be MEASURED from her own audio, not left at the TEXT_VISEME_MS_PER_WEIGHT seed",
    );
    assert.match(src, /msPerWeightRef\.current = msPerWeightRef\.current \* 0\.5 \+ measured \* 0\.5/);
  });

  it("re-arms each turn against the calibrated rate", () => {
    const fn = src.slice(
      src.indexOf("const speakForced"),
      src.indexOf("}, [kimiEarsStruggling, recordAssistantRow]);"),
    );
    assert.match(fn, /turnWeightRef\.current \* msPerWeightRef\.current/);
  });

  /**
   * ★ THIS ASSERTION MOVED, AND THE MOVE IS THE FIX (2026-09-30). It used to
   * require `turnMouthStartedRef.current = false` INSIDE speakForced. That is
   * per force_message, and with sentence streaming on a turn is several of
   * them — so the gate re-opened mid-utterance and her mouth re-anchored to the
   * newest sentence while her voice was still mid-word. The gate belongs where
   * a TURN begins, exactly once, however many force_messages the turn takes.
   */
  it("the per-turn gate re-opens where a TURN begins, not per force_message", () => {
    const speak = src.slice(
      src.indexOf("const speakForced"),
      src.indexOf("}, [kimiEarsStruggling, recordAssistantRow]);"),
    );
    assert.doesNotMatch(
      speak,
      /turnMouthStartedRef\.current = false/,
      "resetting the gate per force_message jumps her mouth to the next sentence",
    );
    assert.doesNotMatch(
      speak,
      /turnAudioMsRef\.current = 0/,
      "zeroing the turn's audio per force_message loses the schedule's floor",
    );
    const turn = src.slice(src.indexOf("const runKimiTurn"));
    assert.match(turn, /turnMouthStartedRef\.current = false/);
    assert.match(turn, /turnAudioMsRef\.current = 0/);
    assert.match(turn, /turnSpokenTextRef\.current = ""/);
  });

  /** Sentence two must EXTEND the utterance, never restart it. */
  it("arms the ACCUMULATED utterance and keeps the running clock", () => {
    const speak = src.slice(
      src.indexOf("const speakForced"),
      src.indexOf("}, [kimiEarsStruggling, recordAssistantRow]);"),
    );
    assert.match(speak, /turnSpokenTextRef\.current\s*\n?\s*\?/);
    assert.match(speak, /\{ keepClock: turnMouthStartedRef\.current \}/);
  });

  /**
   * The mouth is clocked off the audio QUEUE, not off performance.now() and not
   * off ctx.currentTime.
   *
   * ★ THIS ASSERTION WAS A FALSE GREEN AND THE REWRITE IS THE FIX (2026-09-30).
   * It required the source text `ctx.currentTime - t0`, which is the WALL-CLOCK
   * form: ctx.currentTime is denominated in audio time but it is not a playback
   * position, so every silence the scheduler inserts (a starved queue, or the
   * gap between two streamed sentences' responses) advanced it without advancing
   * her voice. Worse, after that form was replaced the regex still passed —
   * because the replacement's comment NAMES it to explain why it is wrong. An
   * assertion that a comment can satisfy proves nothing. These assertions are
   * shaped so only the arithmetic can satisfy them.
   */
  it("derives the mouth position from the queue, not from the audio wall clock", () => {
    const fn = src.slice(src.indexOf("const schedulePlayback"));
    assert.match(fn, /setTextVisemeClockSource\(\(\) => \{/, "a closure, re-read per tick");
    // "played so far" = enqueued this turn, minus what is still waiting.
    assert.match(fn, /const queuedAhead = \(nextStartRef\.current - ctx\.currentTime\) \* 1000;/);
    assert.match(fn, /turnAudioMsRef\.current -\s*\n?\s*\(queuedAhead > 0 \? queuedAhead : 0\) -/);
    assert.match(fn, /audioOutputDelayMs\(ctx\)/, "the device's own output lag is compensated");
    // The wall-clock form must not survive as ARITHMETIC. Strip line comments
    // first so the note explaining why it is wrong cannot satisfy this.
    const code = fn.replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(
      code,
      /ctx\.currentTime\s*-\s*(t0|turnAudioStartRef)/,
      "(ctx.currentTime - anchor) advances through inserted silence — it is not a playback position",
    );
  });

  /**
   * The fallback anchor must name the TURN's first sample, not the SENTENCE's.
   * With sentence streaming, schedulePlayback re-arms mid-turn, and a bare
   * `startAt` there would point at sentence N's first sample while the schedule
   * it anchors covers sentences 1..N.
   */
  it("back-dates the fallback anchor to the turn's first sample", () => {
    const fn = src.slice(src.indexOf("const schedulePlayback"));
    assert.match(
      fn,
      /turnAudioStartRef\.current = startAt - turnAudioMsRef\.current \/ 1000;/,
    );
  });

  /**
   * ★ THE CRITICAL ONE. The clock is installed behind a gate, and the gate must
   * be the armed TRACK, not a per-turn boolean. The track is dropped per
   * UTTERANCE (clearTextVisemes when her voice stops); with streaming a turn is
   * several utterances. A per-turn flag says "already started" while the track
   * it started no longer exists — and then nothing re-arms the clock, so
   * sentences 2..n of every reply have no shape track at all.
   */
  it("gates the clock install on the armed TRACK, never on a per-turn flag", () => {
    const fn = src.slice(src.indexOf("const schedulePlayback"));
    const code = fn.replace(/^\s*\/\/.*$/gm, "");
    assert.match(code, /if \(!isTextVisemeStarted\(\)\) \{/);
    assert.doesNotMatch(
      code,
      /if \(!turnMouthStartedRef\.current\)/,
      "a per-turn flag leaves sentences 2..n of every streamed reply with no mouth track",
    );
  });

  /**
   * ★ THE OTHER HALF OF THE CRITICAL FIX, AND THE HALF THAT IS EASY TO MISS.
   *
   * Gating the clock install on the armed track is not enough on its own. With
   * sentence streaming the brain yields sentence 2's text while sentence 1 is
   * still being spoken, so speakForced arms the ACCUMULATED s1+s2 track BEFORE
   * sentence 1's audio drains. If the drain then clears the track
   * unconditionally, it destroys the track sentence 2 was going to ride, and no
   * later arm exists to recover it — her mouth is dead from sentence 2 onward
   * even though the gate is correct.
   *
   * So both per-utterance clear paths must be scoped to the TURN. The 3s drain
   * watchdog is deliberately NOT, because it also declares the turn over.
   */
  it("does not drop the mouth track while another sentence is still on the wire", () => {
    const fn = src.slice(src.indexOf("const schedulePlayback"));
    const onended = fn.slice(fn.indexOf("source.onended"), fn.indexOf("activeSourcesRef.current.add"));
    assert.ok(onended.length > 0, "the onended handler must still exist");
    assert.match(
      onended.replace(/^\s*\/\/.*$/gm, ""),
      /if \(pendingResponsesRef\.current === 0\) \{\s*\n\s*try \{\s*\n\s*clearTextVisemes\(\);/,
      "a drained queue mid-turn must NOT drop the accumulated track",
    );
  });

  it("response.done does not drop the track until the whole turn is done", () => {
    const done = src.slice(
      src.indexOf('case "response.done":'),
      src.indexOf('case "response.done":') + 2600,
    );
    assert.ok(done.length > 0);
    assert.match(
      done.replace(/^\s*\/\/.*$/gm, ""),
      /activeSourcesRef\.current\.size === 0 && pendingResponsesRef\.current === 0/,
      "with streaming a TURN is several responses — one response finishing is not her thought finishing",
    );
  });

  it("the 3s drain watchdog still clears unconditionally — it is the un-latch", () => {
    const wd = src.slice(src.indexOf("const armDrainWatchdog"));
    const body = wd.slice(0, wd.indexOf("SPEAKING_DRAIN_TIMEOUT_MS)"));
    assert.match(body, /clearTextVisemes\(\)/, "the last-resort clear must survive");
    assert.doesNotMatch(
      body.replace(/^\s*\/\/.*$/gm, ""),
      /pendingResponsesRef/,
      "a leaked counter must not be able to leave her mouth holding a shape into listening",
    );
  });

  /** A rate measured from half the audio and all of the text is poison. */
  it("calibrates only once every force_message's audio has arrived", () => {
    assert.match(src, /pendingResponsesRef\.current === 0 &&/);
    assert.match(
      src,
      /type === doneEventNameRef\.current && pendingResponsesRef\.current > 0/,
      "the two spellings of the done event are aliases — only one may decrement",
    );
  });
});
