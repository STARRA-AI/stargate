/**
 * DRAGON SWEEP — realized-profit tracker and withdraw signal.
 *
 * Classic runs a withdraw-and-redeploy loop: profit leaves the Kalshi
 * account and comes back on his schedule. This is the pure math behind "how
 * much realized profit is past what he wants left working, and is it time
 * to sweep it out." PURE on purpose: no fetch, no filesystem, no Date.now(),
 * no import from dragon-tradar.ts. Every input arrives as an argument — that
 * separation is what lets the HTTP client (dragon-tradar.ts) change shape
 * without this module caring, and what makes this module trivial to test.
 *
 * Money is CENTS everywhere, as integers. Nothing here converts to dollars —
 * that only ever happens at display time, in balanceUsd() (dragon-tradar.ts).
 *
 * Unrealized P&L is NEVER swept and never counts toward the target: an open
 * position is not money yet.
 */

/**
 * Structural subset of `AgentPerformance` (dragon-tradar.ts) — just the two
 * fields the math below needs, so a fuller object satisfies this as-is.
 * Deliberately not importing AgentPerformance itself; see file doc comment.
 */
export type SweepPerf = {
  realizedPnlCents: number;
  unrealizedPnlCents: number;
};

/** Where the last sweep left off, and the thresholds Classic set for this one. */
export type SweepMarks = {
  lastSweepAtRealizedCents: number;
  targetCents: number;
  keepWorkingCents: number;
};

export type SweepState = {
  realizedSinceSweepCents: number;
  atOrAboveTarget: boolean;
  suggestedSweepCents: number;
};

/**
 * Realized profit earned since the last sweep, whether it has reached the
 * target, and how much to suggest sweeping (keeping `keepWorkingCents`
 * behind). Guarded against realized having dropped below the last sweep
 * mark — losses after a sweep must never produce a negative or phantom
 * suggestion, so `realizedSinceSweepCents` floors at 0 before anything else
 * is derived from it.
 */
export function sweepState(perf: SweepPerf, marks: SweepMarks): SweepState {
  const realizedSinceSweepCents = Math.max(
    0,
    perf.realizedPnlCents - marks.lastSweepAtRealizedCents,
  );
  const atOrAboveTarget = realizedSinceSweepCents >= marks.targetCents;
  const suggestedSweepCents = Math.max(0, realizedSinceSweepCents - marks.keepWorkingCents);
  return { realizedSinceSweepCents, atOrAboveTarget, suggestedSweepCents };
}

/**
 * PURE: returns the NEW marks after sweeping `sweptCents` at realized total
 * `atRealizedCents`. Does not persist, touch a store, or write a file — that
 * is a caller's job, not this one's. Not consumed anywhere yet; it exists so
 * a later task has the operation available.
 */
export function recordSweep(
  marks: SweepMarks,
  sweptCents: number,
  atRealizedCents: number,
): SweepMarks {
  return { ...marks, lastSweepAtRealizedCents: atRealizedCents };
}
