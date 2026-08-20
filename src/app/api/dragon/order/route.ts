/**
 * POST /api/dragon/order — place a REAL order against his Kalshi funds.
 * DELETE /api/dragon/order — cancel a resting one.
 *
 * Deck-session gated by `src/middleware.ts` like every other non-public route:
 * `/api/dragon/order` is deliberately NOT in PUBLIC_PREFIXES, so nothing on his
 * LAN — and nothing holding only her voice-tool token — can reach it without
 * his cookie.
 *
 * THE CEILING ONLY EVER TIGHTENS. The deck's own ceiling comes from
 * DRAGON_MAX_ORDER_NOTIONAL_CENTS (default 10,000c = $100, mirroring the
 * "Max $ per order" already set in his app). A caller may ask for a SMALLER
 * ceiling and it is honoured; a caller asking for a larger one gets the deck's.
 * A tool call can never raise the limit on itself.
 *
 * His app's brakes are untouched and still run after this: the "Agent trading
 * enabled" toggle, `maxOrderNotionalUsd`, `AGENT_LIVE_TRADING_ENABLED`, and the
 * server-side daily loss floor.
 */
import { pushFeed } from "@/lib/feed";
import {
  buildOrder,
  placeOrder,
  cancelOrder,
  type OrderRequest,
  type BuildResult,
} from "@/lib/dragon-orders";
import { type AgentOrder, type AgentResult } from "@/lib/dragon-tradar";

export const runtime = "nodejs";

/** $100 — the same number as the per-order cap he already set in his app. */
export const ORDER_CEILING_DEFAULT_CENTS = 10_000;

/** A missing or nonsense env value falls back to the default, never to "no limit". */
export function readOrderCeilingCents(
  env: Record<string, string | undefined> = process.env,
): number {
  const n = Number.parseInt(env.DRAGON_MAX_ORDER_NOTIONAL_CENTS ?? "", 10);
  return Number.isNaN(n) || n <= 0 ? ORDER_CEILING_DEFAULT_CENTS : n;
}

/** A caller may tighten the ceiling. It may not loosen it. */
export function effectiveCeilingCents(requested: unknown, deckCeilingCents: number): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? Math.min(requested, deckCeilingCents)
    : deckCeilingCents;
}

/** Shapes the body into an OrderRequest. Field validation stays in buildOrder. */
export function toOrderRequest(raw: unknown, deckCeilingCents: number): OrderRequest {
  const b = (raw ?? {}) as Record<string, unknown>;
  return {
    ticker: b.ticker as string,
    side: b.side as OrderRequest["side"],
    action: b.action as OrderRequest["action"],
    count: b.count as number,
    priceCents: b.priceCents as number,
    maxNotionalCents: effectiveCeilingCents(b.maxNotionalCents, deckCeilingCents),
  };
}

/** What he reads afterwards. Every attempt gets a line, named by outcome. */
export function orderFeedLine(
  req: OrderRequest,
  built: BuildResult,
  result: AgentResult<AgentOrder> | null,
): string {
  const what = `ORDER ${req.action} ${req.count}x ${req.ticker} ${req.side} @${req.priceCents}c`;
  if (!built.ok) return `Dragon Tradar ${what} — refused locally (${built.reason})`;
  if (!result) return `Dragon Tradar ${what} — not sent`;
  switch (result.state) {
    case "ok":
      return `Dragon Tradar ${what} — placed`;
    case "off":
      return `Dragon Tradar ${what} — no agent token configured, nothing sent`;
    case "blocked":
      return `Dragon Tradar ${what} — throttled (429), NOT retried`;
    case "rejected":
      return `Dragon Tradar ${what} — token rejected`;
    default:
      return `Dragon Tradar ${what} — refused (${result.status}${result.code ? ` ${result.code}` : ""})`;
  }
}

/** The cancel half of orderFeedLine — same vocabulary, one line. */
export function cancelOutcome(result: AgentResult<AgentOrder>): string {
  switch (result.state) {
    case "ok":
      return "cancelled";
    case "off":
      return "no agent token configured, nothing sent";
    case "blocked":
      return "throttled (429), NOT retried";
    case "rejected":
      return "token rejected";
    default:
      return `refused (${result.status}${result.code ? ` ${result.code}` : ""})`;
  }
}

export async function POST(req: Request) {
  let raw: unknown = null;
  try {
    raw = await req.json();
  } catch {
    // not JSON — buildOrder refuses it below by field, not by exception
  }

  const orderReq = toOrderRequest(raw, readOrderCeilingCents());
  const built = buildOrder(orderReq);

  if (!built.ok) {
    // Never reached his app. 400 so a caller can tell that apart from a refusal
    // by his server, which is the difference between "fix the request" and
    // "the floor stopped you".
    pushFeed("ALERT", orderFeedLine(orderReq, built, null));
    return Response.json({ state: "error", status: 0, code: built.reason }, { status: 400 });
  }

  // placeOrder rebuilds from the same request — one attempt, no retry, and the
  // clientOrderId is the second-stable hash that makes a duplicate a no-op.
  const result = await placeOrder(orderReq);
  pushFeed(result.state === "ok" ? "SYS" : "ALERT", orderFeedLine(orderReq, built, result));
  return Response.json(result);
}

export async function DELETE(req: Request) {
  let raw: unknown = null;
  try {
    raw = await req.json();
  } catch {
    // falls through to the empty-id refusal below
  }
  const rawId = ((raw ?? {}) as Record<string, unknown>).orderId;
  const orderId = typeof rawId === "string" ? rawId : "";
  const result = await cancelOrder(orderId);

  // Same split as POST: 400 only when the request never left this machine.
  const local = result.state === "error" && result.status === 0;
  pushFeed(
    result.state === "ok" ? "SYS" : "ALERT",
    result.state === "ok"
      ? `Dragon Tradar CANCEL ${orderId} — cancelled`
      : `Dragon Tradar CANCEL ${orderId || "(no id)"} — ${cancelOutcome(result)}`,
  );
  return Response.json(result, { status: local ? 400 : 200 });
}
