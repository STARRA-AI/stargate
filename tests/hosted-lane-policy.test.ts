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
