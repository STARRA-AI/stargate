/**
 * Phase 2 — prompt caching / token diet shape.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSystemPromptBlocks,
  clearCanonCache,
  loadStableSystemPrompt,
} from "../src/lib/brain";
import { cachedTools } from "../src/lib/agent/anthropic";

describe("prompt caching shape", () => {
  it("reuses stable canon cache across builds", () => {
    clearCanonCache();
    const a = loadStableSystemPrompt();
    const b = loadStableSystemPrompt();
    assert.equal(a, b);
    assert.ok(a.length > 500);
  });

  it("keeps volatile extras out of the stable block", () => {
    clearCanonCache();
    const blocks = buildSystemPromptBlocks([
      "MEMORY TIERS\nWorking: volatile-sentinel-xyz",
    ]);
    assert.ok(!blocks.stable.includes("volatile-sentinel-xyz"));
    assert.ok(blocks.volatile.includes("volatile-sentinel-xyz"));
    assert.ok(blocks.full.includes("volatile-sentinel-xyz"));
  });

  it("marks last tool with cache_control", () => {
    const tools = cachedTools();
    const last = tools[tools.length - 1] as {
      cache_control?: { type: string };
    };
    assert.deepEqual(last.cache_control, { type: "ephemeral" });
  });
});
