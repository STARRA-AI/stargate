/**
 * WHERE THE CALL'S TIME GOES — the four boundaries, pinned as arithmetic.
 *
 * WHY THIS FILE EXISTS, in the same spirit as tests/voice-debug-timing.test.ts:
 * "the call is laggy" is unfalsifiable without numbers, and every number worth
 * having lives inside a browser tab holding a WebSocket and a microphone. So
 * the hook records six raw `performance.now()` stamps per turn and ALL the
 * arithmetic that turns them into a verdict lives in pure exported functions —
 * testable here, with no browser, no socket and no mic.
 *
 * The four boundaries (useVoiceCall.ts, runKimiTurn / kimiOnCommit / schedulePlayback):
 *   T1 EARS      input_audio_buffer.commit  -> final user transcript in hand
 *   T2 BRAIN     transcript                 -> first SSE byte from /api/chat
 *   T3 GENERATE  first SSE byte             -> last SSE byte
 *   T4 MOUTH     force_message sent         -> first response.output_audio.delta
 *
 * THE STRUCTURAL FACT THIS ENCODES: with CALL_STREAM_SENTENCES OFF (the
 * default, useVoiceCall.ts:516) nothing is spoken until the stream is complete,
 * so T3 sits IN FULL on the critical path — time-to-first-audio is
 * T1+T2+T3+T4, not T1+T2+T4. `callTurnLatency` computes both, so the cost of
 * the flag is a measured number rather than an argument.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  CALL_TIMING_IDLE,
  callTurnLatency,
  formatCallTurnLatency,
} from "../src/lib/voice/useVoiceCall";
import { playbackLead } from "../src/lib/voice/pcm-audio";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(REPO, "src/lib/voice/useVoiceCall.ts"), "utf8");

describe("callTurnLatency — the four boundaries", () => {
  it("splits a complete turn into T1..T4 and the two totals", () => {
    const l = callTurnLatency({
      commitAt: 1_000,
      transcriptAt: 1_040, // T1 = 40
      brainFirstByteAt: 1_640, // T2 = 600
      brainLastByteAt: 4_140, // T3 = 2500
      forcedAt: 4_150,
      firstAudioAt: 4_650, // T4 = 500
    });
    assert.equal(l.t1EarsMs, 40);
    assert.equal(l.t2BrainFirstByteMs, 600);
    assert.equal(l.t3GenerateMs, 2500);
    assert.equal(l.t4MouthMs, 500);
    // What Classic actually experiences: his silence -> her first sound.
    assert.equal(l.totalMs, 3650);
    // What it WOULD be if the first sentence were spoken as it arrived.
    assert.equal(l.streamedTotalMs, 1140);
    // And therefore what the flag is worth on this turn.
    assert.equal(l.streamSavingMs, 2510);
  });

  it("reports null for a boundary that never happened, never NaN", () => {
    const l = callTurnLatency({ ...CALL_TIMING_IDLE, commitAt: 500 });
    assert.equal(l.t1EarsMs, null);
    assert.equal(l.t2BrainFirstByteMs, null);
    assert.equal(l.t3GenerateMs, null);
    assert.equal(l.t4MouthMs, null);
    assert.equal(l.totalMs, null);
    assert.equal(l.streamSavingMs, null);
  });

  it("a turn that died before audio still reports the legs it did reach", () => {
    const l = callTurnLatency({
      commitAt: 0,
      transcriptAt: 50,
      brainFirstByteAt: 900,
      brainLastByteAt: 3_000,
      forcedAt: null,
      firstAudioAt: null,
    });
    assert.equal(l.t1EarsMs, 50);
    assert.equal(l.t2BrainFirstByteMs, 850);
    assert.equal(l.t3GenerateMs, 2100);
    assert.equal(l.t4MouthMs, null);
    assert.equal(l.totalMs, null, "no audio means no end-to-end number to claim");
  });

  it("never invents a negative leg from out-of-order stamps", () => {
    const l = callTurnLatency({
      ...CALL_TIMING_IDLE,
      commitAt: 1_000,
      transcriptAt: 900,
    });
    assert.equal(l.t1EarsMs, 0);
  });

  it("formats one line that names the dominant leg", () => {
    const line = formatCallTurnLatency(
      callTurnLatency({
        commitAt: 0,
        transcriptAt: 40,
        brainFirstByteAt: 640,
        brainLastByteAt: 3_140,
        forcedAt: 3_150,
        firstAudioAt: 3_650,
      }),
    );
    assert.match(line, /T1=40/);
    assert.match(line, /T2=600/);
    assert.match(line, /T3=2500/);
    assert.match(line, /T4=500/);
    assert.match(line, /total=3650/);
    assert.match(line, /dominant=T3/, "the report must say WHERE the time went");
  });
});

describe("playbackLead — does the audio queue add lag, or is it starving?", () => {
  it("a queued frame plays at the tail of the queue, not now", () => {
    const lead = playbackLead(10.0, 10.25);
    assert.equal(lead.startAt, 10.25);
    assert.equal(Math.round(lead.leadMs), 250);
    assert.equal(lead.starving, false);
  });

  it("an empty queue is STARVING — the frame starts now and a gap already happened", () => {
    const lead = playbackLead(10.0, 9.8);
    assert.equal(lead.startAt, 10.0, "never schedule in the past");
    assert.equal(lead.leadMs, 0);
    assert.equal(lead.starving, true, "arriving late is a dropout, not latency");
  });

  it("the very first frame of a turn is not counted as a dropout", () => {
    // nextStart 0 is the reset value: no queue exists yet.
    assert.equal(playbackLead(10.0, 0).starving, false);
  });
});

describe("the instrumentation costs nothing in production", () => {
  it("is gated behind a NEXT_PUBLIC flag, default OFF", () => {
    assert.match(
      src,
      /export const CALL_TIMING_DEBUG\s*=\s*\n?\s*process\.env\.NEXT_PUBLIC_STARRA_CALL_TIMING === "1"/,
      "timing must be opt-in, like CALL_STREAM_SENTENCES",
    );
  });

  it("every stamp site is behind that flag", () => {
    const stamps = src.match(/^.*markCallTiming\(.*$/gm) ?? [];
    assert.ok(stamps.length >= 6, `expected the six boundary stamps, saw ${stamps.length}`);
    assert.match(
      src,
      /function markCallTiming[\s\S]{0,300}?if \(!CALL_TIMING_DEBUG\) return;/,
      "the recorder itself must no-op when the flag is off",
    );
  });
});
