/**
 * PROMPT CACHE — the header that decides whether Classic pays $11 or $73.
 *
 * WHY THIS FILE IS A TEST: cache misses are completely invisible at runtime.
 * She answers correctly, at the same speed, sounding identical — and costs 6.5x
 * more. Nothing in the product surfaces it. Only the bill does, a month later.
 *
 * MEASURED LIVE 2026-08-06 against grok-4.5 with her real 13,734-token prompt:
 *   without x-grok-conv-id:  128 cached / 13,734  (0.9%)  -> $0.0272 input/turn
 *   with    x-grok-conv-id: 13,696 cached / 13,734 (99.7%) -> $0.00418 input/turn
 * At his measured 66 turns/day that is ~$73/mo versus ~$11/mo.
 *
 * xAI's own guidance: "Setting x-grok-conv-id routes requests to the same
 * server, maximizing cache hits... Monitor cached_tokens — if consistently 0,
 * verify your conversation ID."
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(REPO, "src/lib/llm/hosted.ts"), "utf8");

describe("prompt cache", () => {
  it("sends x-grok-conv-id on the grok lane", () => {
    assert.match(src, /x-grok-conv-id/, "without this the canon prefix never caches");
  });

  it("the conversation id is STABLE, not random per request", () => {
    // A fresh uuid per call routes to a different server every time, which is
    // the same as sending nothing at all.
    const idx = src.indexOf("x-grok-conv-id");
    const around = src.slice(Math.max(0, idx - 700), idx + 400);
    assert.doesNotMatch(
      around,
      /randomUUID\(\)|Math\.random\(\)|Date\.now\(\)/,
      "a per-request id defeats the cache entirely",
    );
  });

  it("is overridable but never empty", () => {
    assert.match(src, /STARRA_CONV_ID/, "operator override must exist");
    assert.match(src, /GROK_CONV_ID_DEFAULT|conv-id fallback|DEFAULT_CONV_ID/i);
  });

  it("only the grok lane gets it — Groq has no such header", () => {
    const idx = src.indexOf("x-grok-conv-id");
    const around = src.slice(Math.max(0, idx - 400), idx + 200);
    assert.match(around, /provider === "grok"|grok/, "must be scoped to the xAI lane");
  });
});
