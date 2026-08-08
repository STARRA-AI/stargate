/**
 * HER BRAIN IS KIMI (Classic's order, 2026-08-04) — the pure decisions behind
 * the kimi-brain call: the client endpointer that replaces server VAD
 * (turn_detection null), and the brain request's context builder. The wire
 * plumbing (commit → transcript → /api/chat → force_message) lives in
 * useVoiceCall and is exercised live; these pin the logic it stands on.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const realtimeRoute = readFileSync(
  join(REPO, "src/app/api/realtime/route.ts"),
  "utf8",
);
const voiceCallSrc = readFileSync(
  join(REPO, "src/lib/voice/useVoiceCall.ts"),
  "utf8",
);

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

/**
 * PIN-DOWN — /api/realtime's `callBrain` field, live-probed 2026-08-07 against
 * the running deck (scripts/debug/call-probe.mjs, probe 1): with
 * STARRA_CALL_BRAIN unset in .env.local, the route answered
 * `callBrain: "kimi"`. These assertions pin the exact source logic behind
 * that observed value and its one-line rollback so a future edit to
 * src/app/api/realtime/route.ts (owned by the executive, not this file)
 * cannot silently flip the default without failing a test here.
 */
describe("realtime route — callBrain default and rollback (source-pinned)", () => {
  it("defaults callBrain to kimi when STARRA_CALL_BRAIN is unset — matches the live probe", () => {
    assert.match(
      realtimeRoute,
      /callBrain:\s*\n\s*\(process\.env\.STARRA_CALL_BRAIN \|\| "kimi"\)\.toLowerCase\(\) === "grok"\s*\n\s*\? "grok"\s*\n\s*: "kimi",/,
      "callBrain must fall back to \"kimi\" — the literal value the live deck returned",
    );
  });

  it("STARRA_CALL_BRAIN=grok is the only documented rollback to the bundled xAI brain", () => {
    // Any other value (including case variants) must still resolve to "kimi" —
    // the ternary compares against the lowercased env var, not a truthy check.
    assert.match(realtimeRoute, /\.toLowerCase\(\) === "grok"/);
  });

  it("client seeds callBrainRef from the realtime response, defaulting to grok only until that response lands", () => {
    // useVoiceCall.ts:2408 — the moment the field the probe observed actually
    // takes effect on the call client. A non-"grok" value (e.g. the probed
    // "kimi") must resolve to "kimi", never pass the string through raw.
    assert.match(
      voiceCallSrc,
      /callBrainRef\.current = data\.callBrain === "grok" \? "grok" : "kimi";/,
    );
  });
});
