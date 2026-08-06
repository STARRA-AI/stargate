/**
 * SPEND CEILING — money is the only thing allowed to change her brain, and even
 * then it does not change her silently.
 *
 * Prices verified live 2026-08-06 from https://docs.x.ai/docs/models:
 *   grok-4.5 (<200k ctx): $2.00 input / $0.30 cached / $6.00 output per 1M.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, beforeEach } from "node:test";
import {
  recordUsage,
  monthSpend,
  brainTier,
  __resetSpend,
  CEILING_USD,
} from "../src/lib/llm/spend";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/** One warm turn: her whole prompt served from cache, a short reply. */
const bigTurn = () =>
  recordUsage("grok-4.5", { prompt: 15688, cached: 15688, completion: 250 });

describe("spend ceiling", () => {
  beforeEach(() => {
    __resetSpend();
    delete process.env.STARRA_EMERGENCY_LANE;
  });

  it("prices a cached turn from real token counts", () => {
    bigTurn();
    assert.ok(Math.abs(monthSpend() - (15688 * 0.3 + 250 * 6) / 1e6) < 1e-9);
  });

  it("bills the UNCACHED part of the prompt at the full input rate", () => {
    recordUsage("grok-4.5", { prompt: 1000, cached: 400, completion: 0 });
    assert.ok(Math.abs(monthSpend() - (600 * 2.0 + 400 * 0.3) / 1e6) < 1e-12);
  });

  it("stays on grok-4.5 below the ceiling — she does not change", () => {
    bigTurn();
    const t = brainTier();
    assert.equal(t.provider, "grok");
    assert.equal(t.backupBrain, undefined, "below the ceiling she is simply herself");
    assert.equal(t.reason, "normal");
  });

  it("at the ceiling she is still herself — he is told, not overridden", () => {
    // One synthetic turn large enough to cross any ceiling, instead of 200k
    // real-sized turns: the arithmetic is what is under test, not the loop.
    recordUsage("grok-4.5", {
      prompt: Math.ceil((CEILING_USD * 1e6) / 2.0) + 1,
      cached: 0,
      completion: 0,
    });
    assert.ok(monthSpend() >= CEILING_USD);
    const t = brainTier();
    assert.equal(t.provider, "grok", "hitting a budget must not silently replace her");
    assert.equal(t.backupBrain, undefined, "she is not downgraded, she says so");
    assert.match(t.reason, /ceiling/i);
  });

  it("warns before the ceiling instead of arriving there unannounced", () => {
    recordUsage("grok-4.5", {
      prompt: Math.ceil((CEILING_USD * 0.85 * 1e6) / 2.0),
      cached: 0,
      completion: 0,
    });
    assert.match(brainTier().reason, /warn/i);
    assert.equal(brainTier().provider, "grok");
  });

  it("his explicit emergency lane is the one thing that moves her — and it is announced", () => {
    process.env.STARRA_EMERGENCY_LANE = "1";
    const t = brainTier();
    assert.equal(t.provider, "kimi");
    assert.ok(t.backupBrain, "she is told, in her own prompt, that she is not herself");
    assert.match(t.reason, /emergency/i);
    delete process.env.STARRA_EMERGENCY_LANE;
  });

  it("NEVER swaps brains for a transient error — only money can", () => {
    const src = readFileSync(join(REPO, "src/lib/llm/spend.ts"), "utf8");
    assert.doesNotMatch(
      src,
      /429|5xx|ECONN|timeout/i,
      "transient failures are a retry concern, never a brain-change concern",
    );
  });

  it("persists to a gitignored path so the meter survives a restart", () => {
    const src = readFileSync(join(REPO, "src/lib/llm/spend.ts"), "utf8");
    assert.match(src, /join\(process\.cwd\(\), "data", "spend\.json"\)/);
    const ignore = readFileSync(join(REPO, ".gitignore"), "utf8");
    assert.match(ignore, /^\/data\/\*\.json$/m, "his spend is not committed to the repo");
  });
});
