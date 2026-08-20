/**
 * DRAGON TRADAR — AGENT ROUTER (Task A1).
 *
 * THIS FILE IS FOR CLASSIC'S REPLIT APP, NOT FOR THE DECK. It is the other half
 * of the bridge: the deck client in `src/lib/dragon-tradar.ts` and
 * `src/lib/dragon-orders.ts` already calls every route below, and every one of
 * them currently 404s because this does not exist yet.
 *
 * ── WHAT IS VERIFIED AND WHAT IS NOT ─────────────────────────────────────────
 * VERIFIED live against dragontradar.com on 2026-08-20: the base path
 * `/api/agent/v1`, `Authorization: Bearer <token>`, `GET /stats` returning
 * `{connected, balanceCents, positions[]}`, and the 429 `temporarily_blocked`
 * lockout after one bad token.
 *
 * NOT VERIFIED: the inside of Classic's app. This file has never seen his
 * source. So it does NOT guess at his service names — everything it needs is
 * declared in the `AgentServices` interface below, and wiring those functions
 * to the handlers already behind `/api/kalshi/*` and `/api/bot/*` is the one
 * step that must be done there rather than here.
 *
 * ── THE RULE THAT MATTERS MOST: 401/403 IS THE TOKEN, NOTHING ELSE ───────────
 * The deck maps 401 and 403 to "the token was rejected — go regenerate it".
 * If a business refusal (trading disabled, order too large, balance too low)
 * comes back on a 403, Classic gets sent to rotate a perfectly good token while
 * the real cause stays invisible. Status codes below are chosen so every
 * refusal is distinguishable:
 *
 *   401  missing_agent_token, invalid_agent_token      the token, only
 *   429  temporarily_blocked                            throttle / lockout
 *   409  agent_trading_disabled, live_trading_disabled  a brake is off
 *   422  order_exceeds_max_notional, insufficient_balance
 *   423  daily_loss_floor_reached
 *   400  client_order_id_required, invalid_order
 *
 * Every error body is `{"error": "<code>"}` — the deck reads `.error` verbatim
 * and shows it to him.
 */
import { Router, type Request, type Response } from "express";

/* ── THE SEAM ────────────────────────────────────────────────────────────────
 * Wire these to the code already serving /api/kalshi/* and /api/bot/*.
 * Nothing else in this file needs to change.
 * ──────────────────────────────────────────────────────────────────────────── */

export type BotState = {
  running: boolean;
  category: string;
  mode: string;
  lastScanAt: string | null;
  config: Record<string, unknown>;
};

export type Performance = {
  realizedPnlCents: number;
  unrealizedPnlCents: number;
  winRate: number;
  tradeCount: number;
  since: string;
};

export type AgentSettings = {
  /** The "Agent trading enabled" toggle in Settings → AI Trading Agent. */
  enabled: boolean;
  /** "Max $ per order", in dollars, as the panel already stores it. */
  maxOrderNotionalUsd: number;
  /** Task A1 step 3. 0 disables the floor. Stored with the rest of the config. */
  dailyLossFloorCents: number;
};

export type OrderInput = {
  ticker: string;
  side: "yes" | "no";
  action: "buy" | "sell";
  count: number;
  priceCents: number;
  clientOrderId: string;
};

export type AgentServices = {
  agentSettings(): Promise<AgentSettings>;

  balanceCents(): Promise<number>;
  positions(): Promise<unknown[]>;
  orders(status: "open" | "all"): Promise<unknown[]>;
  fills(limit: number): Promise<unknown[]>;
  settlements(limit: number): Promise<unknown[]>;
  performance(): Promise<Performance>;

  /**
   * Realized P&L in cents SINCE MIDNIGHT ET, signed — a loss is negative.
   * This is the number the daily floor is measured against, so it must be
   * realized only: an unrealized drawdown is not a loss until it settles.
   */
  realizedTodayCents(): Promise<number>;

  markets(category: string | undefined, limit: number): Promise<unknown[]>;
  market(ticker: string): Promise<unknown>;
  orderbook(ticker: string): Promise<unknown>;

  botState(): Promise<BotState>;
  engage(category: string): Promise<void>;
  disengage(): Promise<void>;
  getConfig(): Promise<Record<string, unknown>>;
  patchConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>>;

  placeOrder(order: OrderInput): Promise<Record<string, unknown>>;
  cancelOrder(orderId: string): Promise<Record<string, unknown>>;
};

export type AgentRouterOptions = {
  services: AgentServices;
  /** `process.env.AGENT_LIVE_TRADING_ENABLED === "true"`. Read per request, never cached. */
  liveTradingEnabled: () => boolean;
  /** How long a clientOrderId is remembered. Default 24h. */
  idempotencyTtlMs?: number;
  now?: () => number;
};

