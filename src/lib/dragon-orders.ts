/**
 * DRAGON ORDERS — the only code in this deck that can lose Classic money.
 *
 * It lives in its own file for exactly that reason: order construction has a
 * blast radius nothing else here has, so it gets its own tests and its own
 * review surface. Every rule below is a rule about NOT placing a trade.
 *
 * ── THE TWO PROPERTIES THIS FILE EXISTS TO HOLD ──────────────────────────────
 *
 * 1. AN ORDER IS BUILT AND CHECKED BEFORE ANYTHING TOUCHES THE NETWORK.
 *    Count, price and notional are validated locally. A malformed order is a
 *    named refusal, never a request. The caller is a language model reading a
 *    tool schema; it will eventually send something wrong, and that must cost
 *    nothing.
 *
 * 2. THE SAME INTENT IN THE SAME SECOND IS THE SAME ORDER.
 *    `clientOrderId` is a hash of the intent plus the current second, so a
 *    retried or double-fired request carries an id his app has already seen
 *    and is answered with the ORIGINAL order (`duplicate: true`, Task A1
 *    step 2) instead of becoming a second real position.
 *
 *    HONEST LIMIT: two identical intents that straddle a second boundary hash
 *    differently, and a genuinely intended second identical order inside the
 *    same second collapses into the first. The client-side id narrows the
 *    window; the SERVER's idempotency store is the actual guarantee. It is not
 *    a substitute for it.
 *
 * The local ceiling here is a floor on caution, not a replacement for his
 * app's `maxOrderNotionalUsd` or `AGENT_LIVE_TRADING_ENABLED`. Both still run
 * server-side, and nothing here can loosen either.
 */
import { createHash } from "node:crypto";
import {
  agentPost,
  agentDelete,
  type AgentDeps,
  type AgentOrder,
  type AgentResult,
} from "@/lib/dragon-tradar";

export type OrderSide = "yes" | "no";
export type OrderAction = "buy" | "sell";

/** What she asks for. Kalshi prices are whole cents, 1..99. */
export type OrderIntent = {
  ticker: string;
  side: OrderSide;
  action: OrderAction;
  count: number;
  priceCents: number;
};

/** An intent plus the ceiling it must fit under. */
export type OrderRequest = OrderIntent & { maxNotionalCents: number };

/** Exactly the body Task A1's `POST /order` takes. */
export type BuiltOrder = OrderIntent & { clientOrderId: string };

export type OrderRejection =
  | "bad_ticker"
  | "bad_side"
  | "bad_action"
  | "bad_count"
  | "bad_price"
  | "bad_max_notional"
  | "exceeds_local_max_notional"
  /** An EXIT over the ceiling. Same brake as above, named apart so a blocked
   *  exit is never read as a blocked entry — the answer is to SLICE it, not to
   *  abandon the trade. See the argument on buildOrder. */
  | "exceeds_local_max_notional_exit";

export type BuildResult = { ok: true; order: BuiltOrder } | { ok: false; reason: OrderRejection };

/**
 * Stable id for (intent, second). Same intent, same second -> same id, so a
 * retry inside that window cannot become a second position. Deliberately does
 * NOT include maxNotionalCents: the ceiling is a local policy, not part of
 * what the order IS, and changing it must not mint a new id for the same trade.
 */
