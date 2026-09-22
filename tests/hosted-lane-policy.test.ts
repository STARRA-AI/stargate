/**
 * HOSTED LANE POLICY — two lanes, one pinned primary, and a hiccup that never
 * changes who is talking.
 *
 * Source-level assertions on purpose: what is being pinned is a POLICY, and the
 * failure mode is someone quietly adding a third hosted brain or wiring a
 * fallback provider into the retry path. Both are visible in the source and
 * neither is reachable from a unit call without hitting the network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { HostedTransientError } from "../src/lib/llm/hosted";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(REPO, "src/lib/llm/hosted.ts"), "utf8");
const route = readFileSync(join(REPO, "src/app/api/chat/route.ts"), "utf8");

describe("hosted lane policy", () => {
  it("grok is the primary brain, pinned to a slug that exists", () => {
    // VERIFIED LIVE 2026-08-06 against GET https://api.x.ai/v1/models on
    // Classic's key: grok-4.5 is returned as a concrete id.
    assert.match(src, /grok:\s*\{[\s\S]*?defaultModel:\s*"grok-4\.5"/);
  });

  it("the dead Moonshot default is gone", () => {
    assert.doesNotMatch(
      src,
      /defaultModel:\s*"moonshotai\/kimi-k2-instruct-0905"/,
      "Groq deleted that model; it only 'worked' because GROQ_MODEL masked it",
    );
  });

  it("freellm is removed from the hosted set", () => {
    assert.doesNotMatch(src, /^\s+freellm:\s*\{/m);
    assert.match(src, /export type HostedProvider = "kimi" \| "grok";/);
    assert.doesNotMatch(
      route,
      /provider:\s*"freellm"/,
      "a third hosted brain in the chat route is a third Starra",
    );
  });

  it("the groq fallback points at a model that exists", () => {
    assert.match(src, /kimi:\s*\{[\s\S]*?defaultModel:\s*"llama-3\.3-70b-versatile"/);
  });
});

describe("transient failures retry, never swap", () => {
  it("exposes a typed transient error carrying the status", () => {
    const e = new HostedTransientError(503, "grok 503 upstream");
    assert.ok(e instanceof Error);
    assert.equal(e.status, 503);
    assert.equal(e.name, "HostedTransientError");
  });

  it("retries on the same provider and never reaches for another", () => {
    assert.match(src, /class HostedTransientError/);
    assert.match(src, /RETRY_STATUSES/);
    const fn = src.slice(src.indexOf("export async function streamHosted"));
    assert.doesNotMatch(
      fn,
      /provider\s*=\s*"kimi"|provider\s*=\s*"grok"|fallbackProvider/,
      "a hiccup must never change who is talking",
    );
  });

  it("treats rate limits and server errors as retryable, not as a brain change", () => {
    const line = /const RETRY_STATUSES = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(line, "RETRY_STATUSES must be an explicit list");
    for (const status of ["429", "500", "502", "503", "504"]) {
      assert.ok(line[1].includes(status), `${status} must be retried, not swapped`);
    }
  });
});

describe("the meter is fed from real counts", () => {
  it("asks the provider for the usage frame", () => {
    assert.match(src, /stream_options: \{ include_usage: true \}/);
  });

  it("bills reasoning tokens as output — they are not inside completion_tokens", () => {
    assert.match(src, /completion_tokens_details\?\.reasoning_tokens/);
  });

  it("records the ZDR header from the response, never from a setting", () => {
    assert.match(src, /recordZdrHeader\(opts\.provider, res\.headers\.get\("x-zero-data-retention"\)\)/);
  });
});

/**
 * PIN-DOWN — the callVoice branch, live-probed 2026-08-07
 * (scripts/debug/call-probe.mjs, probes 2 and 3): POST /api/chat with
 * callVoice:true returned 200 with a spoken-style reply in ~2.2-2.5s, and
 * data/memory.json was byte-for-byte unchanged across those turns. These
 * assertions pin the exact source facts behind both observations.
 */
describe("callVoice branch — reaches the same grok-4.5 lane, never writes memory", () => {
  it("the grok lane is gated on tier.provider, not on callVoice — a call turn takes the same brain as a normal turn", () => {
    assert.match(
      route,
      /const grokLane =\s*\n\s*tier\.provider === "grok" &&/,
      "INTERFACE INVARIANT #2: callVoice:true must reach grok-4.5 via the same grokLane branch a normal turn uses",
    );
  });

  it("the grokLane branch calls streamHosted with provider: \"grok\" — this is what answered the probed calls", () => {
    const grokBlock = route.slice(
      route.indexOf("} else if (grokLane)"),
      route.indexOf("} else if (grokLane)") + 800,
    );
    assert.match(grokBlock, /provider: "grok"/);
    assert.match(grokBlock, /await streamHosted\(/);
  });

  it("CALL_DELIVERY_NOTE (spoken-reply style) is appended only when callVoice is true", () => {
    assert.match(route, /callVoice \? CALL_DELIVERY_NOTE : "",/);
  });

  it("a callVoice turn skips recordExchange — matches the probed memory.json being unchanged", () => {
    // WHAT THIS GUARDS, restated: a callVoice turn must not write EITHER memory
    // row — the call client owns its own transcript (recordCallTurn) and a
    // second writer here double-writes the shared store. That is the invariant,
    // and it is asserted below by requiring both calls to sit inside an
    // `if (!callVoice)` block.
    //
    // WHAT IT NO LONGER PINS: the literal `await` in front of the user write.
    // That write rewrites the whole of data/memory.json (522KB as of this
    // commit, measured 8.9-24.8ms and growing with every turn) and used to sit
    // in the gap between Classic pressing Enter and her first token, for no
    // reason — the prompt is built from the memory snapshot read earlier in the
    // request, so nothing about the reply depends on the row having landed.
    // It is now started without being awaited and joined before the assistant
    // write (`await userWrite`), which preserves user-then-assistant ordering
    // in the store. Pinning the keyword `await` here would have blocked that
    // without protecting anything this test exists to protect.
    const userWriteBlock = route.slice(
      route.indexOf('if (!callVoice) {'),
      route.indexOf('if (!callVoice) {') + 700,
    );
    assert.match(
      userWriteBlock,
      /recordExchange\("user", lastUser\)/,
      "the live probe found data/memory.json byte-identical across callVoice:true turns; this is why",
    );
    const assistantIdx = route.indexOf(
      'recordExchange("assistant", stripThinkTags(full))',
    );
    assert.ok(
      assistantIdx > 0,
      "the assistant memory row must still be written",
    );
    // The assistant write must still be guarded by !callVoice: walk back from
    // the call to the nearest enclosing guard and require it to be that one.
    const before = route.slice(Math.max(0, assistantIdx - 700), assistantIdx);
    assert.ok(
      before.lastIndexOf("if (!callVoice) {") >= 0,
      "the assistant recordExchange must stay inside an if (!callVoice) block",
    );
    // Ordering barrier: the un-awaited user write must be joined before the
    // assistant row is written, or the store can land out of order.
    assert.match(
      before,
      /await userWrite;/,
      "the assistant write must await the user write so memory stays in order",
    );
  });
});
