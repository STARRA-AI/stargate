/**
 * DRAGON SWEEP — the rule this file defends: realized profit is the only
 * thing that ever gets suggested for withdrawal. Unrealized P&L (an open
 * position) is not money yet, and a realized figure that dips below the
 * last sweep mark (losses after a sweep) must never produce a negative or
 * phantom suggestion.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sweepState, recordSweep } from "../src/lib/dragon-sweep";

describe("dragon sweep", () => {
  it("suggests sweeping only realized profit above the redeploy floor", () => {
    const s = sweepState(
      { realizedPnlCents: 62_000, unrealizedPnlCents: 9_000 },
      { lastSweepAtRealizedCents: 12_000, targetCents: 25_000, keepWorkingCents: 10_000 },
    );
    assert.equal(s.realizedSinceSweepCents, 50_000);
    assert.equal(s.atOrAboveTarget, true);
    assert.equal(s.suggestedSweepCents, 40_000); // 50k realized, 10k stays working
  });

  it("never suggests sweeping unrealized gains", () => {
    const s = sweepState(
      { realizedPnlCents: 0, unrealizedPnlCents: 80_000 },
      { lastSweepAtRealizedCents: 0, targetCents: 25_000, keepWorkingCents: 10_000 },
    );
    assert.equal(s.suggestedSweepCents, 0);
    assert.equal(s.atOrAboveTarget, false);
  });

  it("realized dropping below the last sweep mark reports the honest loss, but never suggests a negative sweep", () => {
    // Losses after a sweep: realized fell from 50k back to 40k. The delta is
    // a real -$100 he is down since the sweep, and that must render as such
    // — but the suggestion and target-check still floor/refuse at 0.
    const s = sweepState(
      { realizedPnlCents: 40_000, unrealizedPnlCents: 0 },
      { lastSweepAtRealizedCents: 50_000, targetCents: 25_000, keepWorkingCents: 10_000 },
    );
    assert.equal(s.realizedSinceSweepCents, -10_000);
    assert.equal(s.atOrAboveTarget, false);
    assert.equal(s.suggestedSweepCents, 0);
  });

  it("realizedSinceSweepCents exactly at target counts as at-or-above (boundary, not off-by-one)", () => {
    const s = sweepState(
      { realizedPnlCents: 25_000, unrealizedPnlCents: 0 },
      { lastSweepAtRealizedCents: 0, targetCents: 25_000, keepWorkingCents: 10_000 },
    );
    assert.equal(s.realizedSinceSweepCents, 25_000);
    assert.equal(s.atOrAboveTarget, true);
  });

  it("recordSweep returns new marks at the swept realized total, without mutating the input", () => {
    const marks = { lastSweepAtRealizedCents: 12_000, targetCents: 25_000, keepWorkingCents: 10_000 };
    const next = recordSweep(marks, 40_000, 62_000);
    assert.equal(next.lastSweepAtRealizedCents, 62_000);
    assert.equal(next.targetCents, 25_000);
    assert.equal(next.keepWorkingCents, 10_000);
    assert.equal(marks.lastSweepAtRealizedCents, 12_000, "input marks must not mutate");
  });
});