export function newClientOrderId(intent: OrderIntent, nowMs: number): string {
  const second = Math.floor(nowMs / 1000);
  const canonical = [
    intent.ticker,
    intent.side,
    intent.action,
    intent.count,
    intent.priceCents,
    second,
  ].join("|");
  return `starra-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/** Cents at risk if the whole order fills. */
export function notionalCents(intent: Pick<OrderIntent, "count" | "priceCents">): number {
  return intent.count * intent.priceCents;
}

/**
 * Validate, then build.
 *
 * ── THE CEILING APPLIES TO BOTH DIRECTIONS, AND HERE IS THE ARGUMENT ─────────
 * Structural checks (ticker, side, action, count, price) run on every order — a
 * malformed order is malformed whichever way it points. The NOTIONAL CEILING
 * runs on every order too. That is a deliberate reversal of a change made here
 * on 2026-08-25, and the reversal is worth spelling out because the argument it
 * reverses is a GOOD one.
 *
 * THE CASE FOR EXEMPTING SELLS: a sell reduces exposure, so refusing one for
 * being "too large" is refusing to let him OUT of a position. The worst case
 * for a blocked buy is a trade he did not make; the worst case for a blocked
 * sell is a position he cannot escape. Not symmetric.
 *
 * WHY IT STILL LOSES, on two counts:
 *
 *   1. `buildOrder` CANNOT SEE A POSITION. It takes a ticker, a side, a count
 *      and a price — nothing else. "This sell reduces exposure" is therefore an
 *      assumption this function has no way to check, and it is not always true:
 *      a sell of a side he does not hold is not an exit, it is new exposure
 *      pointing the other way. Exempting `sell` exempts both cases, because
 *      from in here they are indistinguishable.
 *
 *   2. THE TWO FAILURES ARE NOT EQUALLY RECOVERABLE. A blocked exit costs him a
 *      corrected retry and the position is still there and still sellable. An
 *      erroneous oversized order that goes through costs money that does not
 *      come back. The caller is a language model reading a tool schema, and
 *      this file's own header says it "will eventually send something wrong."
 *
 * ── WHAT A BLOCKED EXIT ACTUALLY COSTS, stated exactly ──────────────────────
 * SLICING IS THE RUNTIME REMEDY, and it is the only one. Selling N contracts as
 * two orders of N/2 clears the same ceiling and needs nothing restarted.
 *
 * "Raise the ceiling" is NOT available mid-market, and this comment used to say
 * it was. `effectiveCeilingCents` (api/dragon/order/route.ts) only ever applies
 * `Math.min(requested, deckCeiling)` — a caller may tighten it and can never
 * loosen it — and the deck ceiling itself comes from the
 * `DRAGON_MAX_ORDER_NOTIONAL_CENTS` env read at
 * `readOrderCeilingCents`, i.e. an env edit plus a server restart.
 *
 * THE REAL BITE, worth knowing before a position moves: the ceiling is on
 * NOTIONAL, so a position that has appreciated needs more slices to exit than
 * it took to enter. 1000 contracts bought at 10c is 10,000c — exactly the
 * $100 default. At 90c the same 1000 contracts are 90,000c, so the exit takes
 * nine orders where the entry took one. That is a real cost of keeping the
 * brake symmetric, and it is Classic's call whether to accept it or to raise
 * DRAGON_MAX_ORDER_NOTIONAL_CENTS.
 *
 * An oversized exit gets its OWN refusal reason —
 * `exceeds_local_max_notional_exit` — so a blocked exit can never be mistaken
 * for a blocked entry in a log or a spoken reply, and the answer is always
 * "slice it", never "abandon the trade".
 *
 * This is a floor on caution, not a replacement for his app's
 * `maxOrderNotionalUsd` or `AGENT_LIVE_TRADING_ENABLED` — both still run
 * server-side, and nothing here can loosen either.
 */
export function buildOrder(req: OrderRequest, nowMs: number = Date.now()): BuildResult {
  if (typeof req.ticker !== "string" || req.ticker.trim() === "") {
    return { ok: false, reason: "bad_ticker" };
  }
  if (req.side !== "yes" && req.side !== "no") return { ok: false, reason: "bad_side" };
  if (req.action !== "buy" && req.action !== "sell") return { ok: false, reason: "bad_action" };
  if (!Number.isInteger(req.count) || req.count <= 0) return { ok: false, reason: "bad_count" };
  if (!Number.isInteger(req.priceCents) || req.priceCents < 1 || req.priceCents > 99) {
    return { ok: false, reason: "bad_price" };
  }
  // No usable ceiling is a refusal, never an unlimited order — in either
  // direction, because this function cannot tell an exit from new exposure.
  if (!Number.isFinite(req.maxNotionalCents) || req.maxNotionalCents <= 0) {
    return { ok: false, reason: "bad_max_notional" };
  }
  if (notionalCents(req) > req.maxNotionalCents) {
    // Same brake, different name, so a blocked EXIT is never read as a blocked
    // entry — the fix for this one is the ceiling, not the trade.
    return {
      ok: false,
      reason: req.action === "sell" ? "exceeds_local_max_notional_exit" : "exceeds_local_max_notional",
    };
  }

  const intent: OrderIntent = {
    ticker: req.ticker,
    side: req.side,
    action: req.action,
    count: req.count,
    priceCents: req.priceCents,
  };
  return { ok: true, order: { ...intent, clientOrderId: newClientOrderId(intent, nowMs) } };
}

/**
 * POST /order. ONE attempt — a 423 daily-loss-floor, a 429 throttle, or a
 * timeout is REPORTED, never retried. A network timeout is the dangerous case:
 * the order may have landed, so re-firing it is exactly what the idempotency
 * key exists to prevent, and re-firing it blind is what this refuses to do.
 */
export async function placeOrder(
  req: OrderRequest,
  deps: AgentDeps = {},
  nowMs: number = Date.now(),
): Promise<AgentResult<AgentOrder>> {
  const built = buildOrder(req, nowMs);
  if (!built.ok) return { state: "error", status: 0, code: built.reason };
  return agentPost<AgentOrder>("/order", built.order, deps);
}

/** DELETE /order/:id — cancel. Only ever reduces exposure. One attempt. */
export async function cancelOrder(
  orderId: string,
  deps: AgentDeps = {},
): Promise<AgentResult<AgentOrder>> {
  if (typeof orderId !== "string" || orderId.trim() === "") {
    return { state: "error", status: 0, code: "bad_order_id" };
  }
  return agentDelete<AgentOrder>(`/order/${encodeURIComponent(orderId)}`, deps);
}