const CATEGORIES = ["sports", "crypto", "politics", "economics", "parallel"];

const CONFIG_KEYS = [
  "minBetCents",
  "maxLegs",
  "minEdgePct",
  "minConfidencePct",
  "autoFire",
  "scanIntervalMin",
  "thinkTank",
  "dailyLossFloorCents",
];

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

function intParam(raw: unknown, fallback: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isNaN(n) || n <= 0 ? fallback : n;
}

/**
 * THE IDEMPOTENCY STORE — the single most important thing in this file.
 *
 * A `clientOrderId` that has been seen returns the ORIGINAL order with
 * `duplicate: true` instead of placing a second one. Without this, one network
 * hiccup on the deck side becomes two real positions.
 *
 * HONEST LIMIT: in-memory. A Replit restart forgets every id, which reopens the
 * window for exactly as long as it takes the deck to retry across that restart.
 * If the app has a database, move this Map into a table with a unique index on
 * clientOrderId — that is the version that actually cannot double-fill.
 */
class IdempotencyStore {
  private seen = new Map<string, { at: number; body: Record<string, unknown> }>();

  constructor(
    private ttlMs: number,
    private now: () => number,
  ) {}

  get(id: string): Record<string, unknown> | undefined {
    const hit = this.seen.get(id);
    if (!hit) return undefined;
    if (this.now() - hit.at > this.ttlMs) {
      this.seen.delete(id);
      return undefined;
    }
    return hit.body;
  }

  put(id: string, body: Record<string, unknown>): void {
    this.seen.set(id, { at: this.now(), body });
    // Cheap sweep so a long-lived process cannot grow without bound.
    if (this.seen.size > 5000) {
      const cutoff = this.now() - this.ttlMs;
      for (const [k, v] of this.seen) if (v.at < cutoff) this.seen.delete(k);
    }
  }
}

