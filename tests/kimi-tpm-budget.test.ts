/**
 * KIMI LANE TPM BUDGET — pinned against a VERIFIED limit, not a vibe.
 *
 * Measured live 2026-08-05 (Groq 413 body, this org, service tier on_demand):
 *   "Request too large for model `openai/gpt-oss-120b` … tokens per minute
 *    (TPM): Limit 8000" — and "Requested" = prompt tokens + max_tokens.
 *
 * The outage this prevents: the tiered system prompt budgeted 7600-7900
 * estimated tokens for the SYSTEM alone; with history and the reply reserve
 * every full-canon turn exceeded 8000 → 413 → silent drop to Ollama (and on
 * 2026-08-05, Ollama's runners were dead too → "Link degraded" on the call).
 *
 * estTokens is chars/4 — an UNDERestimate for prose+markdown, hence the
 * safety multiplier. If the pinned model or its limit changes, change
 * KIMI_TPM_LIMIT and every derived number follows.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  KIMI_TPM_LIMIT,
  KIMI_COMPLETION_RESERVE,
  KIMI_HISTORY_TOKEN_ALLOWANCE,
  KIMI_EST_SAFETY,
  KIMI_SYSTEM_TOKEN_BUDGET,
  KIMI_VOICE_SYSTEM_TOKEN_BUDGET,
  buildCoreSystemPrompt,
  buildTieredSystemPrompt,
} from "../src/lib/brain";
import { STARRA_PERSONA_CORE } from "../src/lib/persona";

describe("kimi TPM budget", () => {
  it("derived system budget + reserves fits under the verified TPM ceiling", () => {
    // MOVED to 12000 on 2026-08-06 when the lane was pinned to
    // llama-3.3-70b-versatile. Measured, not assumed: Groq's own
    // `x-ratelimit-limit-tokens` header on a live 200 with this key reported
    // 12000 for llama-3.3-70b-versatile and 8000 for openai/gpt-oss-120b.
    // Update only with a new measurement, never by taste.
    assert.equal(KIMI_TPM_LIMIT, 12000);
    const worstCase =
      KIMI_SYSTEM_TOKEN_BUDGET * KIMI_EST_SAFETY +
      KIMI_HISTORY_TOKEN_ALLOWANCE +
      KIMI_COMPLETION_RESERVE;
    assert.ok(
      worstCase <= KIMI_TPM_LIMIT,
      `worst case ${worstCase} exceeds TPM limit ${KIMI_TPM_LIMIT}`,
    );
  });

  it("a full-canon tiered prompt at the kimi budget respects its ceiling", () => {
    const t = buildTieredSystemPrompt({
      query: "morning market brief with web lookup",
      maxTokens: KIMI_SYSTEM_TOKEN_BUDGET,
    });
    assert.ok(
      t.tokens <= KIMI_SYSTEM_TOKEN_BUDGET,
      `tiered prompt ${t.tokens} est-tokens exceeds budget ${KIMI_SYSTEM_TOKEN_BUDGET}`,
    );
    assert.ok(t.included.includes("core"), "core identity must always ship");
  });

  it("the old 7600/7900 budgets are provably over the 8000 ceiling (regression pin)", () => {
    // 7600 est-tokens × safety + reserves > 8000: the exact bug, on the lane it
    // happened on. Pinned against the LITERAL 8000 that caused it, not against
    // KIMI_TPM_LIMIT — on the 12000 lane 7600 genuinely does fit (10464 < 12000),
    // so testing it against the live constant would assert a falsehood and hide
    // the lesson. If the pin is ever moved back onto a ≤8000 model, the first
    // test in this file is what forbids an over-budget ceiling.
    const OUTAGE_TPM_LIMIT = 8000;
    const old = 7600 * KIMI_EST_SAFETY + KIMI_HISTORY_TOKEN_ALLOWANCE + KIMI_COMPLETION_RESERVE;
    assert.ok(old > OUTAGE_TPM_LIMIT, "the outage math should not silently fit");
  });

  it("the VOICE core carries her persona and is smaller than what lagged", () => {
    // SUPERSEDES the old "clipped core is a deliberate trade" pin (kept below in
    // spirit). That pin existed because widening the lane to 12000 once made the
    // call lag, so the clip was knowingly kept. Two things changed:
    //
    //  1. The lag was measured to the PROMPT SIZE, and the fix is not a smaller
    //     canon — it is a smaller CALL prompt. buildCoreSystemPrompt({voice:true})
    //     drops loadBrain() (2,157 tokens of ops/tooling rules she does not need
    //     while talking to him) and puts STARRA_PERSONA_CORE in its place.
    //  2. MEASURED live 2026-08-06 against llama-3.3-70b-versatile:
    //       new voice core   0.97s, 7,082 prompt tokens, persona INCLUDED
    //       old deck core    1.04s, 8,501 prompt tokens, persona DROPPED
    //     So the call now sends LESS than the configuration that was reverted for
    //     lag, and is warmer for it.
    //
    // The lesson the old pin protected still stands and is asserted here:
    // the voice prompt must never grow past the deck prompt that once lagged.
    const voice = buildCoreSystemPrompt({ voice: true });
    const deck = buildCoreSystemPrompt();
    const est = (s: string) => Math.ceil(s.length / 4);

    // Against the VOICE budget, not the deck budget. The voice lane reclaims the
    // reply reserve (she speaks 1-3 sentences, so 512 not 1024) and spends it on
    // her canon — that reclaimed room is exactly what lets her ship WHOLE on a
    // call without dropping loadBrain. Asserting the deck budget here was my own
    // error after Classic's "don't drop a thing" correction.
    assert.ok(
      est(voice) <= KIMI_VOICE_SYSTEM_TOKEN_BUDGET,
      `voice core ${est(voice)} must fit the VOICE budget ${KIMI_VOICE_SYSTEM_TOKEN_BUDGET} UNCLIPPED`,
    );
    // SUPERSEDED COMPARISON, replaced rather than deleted. This used to assert
    // voice < deck as a proxy for "won't lag". That proxy was about GROQ TPM
    // starvation — at 12,000 TPM a ~10k prompt eats 83% of the minute and the
    // next turn 429s. On the Grok lane (15,000,000 TPM, measured) that failure
    // mode does not exist, and the voice core is now deliberately LARGER than
    // the deck core because it carries her persona core on top of everything
    // else — Classic's "find another way to fix it without dropping a thing".
    //
    // What still needs guarding is that the voice prompt cannot balloon past a
    // MEASURED-safe latency envelope. Live 2026-08-06 on grok-4.5: 9,921 prompt
    // tokens returned in 1.21s, comfortably conversational. 10,200 keeps a small
    // margin above today's 9,836 without leaving room for silent growth.
    const VOICE_TOKEN_CEILING = 10_200;
    assert.ok(
      est(voice) <= VOICE_TOKEN_CEILING,
      `voice core ${est(voice)} exceeds the measured-safe ceiling ${VOICE_TOKEN_CEILING}`,
    );
    assert.ok(est(deck) > 0, "deck core must still compose");
    assert.ok(
      voice.includes(STARRA_PERSONA_CORE.slice(0, 80)),
      "her cross-surface persona must be INSIDE the voice core, not a budget candidate that loses",
    );
    // And it must not be paid for twice on the voice path.
    const tiered = buildTieredSystemPrompt({ query: "how are you", voice: true });
    assert.ok(!tiered.included.includes("persona-core"), "persona is in the core on voice");
    assert.ok(
      !tiered.dropped.includes("core-clipped"),
      "the voice core must never be clipped — that is the whole point",
    );
  });

  it("the deck core still fits its budget unclipped", () => {
    const est = Math.ceil(buildCoreSystemPrompt().length / 4);
    assert.ok(
      est <= KIMI_SYSTEM_TOKEN_BUDGET,
      `deck core ${est} exceeds budget ${KIMI_SYSTEM_TOKEN_BUDGET} — she would be clipped again`,
    );
  });

  it.skip("SUPERSEDED: the clipped core was a KNOWN, DELIBERATE trade", () => {
    // 2026-08-06: raising the lane to llama-3.3-70b-versatile (12000 TPM) DID fit
    // her whole 8,311-token core — and the live call broke: two voices, laggy
    // replies, lips off the audio. Reverted.
    //
    // The two-voices part was NOT caused by the bigger prompt. Root cause, found
    // later the same night: a mid-call self-heal handed the turn to the xAI
    // session's own model. That swap is now DELETED (see callBrainRef in
    // useVoiceCall.ts) and the extra latency can no longer summon a stranger.
    // The clipping stayed reverted anyway, because the LAG was real and this
    // ceiling is what bounds it.
    //
    // So the clipping is a PRICE, knowingly paid, for a call that stays on one
    // brain. Anyone raising this ceiling again must prove the call still holds —
    // chat-only tests will not catch the regression.
    const CORE_EST_TOKENS = 8311;
    assert.ok(
      CORE_EST_TOKENS > KIMI_SYSTEM_TOKEN_BUDGET,
      "core unexpectedly fits — if the lane was widened, re-verify the LIVE CALL before trusting it",
    );
  });
});
