/**
 * A FRESH CALL STARTS FRESH — AND A RECONNECT DOES NOT.
 *
 * Both halves are load-bearing, and they have failed in opposite directions:
 *
 *   - Clearing UNCONDITIONALLY was a confirmed bug: every transient socket blip
 *     took the auto-reconnect path and wiped the visible call chat mid-sentence
 *     (see the comment at useVoiceCall.ts:2330-2334).
 *   - Not clearing at all means every new call opens holding the last one.
 *
 * The decision is a single guarded block inside connect(), and it is proved
 * here by source shape — the same idiom as tests/call-never-silent.test.ts,
 * because the failure is STRUCTURAL (a reset in the wrong place, or a second
 * one somewhere else) and unobservable without a browser and a dropped socket.
 * A pure predicate was tried and reverted: it bought nothing the shape
 * assertions below don't already give, and it broke the literal pin in
 * tests/one-person-unification.test.ts.
 *
 * `callId` shares that block on purpose: it is minted inside it, so "a fresh
 * transcript" and "a new call id" can never disagree. Agent C keys the call log
 * on it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(REPO, "src/lib/voice/useVoiceCall.ts"), "utf8");

/** Slice [from, to) and prove the slice is real, so a rename fails loudly. */
const between = (from: string, to: string) => {
  const start = src.indexOf(from);
  assert.ok(start >= 0, `slice start not found: ${from}`);
  const end = src.indexOf(to, start + from.length);
  assert.ok(end > start, `slice end not found after start: ${to}`);
  return src.slice(start, end);
};

describe("connect() resets exactly once, behind the reconnect guard", () => {
  it("the reset FIRES on a fresh connect — the whole per-call lifecycle at once", () => {
    const block = between('if (stateRef.current !== "reconnecting") {', "endpointerRef.current =");
    assert.match(block, /setTranscript\(\[\]\)/, "a fresh call clears the visible chat");
    assert.match(block, /callTurnsRef\.current = \[\]/, "and the brain's context mirror");
    assert.match(block, /kimiGreetedRef\.current = false/, "and the one-greeting latch");
    assert.match(block, /shapingRef\.current = createShapingState\(\)/, "and the shaping state");
  });

  it("the reset does NOT fire on a reconnect — the guard is the literal state check", () => {
    // The connect() body between claiming the epoch and the endpointer reset
    // must contain the guard, and NOTHING may clear the transcript ahead of it.
    const connectBody = between("const connect = useCallback(async () => {", "endpointerRef.current =");
    const guardAt = connectBody.indexOf('if (stateRef.current !== "reconnecting") {');
    assert.ok(guardAt > 0, "the fresh-call guard must still be the literal state check");
    assert.doesNotMatch(
      connectBody.slice(0, guardAt),
      /setTranscript\(/,
      "a reconnect must reach the guard with the visible chat untouched",
    );
    assert.doesNotMatch(
      connectBody.slice(0, guardAt),
      /callIdRef\.current =/,
      "and holding the same call id",
    );
  });

  it("there is NO second, unconditional reset anywhere in the hook", () => {
    const resets = src.match(/setTranscript\(\[\]\)/g) ?? [];
    assert.equal(
      resets.length,
      1,
      "a second reset is how the reconnect path wiped the chat the first time",
    );
  });
});

describe("callId — minted with the fresh transcript, kept across a reconnect", () => {
  it("is on the public shape as `string | null`", () => {
    assert.match(
      src,
      /callId: string \| null;/,
      "the shared contract's one added field",
    );
    // The hook's own return object is the LAST one in the file.
    const ret = src.slice(src.lastIndexOf("\n  return {"));
    assert.match(ret, /^\s+callId,$/m, "and it is actually returned");
  });

  it("is minted inside the SAME fresh-call block, so it can never disagree with the transcript", () => {
    const block = between('if (stateRef.current !== "reconnecting") {', "endpointerRef.current =");
    assert.match(block, /crypto\.randomUUID\(\)/, "a fresh call gets a fresh id");
    assert.match(block, /callIdRef\.current/);
  });

  it("is nulled on an intentional disconnect", () => {
    const block = between("const disconnect = useCallback(() => {", "const toggleMute");
    assert.match(block, /callIdRef\.current = null/);
    assert.match(block, /setCallId\(null\)/);
  });

  it("the call log is fire-and-forget and can never block her voice", () => {
    const fn = between("function postCallLogTurn(", "\n}\n");
    assert.match(fn, /void fetch\("\/api\/calls"/, "never awaited");
    assert.match(fn, /\.catch\(\(\) => \{\}\)/, "a rejected POST is dropped");
    assert.doesNotMatch(fn, /await/, "the audio path never waits on the log");
  });

  it("a PRIVATE turn is never POSTed to the call log", () => {
    // The user-side emit lives inside the `if (!privateAsk)` block, beside the
    // shared-store write it mirrors.
    const guarded = between("if (!privateAsk) {", "// The spoken tool commands");
    assert.match(guarded, /postCallLogTurn\(/, "the public user turn is logged");
    // The private reply branch returns before recordAssistantRow is ever reached.
    const priv = between("if (privateReply) {", "// MECHANICAL SHAPING");
    assert.doesNotMatch(priv, /postCallLogTurn\(/, "a private reply never leaves this Mac");
    assert.doesNotMatch(priv, /recordAssistantRow\(/);
  });
});
