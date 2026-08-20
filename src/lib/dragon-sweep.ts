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
 * behind). `realizedSinceSweepCents` is the RAW signed delta — it goes
 * negative when losses after a sweep pull realized back below the mark, and
 * that honest negative number is what a money-facing surface must show
 * (Classic is down since his last sweep, not at breakeven). The safety
 * property lives only in the two derived fields: `keepWorkingCents >= 0`
 * means `suggestedSweepCents` floors at 0 for any negative delta, and
 * `atOrAboveTarget` is already false against a positive target — so a
 * negative delta can never produce an over-generous sweep suggestion even
 * though the delta itself is left unclamped.
 */
export function sweepState(perf: SweepPerf, marks: SweepMarks): SweepState {
  const realizedSinceSweepCents = perf.realizedPnlCents - marks.lastSweepAtRealizedCents;
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
  // sweptCents is intentionally NOT recorded — SweepMarks carries no running
  // swept total (only the last mark), and nothing consumes it yet. Kept in
  // the signature per the brief; discarding it silently on a money function
  // would be the wrong kind of quiet, so this says so.
  return { ...marks, lastSweepAtRealizedCents: atRealizedCents };
}
