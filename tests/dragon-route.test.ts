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

/**
 * CONTROL ROUTE — the decisions `/api/dragon/control`'s POST handler is built
 * from. This endpoint starts and stops REAL trading off a language model's
 * tool call, so "what counts as a valid request" is pinned here rather than
 * discovered live.
 */
import {
  parseControlRequest,
  controlFeedLine,
  controlFeedTag,
  type ControlCommand,
} from "../src/app/api/dragon/control/route";

describe("parseControlRequest", () => {
  it("accepts the three actions", () => {
    assert.deepEqual(parseControlRequest({ action: "engage", category: "crypto" }), {
      ok: true,
      cmd: { action: "engage", category: "crypto" },
    });
    assert.deepEqual(parseControlRequest({ action: "disengage" }), {
      ok: true,
      cmd: { action: "disengage" },
    });
    assert.deepEqual(parseControlRequest({ action: "config", config: { maxLegs: 2 } }), {
      ok: true,
      cmd: { action: "config", config: { maxLegs: 2 } },
    });
  });

  it("engage without a category is refused, not defaulted", () => {
    assert.deepEqual(parseControlRequest({ action: "engage" }), {
      ok: false,
      code: "category_required",
    });
  });

  it("engage with an unknown category is refused", () => {
    assert.deepEqual(parseControlRequest({ action: "engage", category: "commodities" }), {
      ok: false,
      code: "unknown_category",
    });
  });

  it("an unknown, missing, or non-object action is refused", () => {
    for (const raw of [{ action: "liquidate" }, {}, null, undefined, "engage", 7, []]) {
      assert.deepEqual(
        parseControlRequest(raw),
        { ok: false, code: "unknown_action" },
        `${JSON.stringify(raw)} must not become a command`,
      );
    }
  });

  it("config must carry an object, not an array or a string", () => {
    for (const cfg of [undefined, null, "maxLegs=2", 3, [1, 2]]) {
      assert.deepEqual(parseControlRequest({ action: "config", config: cfg }), {
        ok: false,
        code: "config_required",
      });
    }
  });

  it("disengage ignores extra fields — the stop is never blocked on parsing", () => {
    assert.deepEqual(parseControlRequest({ action: "disengage", category: "bogus", x: 1 }), {
      ok: true,
      cmd: { action: "disengage" },
    });
  });
});

describe("controlFeedLine", () => {
  const engage: ControlCommand = { action: "engage", category: "sports" };

  it("names the outcome, not just the attempt", () => {
    assert.match(controlFeedLine(engage, { state: "ok", stats: {} }), /ENGAGE sports — accepted/);
    assert.match(controlFeedLine(engage, { state: "blocked" }), /throttled \(429\)/);
    assert.match(controlFeedLine(engage, { state: "rejected" }), /token rejected/);
    assert.match(controlFeedLine(engage, { state: "off" }), /nothing sent/);
  });

  it("carries his app's own refusal code through to the feed", () => {
    const line = controlFeedLine(engage, {
      state: "error",
      status: 409,
      code: "agent_trading_disabled",
    });
    assert.match(line, /409 agent_trading_disabled/);
  });

  it("a config line lists the fields that were sent", () => {
    const cmd: ControlCommand = { action: "config", config: { maxLegs: 3, autoFire: true } };
    assert.match(controlFeedLine(cmd, { state: "ok", stats: {} }), /CONFIG maxLegs,autoFire/);
  });

  it("only a clean accept is SYS — everything else is an ALERT he must see", () => {
    assert.equal(controlFeedTag({ state: "ok", stats: {} }), "SYS");
    for (const r of [
      { state: "off" } as const,
      { state: "blocked" } as const,
      { state: "rejected" } as const,
      { state: "error", status: 500 } as const,
    ]) {
      assert.equal(controlFeedTag(r), "ALERT");
    }
  });
});

describe("agentAlertMessage — with orders in the read set", () => {
  it("one line however many of the five reads failed", () => {
    assert.equal(
      agentAlertMessage(["ok", "rejected", "rejected", "rejected", "rejected"]),
      "Dragon Tradar rejected the agent token — regenerate it in Settings → AI Trading Agent",
    );
  });

  it("a throttle anywhere in the five still outranks a rejection", () => {
    assert.match(
      String(agentAlertMessage(["ok", "rejected", "blocked", "ok", "ok"])),
      /throttled the agent token \(429\)/,
    );
  });

  it("orders failing alone still raises the line — a resting order is money", () => {
    assert.match(String(agentAlertMessage(["ok", "ok", "blocked", "ok", "ok"])), /throttled/);
  });

  it("all five healthy says nothing", () => {
    assert.equal(agentAlertMessage(["ok", "ok", "ok", "ok", "ok"]), null);
  });
});
