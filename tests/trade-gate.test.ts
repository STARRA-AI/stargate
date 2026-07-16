/**
 * Phase 1C — trade-action gate for OpenAlice bridge.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyTradeAction,
  clearPendingTradeConfirmations,
  confirmTrade,
  gateTradeAction,
} from "../src/lib/security/trade-gate";

describe("trade gate", () => {
  it("classifies read vs execute actions", () => {
    for (const action of [
      "status",
      "list issues",
      "research NVDA thesis",
      "quote AAPL",
    ]) {
      assert.equal(classifyTradeAction(action), "read", action);
    }
    for (const action of [
      "buy 10 AAPL market",
      "sell TSLA limit order",
      "place_order MSFT",
      "trading-as-git push commit",
      "execute trade batch-7",
    ]) {
      assert.equal(classifyTradeAction(action), "execute", action);
    }
  });

  it("holds execute actions until confirm", () => {
    clearPendingTradeConfirmations();
    const held = gateTradeAction("buy 5 SPY");
    assert.equal(held.ok, false);
    if (held.ok) throw new Error("expected hold");
    assert.match(held.message, /HELD FOR CONFIRMATION/);
    const approved = confirmTrade(held.token);
    assert.equal(approved, "buy 5 SPY");
  });
});
