/**
 * DRAGON ROUTE — the decisions `/api/dragon`'s GET handler is built from,
 * pulled out so they're testable without standing up a Next route. The rule
 * this file defends: these three are money- and ops-feed-facing, so a later
 * "simplification" (env fallback, alert dedup, sweep gate) must fail a test,
 * not ship silently on an endpoint Classic acts on with real money.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSweepMarks, agentAlertMessage, computeSweep } from "../src/app/api/dragon/route";

describe("readSweepMarks — env fallback", () => {
  it("empty env uses the documented defaults", () => {
    assert.deepEqual(readSweepMarks({}), {
      targetCents: 2_500_000,
      keepWorkingCents: 0,
      lastSweepAtRealizedCents: 0,
    });
  });

  it("a non-numeric value falls back to the default, not NaN", () => {
    const marks = readSweepMarks({ DRAGON_SWEEP_TARGET_CENTS: "abc" });
    assert.equal(marks.targetCents, 2_500_000);
    assert.equal(Number.isNaN(marks.targetCents), false);
  });

  it("a negative value falls back to the default — never a garbage sweep number", () => {
    const marks = readSweepMarks({ DRAGON_SWEEP_LAST_MARK_CENTS: "-5" });
    assert.equal(marks.lastSweepAtRealizedCents, 0);
  });

  it("a valid value overrides its own default and nothing else", () => {
    const marks = readSweepMarks({ DRAGON_SWEEP_KEEP_WORKING_CENTS: "15000" });
    assert.equal(marks.keepWorkingCents, 15_000);
    assert.equal(marks.targetCents, 2_500_000);
    assert.equal(marks.lastSweepAtRealizedCents, 0);
  });
});

describe("agentAlertMessage — one line, not one per failing read", () => {
  it("all four reads healthy: no alert", () => {
    assert.equal(agentAlertMessage(["ok", "ok", "ok", "ok"]), null);
  });

  it("four simultaneous blocked reads still yield exactly one message", () => {
    const msg = agentAlertMessage(["blocked", "blocked", "blocked", "blocked"]);
    assert.equal(typeof msg, "string");
    assert.match(msg as string, /throttled/);
  });

  it("a single blocked read among healthy ones still alerts", () => {
    const msg = agentAlertMessage(["ok", "blocked", "ok", "ok"]);
    assert.match(msg as string, /throttled/);
  });

  it("rejected produces different text than blocked", () => {
    const blocked = agentAlertMessage(["blocked"]);
    const rejected = agentAlertMessage(["rejected"]);
    assert.notEqual(blocked, rejected);
    assert.match(rejected as string, /regenerate/);
  });

  it("blocked takes precedence when both blocked and rejected are present", () => {
    const msg = agentAlertMessage(["rejected", "blocked"]);
    assert.match(msg as string, /throttled/);
  });

  it("off and error states alone don't trigger an alert", () => {
    assert.equal(agentAlertMessage(["off", "off", "error", "off"]), null);
  });
});

describe("computeSweep — never a synthesised number", () => {
  const marks = { targetCents: 25_000, keepWorkingCents: 10_000, lastSweepAtRealizedCents: 0 };
  const okPerf = {
    state: "ok" as const,
    stats: {
      realizedPnlCents: 40_000,
      unrealizedPnlCents: 5_000,
      winRate: 0.6,
      tradeCount: 12,
      since: "2026-08-01",
    },
  };

  it("performance ok: returns the real sweep math", () => {
    const sweep = computeSweep(okPerf, marks);
    assert.deepEqual(sweep, {
      realizedSinceSweepCents: 40_000,
      atOrAboveTarget: true,
      suggestedSweepCents: 30_000,
    });
  });

  it("every non-ok state returns null, never a zeroed-out sweep", () => {
    for (const bad of [
      { state: "off" as const },
      { state: "blocked" as const },
      { state: "rejected" as const },
      { state: "error" as const, status: 500 },
    ]) {
      assert.equal(computeSweep(bad, marks), null);
    }
  });
});