export function createAgentRouter(opts: AgentRouterOptions): Router {
  const { services, liveTradingEnabled } = opts;
  const now = opts.now ?? (() => Date.now());
  const store = new IdempotencyStore(opts.idempotencyTtlMs ?? 24 * 60 * 60 * 1000, now);
  const router = Router();

  // NOTE: mount this router BEHIND the same Bearer-token middleware that already
  // guards /api/agent/v1/stats. That middleware owns 401 missing_agent_token /
  // invalid_agent_token and the 429 temporarily_blocked lockout. Nothing below
  // re-implements auth, so the lockout behaviour cannot drift between routes.

  /** Anything that writes needs the panel toggle on. */
  async function requireAgentEnabled(res: Response): Promise<AgentSettings | null> {
    const settings = await services.agentSettings();
    if (!settings.enabled) {
      fail(res, 409, "agent_trading_disabled");
      return null;
    }
    return settings;
  }

  /** True when the floor has been reached — the caller must stop. */
  async function floorReached(settings: AgentSettings): Promise<boolean> {
    if (!settings.dailyLossFloorCents || settings.dailyLossFloorCents <= 0) return false;
    const today = await services.realizedTodayCents();
    return today <= -Math.abs(settings.dailyLossFloorCents);
  }

  function guard(handler: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response) => {
      handler(req, res).catch(() => {
        // Never leak a stack to a token holder, never answer 200 on a throw.
        if (!res.headersSent) fail(res, 500, "agent_internal_error");
      });
    };
  }

  /* ── READ ──────────────────────────────────────────────────────────────── */

  router.get(
    "/stats",
    guard(async (_req, res) => {
      const [balanceCents, positions] = await Promise.all([
        services.balanceCents(),
        services.positions(),
      ]);
      res.json({ connected: true, balanceCents, positions });
    }),
  );

  router.get(
    "/positions",
    guard(async (_req, res) => {
      res.json(await services.positions());
    }),
  );

  router.get(
    "/orders",
    guard(async (req, res) => {
      // The deck asks for ?status=open explicitly. Default to open anyway: a
      // full history returned where resting orders were expected looks like the
      // same answer with more rows in it.
      const status = req.query.status === "all" ? "all" : "open";
      res.json(await services.orders(status));
    }),
  );

  router.get(
    "/fills",
    guard(async (req, res) => {
      res.json(await services.fills(intParam(req.query.limit, 50)));
    }),
  );

  router.get(
    "/settlements",
    guard(async (req, res) => {
      res.json(await services.settlements(intParam(req.query.limit, 50)));
    }),
  );

  router.get(
    "/performance",
    guard(async (_req, res) => {
      res.json(await services.performance());
    }),
  );

  router.get(
    "/markets",
    guard(async (req, res) => {
      const category = typeof req.query.category === "string" ? req.query.category : undefined;
      res.json(await services.markets(category, intParam(req.query.limit, 50)));
    }),
  );

  router.get(
    "/market/:ticker",
    guard(async (req, res) => {
      res.json(await services.market(req.params.ticker));
    }),
  );

  router.get(
    "/orderbook/:ticker",
    guard(async (req, res) => {
      res.json(await services.orderbook(req.params.ticker));
    }),
  );

  router.get(
    "/bot/state",
    guard(async (_req, res) => {
      res.json(await services.botState());
    }),
  );

  /* ── CONTROL — needs the "Agent trading enabled" toggle ────────────────── */

  router.post(
    "/bot/engage",
    guard(async (req, res) => {
      const settings = await requireAgentEnabled(res);
      if (!settings) return;

      const category = (req.body ?? {}).category;
      if (typeof category !== "string" || !CATEGORIES.includes(category)) {
        fail(res, 400, "unknown_category");
        return;
      }
      // A1 step 3: the floor stops the bot being restarted into the same hole.
      if (await floorReached(settings)) {
        fail(res, 423, "daily_loss_floor_reached");
        return;
      }

      await services.engage(category);
      res.json(await services.botState());
    }),
  );

  router.post(
    "/bot/disengage",
    guard(async (_req, res) => {
      // DELIBERATELY NOT GATED on the toggle. Stopping must always be possible,
      // including when the toggle was flipped off while the bot was running.
      await services.disengage();
      res.json(await services.botState());
    }),
  );

  router.get(
    "/config",
    guard(async (_req, res) => {
      res.json(await services.getConfig());
    }),
  );

  router.patch(
    "/config",
    guard(async (req, res) => {
      const settings = await requireAgentEnabled(res);
      if (!settings) return;

      const patch = (req.body ?? {}) as Record<string, unknown>;
      const keys = Object.keys(patch);
      if (keys.length === 0) {
        fail(res, 400, "empty_config");
        return;
      }
      for (const k of keys) {
        if (!CONFIG_KEYS.includes(k)) {
          fail(res, 400, "unknown_config_key");
          return;
        }
      }
      res.json(await services.patchConfig(patch));
    }),
  );

  /* ── ORDER — needs the toggle AND AGENT_LIVE_TRADING_ENABLED ───────────── */

  router.post(
    "/order",
    guard(async (req, res) => {
      const settings = await requireAgentEnabled(res);
      if (!settings) return;

      if (!liveTradingEnabled()) {
        fail(res, 409, "live_trading_disabled");
        return;
      }

      const b = (req.body ?? {}) as Record<string, unknown>;

      // The idempotency key is checked FIRST — before validation, before the
      // floor, before the balance. A retry of an order that already landed must
      // be answered with that order no matter what the world looks like now.
      if (typeof b.clientOrderId !== "string" || b.clientOrderId.trim() === "") {
        fail(res, 400, "client_order_id_required");
        return;
      }
      const previous = store.get(b.clientOrderId);
      if (previous) {
        res.json({ ...previous, duplicate: true });
        return;
      }

      const order: OrderInput = {
        ticker: String(b.ticker ?? ""),
        side: b.side === "no" ? "no" : "yes",
        action: b.action === "sell" ? "sell" : "buy",
        count: Number(b.count),
        priceCents: Number(b.priceCents),
        clientOrderId: b.clientOrderId,
      };

      const shapeOk =
        order.ticker.trim() !== "" &&
        (b.side === "yes" || b.side === "no") &&
        (b.action === "buy" || b.action === "sell") &&
        Number.isInteger(order.count) &&
        order.count > 0 &&
        Number.isInteger(order.priceCents) &&
        order.priceCents >= 1 &&
        order.priceCents <= 99;
      if (!shapeOk) {
        fail(res, 400, "invalid_order");
        return;
      }

      const notionalCents = order.count * order.priceCents;
      if (notionalCents > Math.round(settings.maxOrderNotionalUsd * 100)) {
        fail(res, 422, "order_exceeds_max_notional");
        return;
      }

      if (await floorReached(settings)) {
        fail(res, 423, "daily_loss_floor_reached");
        return;
      }

      if (order.action === "buy" && notionalCents > (await services.balanceCents())) {
        fail(res, 422, "insufficient_balance");
        return;
      }

      const placed = await services.placeOrder(order);
      // Recorded only AFTER it lands. Recording before would answer a retry with
      // "duplicate" for an order that never actually existed.
      store.put(order.clientOrderId, placed);
      res.json(placed);
    }),
  );

  router.delete(
    "/order/:id",
    guard(async (req, res) => {
      // Cancelling only ever REDUCES exposure, so it is gated on the toggle but
      // not on live trading or the loss floor — the floor being hit is exactly
      // when pulling a resting order matters most.
      const settings = await requireAgentEnabled(res);
      if (!settings) return;
      res.json(await services.cancelOrder(req.params.id));
    }),
  );

  return router;
}
