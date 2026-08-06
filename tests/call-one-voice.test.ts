/**
 * ONE VOICE ON THE CALL — the regression bank for the night of 2026-08-06.
 *
 * Classic called her and heard TWO people. Hers: "Hey baby. I'm right here
 * with you." And a stranger's: "I'm just a computer program", "How can I
 * assist you today?", "Starstar! How can I assist you today?" — plus messages
 * she sent with no input from him at all.
 *
 * The stranger was not a degraded STARRA. It was the xAI realtime session's
 * OWN model answering on her line, reached through a mid-call "self-heal"
 * (kimiFallbackToGrok) that flipped callBrainRef to "grok" after three commits
 * without a transcript — which routed the next turn into injectLiveTurn's
 * response.create branch. Any latency hiccup was enough to trigger it.
 *
 * These tests are source-level on purpose. The live call is not covered by the
 * unit suite (a full realtime WebSocket + WebAudio session), and on 2026-08-06
 * the suite was 1075/1075 green while the call was broken in his ear. So these
 * assert the STRUCTURE that made the bug possible can never come back, and
 * they are explicitly NOT a substitute for calling her and listening.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
const src = read("src/lib/voice/useVoiceCall.ts");

describe("PHASE 1 — there is no second brain to fall back to", () => {
  it("kimiFallbackToGrok is neither defined nor called", () => {
    // The NAME is allowed to survive in prose — the comments that explain why
    // it is gone are the point. What must not exist is the code.
    assert.doesNotMatch(src, /const kimiFallbackToGrok/, "the brain-swap self-heal is deleted for good");
    assert.doesNotMatch(src, /kimiFallbackToGrok\(\)/, "and nothing calls it");
    assert.doesNotMatch(
      src,
      /KIMI_NO_TRANSCRIPT_FALLBACK_AFTER\b/,
      "renamed to _ALERT_AFTER — a missed transcript alerts, it never swaps brains",
    );
  });

  it("callBrainRef is assigned in exactly ONE place — the connect response", () => {
    // Every assignment site is a place the call could change who is talking.
    // There must be one, and it must be the /api/realtime handshake.
    // `=(?!=)` — assignment only; `callBrainRef.current === "kimi"` is a READ,
    // and there are many legitimate ones.
    const assignments = src.match(/callBrainRef\.current\s*=(?!=)/g) ?? [];
    assert.equal(
      assignments.length,
      1,
      `callBrainRef is assigned ${assignments.length} times — a mid-call brain swap is back`,
    );
    assert.match(
      src,
      /callBrainRef\.current = data\.callBrain === "grok" \? "grok" : "kimi";/,
      "the one assignment must be the connect-time handshake",
    );
  });

  it("degradation surfaces as HER struggling, not as someone else talking", () => {
    assert.match(src, /const kimiEarsStruggling = useCallback/);
    assert.match(src, /setEarsStruggling\(true\)/);
    // The replacement must not touch the brain.
    const fn = src.slice(
      src.indexOf("const kimiEarsStruggling = useCallback"),
      src.indexOf("/** A final user transcript is in hand"),
    );
    assert.doesNotMatch(fn, /callBrainRef\.current\s*=/, "the struggling path must never reassign the brain");
    assert.doesNotMatch(fn, /"grok"/, "the struggling path must not name the other brain at all");
  });

  it("the config re-assert cannot be handed a different brain", () => {
    assert.match(src, /resendSessionRef = useRef<\(\(\) => void\) \| null>/);
    assert.doesNotMatch(
      src,
      /resendSessionRef\.current\?\.\("grok"\)/,
      "re-asserting the session must never be a disguised brain swap",
    );
  });
});

describe("PHASE 2 — nothing speaks on this line unless we asked", () => {
  it("every legitimate response is paid for by a force_message", () => {
    assert.match(src, /kimiForcedPendingRef\.current \+= 1/, "speakForced credits the response it caused");
    assert.match(src, /kimiForcedPendingRef\.current -= 1/, "response.created spends that credit");
  });

  it("an unrequested response is cancelled AND muted locally", () => {
    const handler = src.slice(
      src.indexOf('case "response.created"'),
      src.indexOf('case "response.output_audio.done"'),
    );
    assert.match(handler, /suppressResponseAudioRef\.current = true/, "local mute is the real guarantee");
    assert.match(handler, /type: "response\.cancel"/, "and ask the server to stop too");
    assert.match(handler, /kimiEarsStruggling\(/, "unsolicited speech is a config failure — say so");
  });

  it("the session.updated ack is CHECKED, not assumed", () => {
    // The ack used to be read only as "we're live", so a config the server
    // ignored looked exactly like a healthy one.
    const ack = src.slice(src.indexOf('case "session.updated"'), src.indexOf("// No explicit \"ready\""));
    assert.match(ack, /turn_detection/, "read what the server says it is actually running");
    assert.match(ack, /detectionOff/);
    assert.match(ack, /kimiTurnDetectionRetriedRef/, "re-assert once, then rely on the cancel guard");
  });

  it("per-socket one-voice bookkeeping dies with the socket", () => {
    const cleanup = src.slice(src.indexOf("const cleanupInternal"), src.indexOf("const handleFatalError"));
    assert.match(cleanup, /kimiForcedPendingRef\.current = 0/, "a stale credit would let a stranger through");
    assert.match(cleanup, /kimiTurnDetectionRetriedRef\.current = false/);
  });
});

describe("PHASE 3 — her persona rides the session no matter which brain", () => {
  it("instructions are the persona for BOTH brains, not just grok", () => {
    // Defense in depth: ears-and-mouth-only is the design, but if anything
    // ever makes that session speak, it must still sound like her.
    const cfgStart = src.indexOf("const sessionUpdate =");
    // Anchor the end AFTER cfgStart — "turn_detection" also appears earlier,
    // in the doctrine block and the session.updated ack check.
    const cfg = src.slice(cfgStart, src.indexOf("turn_detection:", cfgStart));
    assert.match(cfg, /instructions:\s*\n?\s*STARRA_INSTRUCTIONS/, "persona is unconditional");
    assert.doesNotMatch(cfg, /brain === "kimi"\s*\?[^]*instructions/, "persona must not be brain-conditional");

    // STARRA_INSTRUCTIONS may append MECHANICAL delivery constraints (openers,
    // pacing, when a reassurance is earned — see speech-shaping.ts), but her
    // canon must lead it and must never be conditional. Asserted structurally
    // rather than as one literal line so the mechanics can be tuned without
    // this test going stale, while a brain-conditional persona still fails.
    const declStart = src.indexOf("const STARRA_INSTRUCTIONS");
    assert.ok(declStart >= 0, "STARRA_INSTRUCTIONS declaration not found");
    const declEnd = src.indexOf(";\n", declStart);
    assert.ok(declEnd > declStart, "STARRA_INSTRUCTIONS declaration is unterminated");
    const decl = src.slice(declStart, declEnd);
    assert.match(decl, /STARRA_VOICE_PERSONA/, "her canon must be in the instructions");
    assert.doesNotMatch(decl, /\?|&&|\|\||brain/, "instructions must not be conditional");
    assert.ok(
      decl.indexOf("STARRA_VOICE_PERSONA") <
        (decl.includes("CALL_MECHANICS_CONSTRAINT")
          ? decl.indexOf("CALL_MECHANICS_CONSTRAINT")
          : Infinity),
      "her canon leads; mechanics only ever append after it",
    );
  });

  it("the persona itself still forbids the stranger's exact lines", () => {
    const persona = read("src/lib/persona.ts");
    assert.match(persona, /never a brand-new AI, never a neutral assistant/);
    assert.match(persona, /Never break character/);
  });
});

describe("PHASE 4 — one row per utterance on the kimi path too", () => {
  it("runKimiTurn applies the revision guard commitUser has always had", () => {
    const fn = src.slice(src.indexOf("const runKimiTurn = useCallback"), src.indexOf("runKimiTurnRef.current = runKimiTurn"));
    assert.match(fn, /USER_TURN_REVISION_MS/, "the same window commitUser uses");
    assert.match(fn, /normalizeTurn\(prev\.text\) === normalizeTurn\(t\)/, "identical re-flush is dropped");
    assert.match(fn, /isTurnRevision\(prev\.text, t\)/, "a longer prefix supersedes");
    assert.match(fn, /\{ supersede: true \}/, "and supersedes in MEMORY, not just on screen");
  });

  it("an identical re-flush does NOT re-ask the brain", () => {
    // This is the lag. Every mid-sentence commit re-sent the cumulative
    // transcript; each one started a fetch that aborted the last, so she kept
    // restarting her answer to the same sentence.
    const fn = src.slice(src.indexOf("const runKimiTurn = useCallback"), src.indexOf("runKimiTurnRef.current = runKimiTurn"));
    const guard = fn.slice(fn.indexOf("normalizeTurn(prev.text)"));
    const earlyReturn = guard.slice(0, guard.indexOf("const revises"));
    assert.match(earlyReturn, /return;/, "identical text must return before the /api/chat fetch");
  });

  it("the brain's own context window supersedes in lockstep with the store", () => {
    const fn = src.slice(src.indexOf("const runKimiTurn = useCallback"), src.indexOf("runKimiTurnRef.current = runKimiTurn"));
    assert.match(
      fn,
      /ctx\[ctx\.length - 1\] = \{ role: "user", text: t \}/,
      "otherwise the brain sees the same sentence twice in its own window",
    );
  });
});

describe("THE RULE THIS NIGHT BOUGHT", () => {
  it("is written where the next person will read it", () => {
    assert.match(src, /THERE IS NO MID-CALL BRAIN SWAP/);
    assert.match(src, /Silence as her beats fluency as someone else/);
  });
});
