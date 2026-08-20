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
  | "exceeds_local_max_notional";

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
 * Validate, then build. The ceiling is applied to sells as well as buys: a sell
 * that is wrong about its size is still a position he did not mean to take, and
 * refusing it costs nothing but a corrected retry.
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
  if (!Number.isFinite(req.maxNotionalCents) || req.maxNotionalCents <= 0) {
    // No usable ceiling is a refusal, never an unlimited order.
    return { ok: false, reason: "bad_max_notional" };
  }
  if (notionalCents(req) > req.maxNotionalCents) {
    return { ok: false, reason: "exceeds_local_max_notional" };
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
