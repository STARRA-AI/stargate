/**
 * BUS ADOPTION — the pure decision logic that makes the existing surfaces act in
 * conjunction through the engine state bus.
 *
 * WHY THESE FUNCTIONS ARE PURE AND TESTED HERE. The filmed failure was not a
 * missing feature — every part existed (face clips, viseme bank, analyser, TTS,
 * realtime) and each surface GUESSED independently, so the header said "STARRA is
 * speaking…" for 8+ seconds while her mouth stayed shut. The fix is one truth. The
 * decisions that route that truth (who may publish, who may RETRACT, and which
 * analyser drives her mouth) are therefore extracted as total, side-effect-free
 * functions so they can be pinned down here rather than only observed in a browser.
 *
 * TWO INVARIANTS EVERY TEST BELOW DEFENDS:
 *   1. BUS-EMPTY EQUIVALENCE — with the bus silent, every selector returns exactly
 *      what the pre-bus expression returned. Adoption may not change behaviour.
 *   2. NO CROSS-RETRACTION — a publisher may only take back what it published. A
 *      finished typed reply must never blank a live realtime leg, and vice versa;
 *      that would put her face back to idle while she is still talking.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";

import { ttsBusPatch } from "../src/lib/voice/speak";
import { realtimeBusPatch, realtimeAnalyserPatch } from "../src/lib/voice/useVoiceCall";
import {
  resolveMouthAnalyser,
  selectFaceAnalyser,
  selectFaceMode,
} from "../src/components/bridge/StarraClipFace";
import { getEngineState, publishVoice, resetEngineBus } from "../src/lib/engine/bus";

// Stand-ins for AnalyserNode. Only object IDENTITY matters to every selector
// under test, so a bare object is a faithful double and needs no WebAudio.
const A_TTS = { id: "tts" } as unknown as AnalyserNode;
const A_CALL = { id: "call" } as unknown as AnalyserNode;
const A_BUS = { id: "bus" } as unknown as AnalyserNode;

beforeEach(() => {
  resetEngineBus();
});

describe("ttsBusPatch — speak.ts publishes voice truth", () => {
  it("publishes speaking + engine + analyser TOGETHER when sound is coming out", () => {
    const patch = ttsBusPatch({ playing: true, analyser: A_TTS }, "ara", null);
    assert.deepEqual(patch, { speaking: true, source: "ara", analyser: A_TTS });
  });

  it("carries the engine that is actually rendering her voice", () => {
    assert.equal(ttsBusPatch({ playing: true, analyser: null }, "piper", null)?.source, "piper");
    assert.equal(
      ttsBusPatch({ playing: true, analyser: null }, "webspeech", null)?.source,
      "webspeech",
    );
  });

  it("publishes a null analyser rather than omitting it (Piper/Web Speech have none)", () => {
    const patch = ttsBusPatch({ playing: true, analyser: null }, "piper", null);
    assert.equal(patch?.analyser, null);
    assert.ok(patch && "analyser" in patch, "the analyser must be cleared, not left stale");
  });

  it("retracts its own truth when playback ends", () => {
    assert.deepEqual(ttsBusPatch({ playing: false, analyser: A_TTS }, "ara", "ara"), {
      speaking: false,
      source: null,
    });
  });

  it("retracts from an already-silent bus (the settle funnel fires on every exit path)", () => {
    assert.deepEqual(ttsBusPatch({ playing: false, analyser: null }, null, null), {
      speaking: false,
      source: null,
    });
  });

  it("NEVER retracts a live realtime leg — a finished typed reply must not idle her face", () => {
    assert.equal(ttsBusPatch({ playing: false, analyser: A_TTS }, "ara", "realtime"), null);
  });

  it("does not touch the analyser on retraction (the call's tap must survive)", () => {
    const patch = ttsBusPatch({ playing: false, analyser: A_TTS }, "ara", "ara");
    assert.ok(patch && !("analyser" in patch), "retraction must not blank another tap");
  });

  it("is total — a garbage source string cannot make it throw or over-retract", () => {
    assert.equal(ttsBusPatch({ playing: false, analyser: null }, "ara", "something-else"), null);
  });
});

describe("realtimeBusPatch / realtimeAnalyserPatch — useVoiceCall publishes the call leg", () => {
  it("publishes speaking + realtime + the call analyser together", () => {
    assert.deepEqual(realtimeBusPatch("speaking", null, A_CALL), {
      speaking: true,
      source: "realtime",
      analyser: A_CALL,
    });
  });

  it("takes the bus back from a TTS reply when the call itself starts speaking", () => {
    assert.deepEqual(realtimeBusPatch("speaking", "ara", A_CALL), {
      speaking: true,
      source: "realtime",
      analyser: A_CALL,
    });
  });

  it("retracts on every non-speaking call state", () => {
    for (const s of ["idle", "connecting", "reconnecting", "listening", "error"] as const) {
      assert.deepEqual(
        realtimeBusPatch(s, "realtime", A_CALL),
        { speaking: false, source: null },
        `state ${s} must retract`,
      );
    }
  });

  it("NEVER retracts a TTS reply that is mid-playback", () => {
    assert.equal(realtimeBusPatch("listening", "ara", A_CALL), null);
    assert.equal(realtimeBusPatch("idle", "piper", null), null);
    assert.equal(realtimeBusPatch("error", "webspeech", null), null);
  });

  it("mirrors its analyser only while it owns the bus", () => {
    assert.deepEqual(realtimeAnalyserPatch(A_CALL, null), { analyser: A_CALL });
    assert.deepEqual(realtimeAnalyserPatch(A_CALL, "realtime"), { analyser: A_CALL });
    assert.deepEqual(realtimeAnalyserPatch(null, "realtime"), { analyser: null });
    assert.equal(realtimeAnalyserPatch(null, "ara"), null, "must not blank her TTS tap");
  });
});

describe("face selection — ONE truth drives the mouth", () => {
  it("BUS-EMPTY EQUIVALENCE: faceMode is exactly the pre-bus expression", () => {
    const pre = (callState: string, ttsPlaying: boolean) =>
      callState === "speaking" || ttsPlaying
        ? "speaking"
        : callState === "listening"
          ? "listening"
          : "idle";
    for (const callState of [
      "idle",
      "connecting",
      "reconnecting",
      "listening",
      "speaking",
      "error",
    ] as const) {
      for (const ttsPlaying of [false, true]) {
        assert.equal(
          selectFaceMode({ callState, ttsPlaying, busSpeaking: false }),
          pre(callState, ttsPlaying),
          `${callState}/${ttsPlaying}`,
        );
      }
    }
  });

  it("the bus alone can put her face in the speaking clip", () => {
    assert.equal(
      selectFaceMode({ callState: "idle", ttsPlaying: false, busSpeaking: true }),
      "speaking",
    );
    // This is the filmed bug's inverse: the header said speaking, the face did not.
    assert.equal(
      selectFaceMode({ callState: "listening", ttsPlaying: false, busSpeaking: true }),
      "speaking",
    );
  });

  it("is additive — the bus can never SUBTRACT a speaking face the old inputs assert", () => {
    assert.equal(
      selectFaceMode({ callState: "speaking", ttsPlaying: false, busSpeaking: false }),
      "speaking",
    );
    assert.equal(
      selectFaceMode({ callState: "idle", ttsPlaying: true, busSpeaking: false }),
      "speaking",
    );
  });

  it("BUS-EMPTY EQUIVALENCE: analyser choice is exactly the pre-bus expression", () => {
    const pre = (
      ttsPlaying: boolean,
      ttsAnalyser: AnalyserNode | null,
      callAnalyser: AnalyserNode | null,
    ) => (ttsPlaying && ttsAnalyser ? ttsAnalyser : (callAnalyser ?? ttsAnalyser));
    for (const ttsPlaying of [false, true]) {
      for (const ttsAnalyser of [null, A_TTS]) {
        for (const callAnalyser of [null, A_CALL]) {
          assert.equal(
            selectFaceAnalyser({
              busSpeaking: false,
              busAnalyser: null,
              ttsPlaying,
              ttsAnalyser,
              callAnalyser,
            }),
            pre(ttsPlaying, ttsAnalyser, callAnalyser),
            `${ttsPlaying}/${!!ttsAnalyser}/${!!callAnalyser}`,
          );
        }
      }
    }
  });

  it("prefers the analyser of whatever the bus says is ACTUALLY making sound", () => {
    assert.equal(
      selectFaceAnalyser({
        busSpeaking: true,
        busAnalyser: A_BUS,
        ttsPlaying: true,
        ttsAnalyser: A_TTS,
        callAnalyser: A_CALL,
      }),
      A_BUS,
    );
  });

  it("falls back when the bus is speaking but has no tap (Piper / Web Speech)", () => {
    assert.equal(
      selectFaceAnalyser({
        busSpeaking: true,
        busAnalyser: null,
        ttsPlaying: false,
        ttsAnalyser: null,
        callAnalyser: A_CALL,
      }),
      A_CALL,
      "a source with no analyser must not blank the mouth's only input",
    );
  });

  it("StarraClipFace prefers its prop and only falls back to the bus", () => {
    assert.equal(resolveMouthAnalyser(A_CALL, true, A_BUS), A_CALL, "the prop wins");
    assert.equal(resolveMouthAnalyser(null, true, A_BUS), A_BUS, "bus fills a null prop");
    assert.equal(resolveMouthAnalyser(undefined, true, A_BUS), A_BUS);
    assert.equal(
      resolveMouthAnalyser(null, false, A_BUS),
      null,
      "a stale tap from a finished turn must not drive her mouth",
    );
    assert.equal(resolveMouthAnalyser(null, false, null), null, "bus empty → today's null");
    assert.equal(resolveMouthAnalyser(undefined, false, null), null);
  });
});

describe("composition — the patches move the REAL bus", () => {
  it("a TTS start then end round-trips through publishVoice", () => {
    const start = ttsBusPatch({ playing: true, analyser: A_TTS }, "ara", getEngineState().source);
    assert.ok(start);
    publishVoice(start);
    assert.equal(getEngineState().speaking, true);
    assert.equal(getEngineState().source, "ara");
    assert.equal(getEngineState().analyser, A_TTS);

    const end = ttsBusPatch({ playing: false, analyser: A_TTS }, "ara", getEngineState().source);
    assert.ok(end);
    publishVoice(end);
    assert.equal(getEngineState().speaking, false);
    assert.equal(getEngineState().source, null);
  });

  it("a typed reply ending mid-call leaves the call's truth standing", () => {
    publishVoice({ speaking: true, source: "realtime", analyser: A_CALL });
    const end = ttsBusPatch({ playing: false, analyser: A_TTS }, "ara", getEngineState().source);
    assert.equal(end, null, "nothing to publish");
    assert.equal(getEngineState().speaking, true, "she is still talking on the call");
    assert.equal(getEngineState().analyser, A_CALL, "and her mouth still has its input");
  });

  it("the call taking over replaces a TTS tap cleanly", () => {
    publishVoice({ speaking: true, source: "ara", analyser: A_TTS });
    const take = realtimeBusPatch("speaking", getEngineState().source, A_CALL);
    assert.ok(take);
    publishVoice(take);
    assert.equal(getEngineState().source, "realtime");
    assert.equal(getEngineState().analyser, A_CALL);
  });
});
