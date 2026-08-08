/**
 * BUG 2 — FRESH CALL LOG. Root cause was NOT the hook's `transcript` state
 * (already reset on every fresh call, useVoiceCall.ts:2331 — Agent B's
 * regression test covers that reset). It was VoiceCallOverlay composing the
 * live column as `[...history, ...transcript]`, where `history` is the
 * PERSISTENT deck chat — so every new call opened showing the entire prior
 * conversation.
 *
 * composeCallChatMessages is the extracted pure function that now drives the
 * live column: it reads ONLY the call's own transcript, never deck history.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Module, { createRequire } from "node:module";

// VoiceCallOverlay.tsx transitively imports StarraCallChat.tsx, which imports
// a `.module.css` file — real CSS, not JS. tsx's require hook (this test
// suite has no webpack/jsdom) tries to parse that file as a CommonJS module
// and throws a SyntaxError on its first `{`. No test in this repo has ever
// imported a component with a CSS Module dependency for exactly this reason.
// Stub `.css` to an empty export at the require-extension level — local to
// this file, no shared config touched — so the REAL composeCallChatMessages
// can be imported and exercised instead of re-implemented/copied here.
(Module as unknown as { _extensions: Record<string, (m: NodeModule, filename: string) => void> })
  ._extensions[".css"] = (m) => {
  (m as unknown as { exports: unknown }).exports = {};
};

const require = createRequire(__filename);
const { composeCallChatMessages } = require(
  "../src/components/bridge/VoiceCallOverlay",
) as typeof import("../src/components/bridge/VoiceCallOverlay");

describe("composeCallChatMessages — the call always opens on a fresh log", () => {
  it("an empty transcript composes to an empty list, full stop", () => {
    assert.deepEqual(composeCallChatMessages([]), []);
  });

  it("carries only the transcript's own turns, in order", () => {
    const transcript = [
      { role: "user" as const, text: "hey" },
      { role: "assistant" as const, text: "hey yourself" },
    ];
    assert.deepEqual(composeCallChatMessages(transcript), [
      { role: "user", text: "hey" },
      { role: "assistant", text: "hey yourself" },
    ]);
  });

  it("takes no history argument at all — there is no parameter through which prior deck chat could leak in", () => {
    // If this ever grows a second parameter, that IS the regression: any
    // extra input is a place for yesterday's conversation to sneak back in.
    assert.equal(composeCallChatMessages.length, 1);
  });
});
