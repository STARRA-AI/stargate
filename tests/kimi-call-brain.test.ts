/**
 * HER BRAIN IS KIMI (Classic's order, 2026-08-04) — the pure decisions behind
 * the kimi-brain call: the client endpointer that replaces server VAD
 * (turn_detection null), and the brain request's context builder. The wire
 * plumbing (commit → transcript → /api/chat → force_message) lives in
 * useVoiceCall and is exercised live; these pin the logic it stands on.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCallBrainMessages,
  CALL_BRAIN_CONTEXT_TURNS,
  KIMI_ENDPOINT_MIN_SPEECH_FRAMES,
  KIMI_ENDPOINT_SILENCE_FRAMES,
  KIMI_ENDPOINTER_IDLE,
  kimiEndpointStep,
  type KimiEndpointerState,
} from "../src/lib/voice/useVoiceCall";

function run(
  s: KimiEndpointerState,
  loudFrames: number,
  quietFrames: number,
): { state: KimiEndpointerState; commits: number } {
  let state = s;
  let commits = 0;
  for (let i = 0; i < loudFrames; i++) {
    const r = kimiEndpointStep(state, true);
    state = r.next;
    if (r.commit) commits++;
  }
  for (let i = 0; i < quietFrames; i++) {
    const r = kimiEndpointStep(state, false);
    state = r.next;
    if (r.commit) commits++;
  }
  return { state, commits };
}

describe("kimi endpointer — end of his turn", () => {
  it("stays idle through pure silence — never commits an empty room", () => {
    const { state, commits } = run(KIMI_ENDPOINTER_IDLE, 0, 200);
    assert.equal(commits, 0);
    assert.deepEqual(state, KIMI_ENDPOINTER_IDLE);
  });

  it("commits exactly once after real speech goes quiet long enough", () => {
    const { state, commits } = run(
      KIMI_ENDPOINTER_IDLE,
      KIMI_ENDPOINT_MIN_SPEECH_FRAMES,
      KIMI_ENDPOINT_SILENCE_FRAMES,
    );
    assert.equal(commits, 1);
    assert.deepEqual(state, KIMI_ENDPOINTER_IDLE, "resets after the commit");
  });

  it("does not commit before the silence window has fully elapsed", () => {
    const { commits } = run(
      KIMI_ENDPOINTER_IDLE,
      KIMI_ENDPOINT_MIN_SPEECH_FRAMES + 10,
      KIMI_ENDPOINT_SILENCE_FRAMES - 1,
    );
    assert.equal(commits, 0);
  });

  it("a short blip (cough) drains away without committing", () => {
    const { state, commits } = run(
      KIMI_ENDPOINTER_IDLE,
      KIMI_ENDPOINT_MIN_SPEECH_FRAMES - 1,
      KIMI_ENDPOINT_SILENCE_FRAMES + 50,
    );
    assert.equal(commits, 0);
    assert.deepEqual(state, KIMI_ENDPOINTER_IDLE);
  });

  it("mid-utterance pauses shorter than the window do not split his turn", () => {
    // speech, a sub-threshold pause, more speech, then real silence → ONE commit
    let s = run(KIMI_ENDPOINTER_IDLE, 10, KIMI_ENDPOINT_SILENCE_FRAMES - 2);
    assert.equal(s.commits, 0);
    s = run(s.state, 10, KIMI_ENDPOINT_SILENCE_FRAMES);
    assert.equal(s.commits, 1);
  });
});

describe("call brain messages — the context window", () => {
  const turn = (i: number, role: "user" | "assistant" = "user") => ({
    role,
    text: `turn ${i}`,
  });

  it("maps turns to chat messages verbatim", () => {
    const msgs = buildCallBrainMessages([turn(1, "user"), turn(2, "assistant")]);
    assert.deepEqual(msgs, [
      { role: "user", content: "turn 1" },
      { role: "assistant", content: "turn 2" },
    ]);
  });

  it("caps context at the newest CALL_BRAIN_CONTEXT_TURNS turns", () => {
    const turns = Array.from({ length: CALL_BRAIN_CONTEXT_TURNS + 5 }, (_, i) =>
      turn(i),
    );
    const msgs = buildCallBrainMessages(turns);
    assert.equal(msgs.length, CALL_BRAIN_CONTEXT_TURNS);
    assert.equal(msgs[msgs.length - 1].content, `turn ${CALL_BRAIN_CONTEXT_TURNS + 4}`);
  });

  it("appends an unlogged latest prompt as the final user message", () => {
    const msgs = buildCallBrainMessages([turn(1, "assistant")], "[tool result]");
    assert.deepEqual(msgs[msgs.length - 1], {
      role: "user",
      content: "[tool result]",
    });
  });

  it("ignores a blank latest — an empty prompt is not a turn", () => {
    const msgs = buildCallBrainMessages([turn(1)], "   ");
    assert.equal(msgs.length, 1);
  });
});
