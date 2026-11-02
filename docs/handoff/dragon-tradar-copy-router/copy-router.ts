/**
 * DRAGON TRADAR — COPY ROUTER (the leaderboard copy-trade lane).
 *
 * THIS FILE IS FOR CLASSIC'S REPLIT APP, NOT FOR THE DECK. It is the sibling of
 * `docs/handoff/dragon-tradar-agent-router/agent-router.ts` and follows the same
 * shape: an injected `CopyServices` interface so it guesses NOTHING about the
 * inside of his app, mounted behind the SAME Bearer middleware that already
 * guards `/api/agent/v1/stats`.
 *
 * It adds three routes under `/api/agent/v1`:
 *   POST /copy/scan     run one scan, return the plan. DRY RUN BY DEFAULT.
 *   GET  /copy/state    the last scan: counts, and rejections BY REASON.
 *   POST /copy/config   the signal config, validated field by field.
 *
 * ── WHAT IS VERIFIED, LINE BY LINE ───────────────────────────────────────────
 * Every endpoint below was probed live on 2026-10-04 by direct curl. These are
 * measurements, not documentation:
 *
 *   KALSHI SOCIAL — free, NO auth, NO key, and UNDOCUMENTED. The public
 *   consensus is that Kalshi has no leaderboard API. That consensus is wrong.
 *     GET https://api.elections.kalshi.com/v1/social/leaderboard
 *         ?metric_name=volume&limit=100
 *       -> 200 {"rank_list":[{nickname, social_id, profile_image_path, value,
 *                             rank, is_anonymous}]}
 *       * `metric_name` is REQUIRED and validated by a Go `oneof` tag. ONLY
 *         "volume" is accepted — profit, pnl, realized_pnl, roi, win_rate,
 *         trades, streak, notional and 13 others all return 400
 *         invalid_parameters. SO THE ONLY KALSHI RANKING THAT EXISTS IS BY
 *         VOLUME, NOT BY PROFIT. Volume is turnover, not skill: a market maker
 *         churning both sides of a book ranks #1 and may be flat on the year.
 *       * `limit` is REQUIRED. 50 -> 50 rows, 100 -> 100 rows, 200 or 500 ->
 *         error/empty. THE CAP IS 100.
 *       * `period`, `window`, `timeframe`, `category`, `series_ticker` are ALL
 *         IGNORED — identical rank 1 for every value. There is exactly ONE
 *         window and it is unlabelled.
 *     GET /v1/social/trades?nickname=<nick>&page_size=<n>
 *       -> 200 {"trades":[...],"visibility_state":"visible"|"hidden"}
 *       * `page_size` works. `limit` is IGNORED (always 100). `cursor` IGNORED.
 *       * row keys EXACTLY: trade_id, market_id, ticker, price (int cents),
 *         price_dollars (string), count (int), count_fp (string), taker_side,
 *         taker_action, maker_nickname, taker_nickname, create_date (ISO8601 Z).
 *         THERE IS NO `created_time` AND NO `ts`. The timestamp is `create_date`.
 *     404, do not use: /v1/social/positions, /social/posts, /social/activity,
 *       /social/feed, /social/shared_positions, /trade-api/v2/social/*,
 *       /trade-api/v2/leaderboard
 *
 *   POLYMARKET — free, no auth, re-verified 200 on 2026-10-04.
 *     GET https://lb-api.polymarket.com/profit?window=7d&limit=50
 *       ranked BY PROFIT. windows 1d/7d/30d/all. limit HARD-CAPPED at 50.
 *       Row: {proxyWallet, amount, pseudonym, name, bio}.
 *       LANDMINE: a default Python-urllib User-Agent gets 403 here. SEND A
 *       BROWSER USER-AGENT — `defaultFetchJson` below does.
 *     GET https://data-api.polymarket.com/activity?user=<proxyWallet>&limit=100
 *       `type` is TRADE | REDEEM | MAKER_REBATE | TAKER_REBATE. Filter to TRADE.
 *
 * ── THE MEASURED SCARCITY — say it out loud, never paper over it ─────────────
 * Of the TOP 100 Kalshi traders by volume, EXACTLY TWO have
 * `visibility_state == "visible"`:
 *     rank 67  "BitcoinTradingChallenge"  volume $1,110,684  100 trades readable
 *     rank 87  "szg.szg"                  volume   $865,901  100 trades readable
 * The other 98 return `{"trades":[],"visibility_state":"hidden"}`. Trade
 * visibility is OPT-IN on Kalshi. So Kalshi copy-trading has a universe of TWO
 * traders right now, and neither is in the top 50 by volume. `GET /copy/state`
 * reports that count every scan, because a lane that silently finds nothing and
 * a lane that is broken look identical otherwise.
 *
 * ── THE MAKER/TAKER LANDMINE — this is the money-losing bug ──────────────────
 * `taker_side` and `taker_action` describe THE COUNTERPARTY, not the trader you
 * asked about. Measured role split: BitcoinTradingChallenge maker 77 / taker 23;
 * szg.szg maker 91 / taker 9. COPYING THOSE FIELDS VERBATIM INVERTS THE
 * POSITION ON ROUGHLY 85% OF ROWS. `resolveRole` below is the fix and it is the
 * single most important function in this file.
 *
 * AND: a maker fill means they posted a RESTING limit and someone crossed to
 * them — they COLLECTED the spread. Mirroring that with a MARKET order PAYS the
 * spread, which is the opposite economics. Nothing here ever sends a market
 * order: every order carries `priceCents`, so what goes out is a LIMIT at the
 * same price, which is the faithful mirror of a maker fill.
 *
 * ── THE SECOND MONEY-LOSING BUG: `price` IS THE **YES** PRICE, ALWAYS ────────
 * The social feed publishes ONE price per row and it is the YES price, whatever
 * side anyone was on. MEASURED, not inferred: 41 rows of
 * BitcoinTradingChallenge's social tape were matched by `trade_id` against
 * `GET https://api.elections.kalshi.com/trade-api/v2/markets/trades`, which
 * publishes `yes_price` and `no_price` as SEPARATE fields.
 * `social.price === v2.yes_price` on **all 41 rows**, including every row whose
 * `taker_side` is "no". Example: trade 072529dc-5c51-8e7a-8f6d-0f39d2963f52
 * (KXWNBA3QTOTAL-26OCT04NYATL-45) is social `taker_side=no price=99`, while v2
 * reports `yes_price=99, no_price=1`. That NO side transacted at 1c, NOT 99c.
 * `sidePriceCents()` below is the fix, and the error it prevents runs BOTH ways:
 * a NO fill reported at 2c truly cost 98c (895 contracts is $877.10, not $17.90
 * — a $20 ceiling waving through 49x the whole $42.40 balance), and a NO fill
 * reported at 98c truly cost 2c.
 *
 * ── AND THE ASK HAS A SIDE TOO ───────────────────────────────────────────────
 * `ResolvedMarket` demands `yesAskCents` AND `noAskCents` by name instead of one
 * `askCents`, because the order this router sends carries `side: fill.side` and
 * that side is "no" on a real share of rows. One side-blind ask number lets an
 * implementer return the YES ask — the obvious thing to return, and what the
 * deck's own matcher reads (`yes_ask_dollars`, src/lib/copy-match.ts:102,141) —
 * and price every NO order on the wrong side of the book. Read the doc block on
 * `ResolvedMarket`: the NO ask is NOT 100 minus the YES ask.
 *
 * ── THE RULE THAT MATTERS MOST: 401/403 IS THE TOKEN, NOTHING ELSE ───────────
 * The deck maps 401 and 403 to "the token was rejected — go regenerate it." A
 * business refusal answered with 403 sends Classic off to rotate a healthy token
 * while the real cause stays hidden. Status codes here are chosen so every
 * refusal is distinguishable:
 *
 *   401  missing_agent_token, invalid_agent_token       the token, only
 *   429  temporarily_blocked                            throttle / lockout
 *   409  agent_trading_disabled, live_trading_disabled,
 *        copy_lane_disabled, copy_mode_not_accepted      a brake is off
 *   422  scan_budget_exhausted, insufficient_balance,
 *        order_exceeds_max_notional                      too large for the money
 *   423  daily_loss_floor_reached                        the floor
 *   400  invalid_copy_config, unknown_copy_config_key,
 *        empty_copy_config, invalid_scan_request         malformed
 *
 * Every error body is `{"error": "<code>"}`. The deck reads `.error` verbatim.
 *
 * ── EVERY REFUSAL IS NAMED ───────────────────────────────────────────────────
 * `resolveRole` returns a REASON, not a bare null, and so does every drop in the
 * scan. `GET /copy/state` counts them by reason. That is not tidiness: a tape
 * dropped for sub-contract size and a tape dropped because the nicknames never
 * match are different problems with the same symptom (zero accepted copies), and
 * one number called "ambiguous_role" would send Classic hunting the wrong one.
 *
 * ── NOT VERIFIED, STATED PLAINLY ─────────────────────────────────────────────
 * `/copy/scan` and `/copy/state` currently 404 on the live host (checked
 * 2026-10-04) because this file does not exist there yet. An Express POST-only
 * route ALSO answers a GET with "Cannot GET /api/...", so a 404 on GET is not
 * proof of absence for a write route — in either direction.
 *
 * THIS FILE HAS NEVER BEEN COMPILED OR RUN. `docs/handoff` is excluded from the
 * deck's tsconfig (tsconfig.json:44), it imports `express`, which the deck does
 * not depend on, and there is no test that exercises it. It was written and read
 * carefully; that is not the same as verified. The first `tsc` it ever sees will
 * be the one on his Replit.
 */
import { createHash } from "node:crypto";
import { Router, type Request, type Response } from "express";

/* ── THE SEAM ────────────────────────────────────────────────────────────────
 * Wire these to the code already serving /api/kalshi/* and /api/bot/*.
 * Nothing else in this file needs to change.
 * ──────────────────────────────────────────────────────────────────────────── */

export type Side = "yes" | "no";
export type Action = "buy" | "sell";
export type Role = "maker" | "taker";
export type Venue = "kalshi" | "polymarket";

/** Exactly the body the existing `POST /order` route takes. */
export type OrderInput = {
  ticker: string;
  side: Side;
  action: Action;
  count: number;
  priceCents: number;
  clientOrderId: string;
};

/** One fill, already resolved to what the OBSERVED TRADER actually did. */
export type TraderFill = {
  tradeId: string;
  venue: Venue;
  sourceTrader: string;
  /** Kalshi ticker as observed, or a Polymarket conditionId. */
  marketKey: string;
  side: Side;
  action: Action;
  priceCents: number;
  count: number;
  role: Role;
  observedAt: string;
};

/**
 * What a market has to look like before a signal may be mirrored onto it.
 *
 * ★★★ BOTH SIDES ARE REQUIRED BY NAME, AND THAT IS THE WHOLE POINT. The earlier
 * shape was one field, `askCents`, documented only as "the current ask in whole
 * cents, 1..99". But the order this router sends carries `side: fill.side`, and
 * that side is "no" on a real share of rows — 16 of 40 resolved fills on the
 * deck's live cross-check. A single side-blind ask number lets an implementer
 * return the YES ask, which is the obvious thing to return and is exactly what
 * the deck's own matcher reads (`yes_ask_dollars`, src/lib/copy-match.ts:102
 * and :141) — and then every NO order is priced on the wrong side of the book.
 * Naming both sides means that cannot happen by accident.
 *
 * ★ THE NO ASK IS **NOT** `100 - yesAskCents`. A completed TRADE has two sides
 * summing to 100c, which is why `sidePriceCents()` may complement a PRINT. A
 * BOOK does not work that way. Buying NO at n is the same trade as selling YES
 * at 100-n, so the cheapest NO you can lift is set by the best YES **BID**:
 *
 *     noAskCents  = 100 - yesBidCents
 *     yesAskCents = 100 - noBidCents
 *
 * Deriving the NO ask from the YES ask prices the order inside the spread, where
 * it rests unfilled, or straight through it. UNVERIFIED: whether the market
 * object this app already reads carries a NO ask field of its own. If it does,
 * READ IT — do not derive anything.
 *
 * Both numbers are WHOLE CENTS, not dollars. `yes_ask_dollars` is a dollar
 * string ("0.42"); multiply by 100 and round before putting it here.
 *
 * Pass `null` for a side the book is not quoting. An unquoted side is not a 0
 * and not a 100: a signal for it is rejected `missing_side_ask` rather than
 * priced against a number nobody is offering.
 */
export type ResolvedMarket = {
  /** The Kalshi ticker the order will actually be sent for. */
  ticker: string;
  /** Best ask to BUY YES, whole cents 1..99, or null if YES is not offered. */
  yesAskCents: number | null;
  /** Best ask to BUY NO, whole cents 1..99, or null if NO is not offered. */
  noAskCents: number | null;
};

/**
 * The ask for THE SIDE THE ORDER WILL ACTUALLY BE PLACED ON.
 *
 * Never falls back to the other side and never derives one from the other — see
 * the `ResolvedMarket` doc block for why a complement is wrong on a book. A
 * non-integer, out-of-band or missing quote returns null, and the caller rejects
 * the signal instead of pricing it.
 */
export function askForSide(market: ResolvedMarket, side: Side): number | null {
  const px = side === "yes" ? market.yesAskCents : market.noAskCents;
  if (typeof px !== "number" || !Number.isInteger(px)) return null;
  return px >= 1 && px <= 99 ? px : null;
}

export type CopyServices = {
  /** Reuse the SAME settings object `agent-router.ts` reads. Nothing here forks it. */
  agentSettings(): Promise<{
    enabled: boolean;
    maxOrderNotionalUsd: number;
    dailyLossFloorCents: number;
  }>;

  /** Reuse the existing bot state. This lane READS `mode`; it never sets it. */
  botState(): Promise<{ running: boolean; mode: string }>;

  balanceCents(): Promise<number>;

  /** Realized P&L in cents since midnight ET, signed, a loss negative. Same one A1 uses. */
  realizedTodayCents(): Promise<number>;

  /** How many copy positions are open right now. Counted from the existing positions service. */
  openCopyCount(): Promise<number>;

  /**
   * The one genuinely app-specific judgment: is there a Kalshi market that is
   * LIVE, TRADEABLE and the same bet as this fill, and what does it cost?
   * Return null for no match — never a guess.
   *
   * On the deck side this is `src/lib/copy-match.ts`. Reuse whatever already
   * serves `/api/kalshi/markets/live`; do NOT write a second Kalshi client.
   * NOTE: a game's clock is `occurrence_datetime`, NOT `close_time` —
   * `close_time` is the SETTLEMENT window and stays open after the final whistle.
   */
  resolveMarket(fill: TraderFill): Promise<ResolvedMarket | null>;

  /** The existing order service. Only ever called when the scan is NOT a dry run. */
  placeOrder(order: OrderInput): Promise<Record<string, unknown>>;

  loadCopyConfig(): Promise<Record<string, unknown>>;
  saveCopyConfig(config: CopyConfig): Promise<void>;
  loadCopyState(): Promise<StoredCopyState | null>;
  saveCopyState(state: StoredCopyState): Promise<void>;

  /**
   * Optional. Override to add caching or a rate limiter. The default sends a
   * browser User-Agent, which lb-api.polymarket.com REQUIRES — a default
   * urllib/node UA gets 403 there.
   */
  fetchJson?(url: string): Promise<unknown>;
};

export type CopyRouterOptions = {
  services: CopyServices;
  /** `process.env.AGENT_LIVE_TRADING_ENABLED === "true"`. Read per request, never cached. */
  liveTradingEnabled: () => boolean;
  /** `process.env.COPY_LANE_ENABLED === "true"`. Its own switch, off by default. */
  copyLaneEnabled: () => boolean;
  now?: () => number;
};

/* ── CONFIG ──────────────────────────────────────────────────────────────── */

export type CopyConfig = {
  /** Top N Kalshi traders by VOLUME to look at. Hard cap 100 — the API's own cap. */
  kalshiTraders: number;
  /** Top N Polymarket traders by PROFIT. Hard cap 50 — the API's own cap. */
  polymarketTraders: number;
  polymarketWindow: "1d" | "7d" | "30d" | "all";
  /** Rows per trader. Kalshi's `page_size`; Polymarket's `limit`. */
  tradesPerTrader: number;
  /** A fill older than this no longer describes this moment. */
  maxSignalAgeMinutes: number;
  /** Refuse decided books. 1c and 99c are outcomes, not prices. */
  minPriceCents: number;
  maxPriceCents: number;
  /** Contracts per copied order. */
  count: number;
  /** Notional ceiling for ONE order, in cents. */
  perOrderCents: number;
  /** Notional ceiling for the WHOLE scan, in cents. The cap that matters on a small balance. */
  perScanCents: number;
  /** Most copy positions open at once. */
  maxOpenCopies: number;
  /** Mirror maker fills as a resting LIMIT at the same price. See the header. */
  allowMakerFills: boolean;
  /** Bot modes this lane will trade under. Default paper only. */
  acceptModes: string[];
};

/**
 * Deliberately small. The balance measured on 2026-10-04 was 4240c and Dragon
 * Tradar's own `minBetCents` is 1000c, so the account is FOUR minimum-size bets
 * wide: a per-order cap alone cannot protect it, which is why `perScanCents`
 * exists and why it is 2000c (two $10 bets) rather than the $100 the deck
 * allows a hand-placed order.
 */
export const COPY_CONFIG_DEFAULTS: CopyConfig = {
  kalshiTraders: 100,
  polymarketTraders: 50,
  polymarketWindow: "7d",
  tradesPerTrader: 100,
  maxSignalAgeMinutes: 30,
  minPriceCents: 5,
  maxPriceCents: 90,
  count: 1,
  perOrderCents: 2_000,
  perScanCents: 2_000,
  maxOpenCopies: 4,
  allowMakerFills: true,
  acceptModes: ["paper"],
};

const WINDOWS = ["1d", "7d", "30d", "all"];

const INT_BOUNDS: Record<string, { min: number; max: number }> = {
  // 100 and 50 are the APIs' own caps, measured. Asking for more returns
  // error/empty, so accepting a larger number here would be accepting a lie.
  kalshiTraders: { min: 0, max: 100 },
  polymarketTraders: { min: 0, max: 50 },
  tradesPerTrader: { min: 1, max: 100 },
  maxSignalAgeMinutes: { min: 1, max: 1_440 },
  minPriceCents: { min: 1, max: 99 },
  maxPriceCents: { min: 1, max: 99 },
  count: { min: 1, max: 10_000 },
  perOrderCents: { min: 1, max: 1_000_000 },
  perScanCents: { min: 1, max: 1_000_000 },
  maxOpenCopies: { min: 0, max: 1_000 },
};

export type ConfigRejection =
  | "empty_copy_config"
  | "unknown_copy_config_key"
  | "invalid_copy_config";

/**
 * Validate a config patch field by field. An empty patch is REJECTED: a no-op
 * answered 200 is how "I changed it" becomes a lie on a money surface.
 */
export function validateCopyConfig(
  current: CopyConfig,
  patch: Record<string, unknown>,
): { ok: true; config: CopyConfig } | { ok: false; code: ConfigRejection } {
  const keys = Object.keys(patch);
  if (keys.length === 0) return { ok: false, code: "empty_copy_config" };

  const next: CopyConfig = { ...current };
  for (const k of keys) {
    const v = patch[k];
    if (k in INT_BOUNDS) {
      const b = INT_BOUNDS[k];
      if (typeof v !== "number" || !Number.isInteger(v) || v < b.min || v > b.max) {
        return { ok: false, code: "invalid_copy_config" };
      }
      (next as unknown as Record<string, number>)[k] = v;
    } else if (k === "allowMakerFills") {
      if (typeof v !== "boolean") return { ok: false, code: "invalid_copy_config" };
      next.allowMakerFills = v;
    } else if (k === "polymarketWindow") {
      if (typeof v !== "string" || !WINDOWS.includes(v)) {
        return { ok: false, code: "invalid_copy_config" };
      }
      next.polymarketWindow = v as CopyConfig["polymarketWindow"];
    } else if (k === "acceptModes") {
      if (!Array.isArray(v) || v.length === 0 || v.some((m) => typeof m !== "string" || m === "")) {
        return { ok: false, code: "invalid_copy_config" };
      }
      next.acceptModes = v as string[];
    } else {
      return { ok: false, code: "unknown_copy_config_key" };
    }
  }
  if (next.minPriceCents > next.maxPriceCents) return { ok: false, code: "invalid_copy_config" };
  return { ok: true, config: next };
}

export function mergeCopyConfig(stored: Record<string, unknown>): CopyConfig {
  const v = validateCopyConfig(COPY_CONFIG_DEFAULTS, stored);
  // A stored value that no longer validates must not take the lane down: fall
  // back to the defaults and let /copy/state show what is actually in force.
  return v.ok ? v.config : COPY_CONFIG_DEFAULTS;
}

/* ── REJECTIONS ──────────────────────────────────────────────────────────── */

/**
 * Why ONE tape row could not be turned into a fill we are willing to copy.
 *
 * Each of these is a separate fact, counted separately on `GET /copy/state`.
 * Collapsing them into one "unresolved" number is how a lane that is dropping
 * every row for sub-contract size gets debugged as a nickname-matching problem.
 * `resolveFill` on the deck (src/lib/kalshi-social.ts:399) makes exactly these
 * refusals; it just reports them all as a single null.
 */
export type FillRejection =
  /** Neither nickname on the row is the trader asked about. Ordinary: the
   *  counterparty's nickname is "" on anonymised rows. */
  | "ambiguous_role"
  /** BOTH nicknames are this trader, so the two legs cancel and there is no
   *  "what they did" to mirror. The role is undecidable, not guessable. */
  | "self_trade"
  /** taker_side / taker_action is not one of the four values the feed is
   *  documented to send. Coercing an unknown value to yes/buy would invent a
   *  position on a side nobody traded. */
  | "unusable_side"
  /** No orderable 1..99c price, on either `price` or `price_dollars`, or its
   *  side complement lands on 0/100. A 0 or 100 print is an outcome, not a
   *  price a mirror order could be placed at. */
  | "unusable_price"
  /** Under one whole contract. Kalshi DOES print sub-contract fills (a measured
   *  100-row tape had count 0 / count_fp "0.10") and no whole-contract order
   *  mirrors one. Rounding up would invent size. */
  | "unusable_count"
  /** trade_id is empty. It cannot be de-duplicated, and MINTING an id would
   *  make the same fill read as a brand-new signal on the next scan — which is
   *  a second position on the same bet. */
  | "missing_trade_id"
  /** The ticker/market key is empty, so there is nothing to match against. */
  | "missing_market_key"
  /** create_date does not parse, or is in the future. Both make the staleness
   *  gate meaningless: Date.parse returns NaN and every comparison against NaN
   *  is false, so a fill of unknown age would sail through as fresh. */
  | "unusable_timestamp";

export type CopyRejection =
  | FillRejection
  | "trades_hidden"
  | "stale_signal"
  | "no_kalshi_match"
  /** The matched market is not quoting the side the order would be placed on.
   *  A different fact from a quote that is merely out of band. */
  | "missing_side_ask"
  | "price_out_of_band"
  | "below_min_count"
  | "maker_fill_unmirrorable"
  | "duplicate_intent"
  | "exceeds_per_order_cap"
  | "exceeds_scan_budget"
  | "max_open_copies"
  | "leaderboard_unreachable";

export type Rejected = { reason: CopyRejection; detail: string };

export type PlannedCopy = {
  order: OrderInput;
  notionalCents: number;
  venue: Venue;
  sourceTrader: string;
  role: Role;
  /** Cross-scan identity, stored so the next scan will not fire the same bet again. */
  intentKey: string;
  why: string;
};

export type StoredCopyState = {
  scannedAt: string;
  dryRun: boolean;
  mode: string;
  checked: {
    kalshiTradersRead: number;
    kalshiVisible: number;
    polymarketTradersRead: number;
    fillsConsidered: number;
  };
  accepted: PlannedCopy[];
  committedCents: number;
  /** Counts BY REASON, so a zero-result scan is always explainable. */
  rejectedByReason: Record<string, number>;
  rejected: Rejected[];
  sent: Array<{ clientOrderId: string; result: Record<string, unknown> }>;
  /** `intentKey`s acted on, so a signal fires once. */
  acted: string[];
};

/* ── THE PUBLIC FEEDS ────────────────────────────────────────────────────── */

export const KALSHI_SOCIAL_BASE = "https://api.elections.kalshi.com/v1/social";
export const POLY_LB_BASE = "https://lb-api.polymarket.com";
export const POLY_DATA_BASE = "https://data-api.polymarket.com";

/** lb-api.polymarket.com 403s a default UA. Measured, not guessed. */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function defaultFetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

export type KalshiLeaderRow = { nickname: string; value: number; rank: number; is_anonymous: boolean };

/**
 * Row keys EXACTLY as measured. There is no `created_time` and no `ts`.
 *
 * ★ `taker_side` and `taker_action` are typed `string`, NOT `Side`/`Action`, on
 *   purpose. They hold whatever the feed sent, unvalidated. Narrowing them at
 *   parse time means coercing an unrecognised value into "yes"/"buy", which is
 *   how a garbled row becomes a confident position on a side nobody traded.
 *   `resolveRole()` is the only place they are validated and narrowed.
 *
 * ★ `price` is the **YES** price of the print whatever side anyone was on, and
 *   `price_dollars` is its string dollar form, kept as the fallback source.
 *   See `sidePriceCents()` before using either for anything.
 *
 * ★ `count_fp` is the fractional truth and `count` is the server's own floor of
 *   it — measured identical on all 100 rows of one live tape. Kept because a row
 *   with `count: 0 / count_fp: "0.10"` is a real sub-contract fill.
 */
export type KalshiSocialTrade = {
  trade_id: string;
  ticker: string;
  price: number;
  price_dollars: string;
  count: number;
  count_fp: string;
  taker_side: string;
  taker_action: string;
  maker_nickname: string;
  taker_nickname: string;
  create_date: string;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * The ONLY Kalshi ranking that exists: by VOLUME. `metric_name` is a Go `oneof`
 * and every profit-shaped value returns 400. Volume is turnover, not skill.
 */
export async function fetchKalshiLeaderboard(
  limit: number,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<KalshiLeaderRow[]> {
  const capped = Math.max(1, Math.min(100, limit));
  const raw = await fetchJson(`${KALSHI_SOCIAL_BASE}/leaderboard?metric_name=volume&limit=${capped}`);
  return asArray(asRecord(raw).rank_list).map((r) => {
    const o = asRecord(r);
    return {
      nickname: String(o.nickname ?? ""),
      value: typeof o.value === "number" ? o.value : 0,
      rank: typeof o.rank === "number" ? o.rank : 0,
      is_anonymous: o.is_anonymous === true,
    };
  });
}

/** `page_size` is the knob that works. `limit` is ignored and `cursor` is ignored. */
export async function fetchKalshiTrades(
  nickname: string,
  pageSize: number,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<{ trades: KalshiSocialTrade[]; visible: boolean }> {
  const raw = asRecord(
    await fetchJson(
      `${KALSHI_SOCIAL_BASE}/trades?nickname=${encodeURIComponent(nickname)}&page_size=${Math.max(1, Math.min(100, pageSize))}`,
    ),
  );
  // Mapping ONLY — snake_case in, snake_case out, nothing interpreted and
  // nothing coerced. A missing `price` becomes NaN rather than 0, because 0 is a
  // real-looking cent value that would read as a free contract; NaN is rejected
  // by yesPriceCentsOf(). Same for `count`.
  const trades = asArray(raw.trades).map((t): KalshiSocialTrade => {
    const o = asRecord(t);
    return {
      trade_id: String(o.trade_id ?? ""),
      ticker: String(o.ticker ?? ""),
      price: typeof o.price === "number" ? o.price : Number.NaN,
      price_dollars: String(o.price_dollars ?? ""),
      count: typeof o.count === "number" ? o.count : Number.NaN,
      count_fp: String(o.count_fp ?? ""),
      taker_side: String(o.taker_side ?? ""),
      taker_action: String(o.taker_action ?? ""),
      maker_nickname: String(o.maker_nickname ?? ""),
      taker_nickname: String(o.taker_nickname ?? ""),
      create_date: String(o.create_date ?? ""),
    };
  });
  return { trades, visible: raw.visibility_state === "visible" };
}

/* ── UNIT HELPERS ─ what a side cost, and whole contracts ──────────────── */

function flipAction(action: Action): Action {
  return action === "buy" ? "sell" : "buy";
}

/**
 * A string field, trimmed, from a value that is only CLAIMED to be a string.
 *
 * `fetchKalshiTrades` already guarantees strings, but `resolveRole` is EXPORTED
 * and whoever wires this on Replit may hand it a row built by hand or cast from
 * a different client. `undefined.trim()` would throw, the scan would answer 500
 * agent_internal_error, and the real cause (one missing field on one row) would
 * be invisible. This makes the function total: a missing field becomes "" and
 * takes the named rejection that already exists for it.
 */
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * ★★★ THE SECOND MONEY-LOSING BUG, FIXED IN ONE FUNCTION: what the OBSERVED
 * TRADER's side actually cost, in whole cents.
 *
 * The Kalshi social feed publishes ONE price per row and it is the **YES** price,
 * whatever side anyone was on. It is NOT what the observed trader paid unless
 * their resolved side is also "yes".
 *
 * MEASURED, not inferred. 41 rows of BitcoinTradingChallenge's social tape were
 * matched by `trade_id` against
 * `GET https://api.elections.kalshi.com/trade-api/v2/markets/trades`, which
 * publishes `yes_price` and `no_price` as SEPARATE fields.
 * `social.price === v2.yes_price` on **all 41 rows**, including every row whose
 * `taker_side` is "no". The worked example: trade
 * 072529dc-5c51-8e7a-8f6d-0f39d2963f52 (KXWNBA3QTOTAL-26OCT04NYATL-45) is social
 * `taker_side=no price=99`, while v2 reports `yes_price=99, no_price=1`. That NO
 * side transacted at 1c, NOT 99c. After the same fix shipped on the deck it was
 * re-verified live: 40 resolved fills cross-checked against v2 per-side prices,
 * 40 correct and 0 wrong, 16 of them side "no".
 *
 * THE ERROR RUNS BOTH WAYS AND BOTH WAYS COST MONEY:
 *   - A NO fill reported at 2c truly cost 98c. At 895 contracts that is $877.10,
 *     not $17.90 — so a $20 per-scan ceiling waves through a commitment 49x
 *     larger than his entire $42.40 balance.
 *   - A NO fill reported at 98c truly cost 2c, so a mirror limit placed at 98c
 *     sits 49x above the market and sweeps every ask between.
 *
 * A binary market's two sides sum to 100c, so the NO price is the complement.
 * A complement landing on 0 or 100 is not an orderable price, so it is REJECTED
 * rather than clamped into a price that was never seen.
 *
 * ★ THIS IS A LOCAL COPY of the deck's `sidePriceCents`
 *   (src/lib/kalshi-social.ts:334), duplicated ON PURPOSE: this file is
 *   standalone for his Replit and must not import deck code. If either one is
 *   ever changed, change both.
 *
 * ★ IT APPLIES TO A PRINT, NOT TO A BOOK. Do not reuse it to derive the NO ask
 *   from the YES ask — see the `ResolvedMarket` doc block.
 */
export function sidePriceCents(yesPriceCents: number, side: Side): number | null {
  if (!Number.isFinite(yesPriceCents)) return null;
  const yes = Math.round(yesPriceCents);
  if (yes < 1 || yes > 99) return null;
  const px = side === "yes" ? yes : 100 - yes;
  return px >= 1 && px <= 99 ? px : null;
}

/**
 * The print's YES price in whole cents, or null.
 *
 * Kalshi contracts print between 1c and 99c. A 0 or 100 print is an outcome, not
 * a price a mirror order could be placed at, so it is REJECTED rather than
 * clamped into something we never saw. `price` is preferred; `price_dollars` is
 * the fallback for a row where `price` is missing or unusable.
 */
function yesPriceCentsOf(row: KalshiSocialTrade): number | null {
  const direct = Number.isFinite(row.price) ? Math.round(row.price) : null;
  if (direct !== null && direct >= 1 && direct <= 99) return direct;
  const raw = str(row.price_dollars);
  const dollars = Number(raw);
  if (raw !== "" && Number.isFinite(dollars)) {
    const cents = Math.round(dollars * 100);
    if (cents >= 1 && cents <= 99) return cents;
  }
  return null;
}

/**
 * Whole contracts, floored — a fractional mirror cannot be sent.
 *
 * Kalshi DOES print sub-contract fills: one row of a measured 100-row tape was
 * `count: 0 / count_fp: "0.10"`, and it is the single rejection out of those 100.
 * There is no whole-contract order that mirrors a 0.10-contract fill, so it is
 * rejected. Rounding UP would invent size on a money path.
 */
function wholeCountOf(row: KalshiSocialTrade): number | null {
  const direct = Number.isFinite(row.count) ? Math.floor(row.count) : null;
  if (direct !== null && direct >= 1) return direct;
  const raw = str(row.count_fp);
  const fp = Number(raw);
  if (raw !== "" && Number.isFinite(fp)) {
    const floored = Math.floor(fp);
    if (floored >= 1) return floored;
  }
  return null;
}

/* ── ROLE + PRICE RESOLUTION ─────────────────────────────────── */

/**
 * The answer, or the NAMED reason there isn't one. Never a bare null: a lane
 * dropping every row because the counts are sub-contract and a lane dropping
 * every row because the nicknames never match look identical from the outside,
 * and `GET /copy/state` is what has to tell them apart.
 */
export type RoleResult =
  | { ok: true; fill: TraderFill }
  | { ok: false; reason: FillRejection; detail: string };

/**
 * ★★★ THE MOST IMPORTANT FUNCTION IN THIS FILE. It stands between a copied
 * signal and an inverted, mis-priced position, so it FAILS CLOSED: anything it
 * cannot prove is refused with a reason, and nothing is ever guessed.
 *
 * Two corrections happen here and nowhere else.
 *
 * 1. THE ROLE INVERSION. Kalshi's row reports the TAKER's side and action no
 *    matter which side our trader stood on:
 *
 *      maker_nickname === nickname  → our trader was the MAKER.
 *          side   = taker_side        (PRESERVED)
 *          action = OPPOSITE of taker_action
 *        Why, spelled out because it is easy to get backwards: a trade moves
 *        contracts between two parties. If the taker SELLS NO, those NO
 *        contracts land with the maker, so the maker BOUGHT NO. The contract
 *        type (the side) is the same object for both parties; only the direction
 *        of the transfer differs. Side stays, action flips.
 *
 *      taker_nickname === nickname  → our trader was the TAKER. Both verbatim.
 *
 *      neither matches → `ambiguous_role`. On anonymised rows the other party's
 *        nickname is "", so this case is common and ordinary.
 *
 *      both match → `self_trade`. The two legs cancel; there is no "what they
 *        did" to copy, and the role is undecidable.
 *
 *    Measured role split for the only two visible top-100 traders: maker 77/100
 *    and 91/100. Copying the taker fields verbatim inverts the position on
 *    roughly 85% of rows.
 *
 * 2. THE YES-PRICE CORRECTION. `row.price` is the YES price whatever side anyone
 *    was on, so the trader's own cost is `sidePriceCents(price, side)`. See that
 *    function — it is the 49x notional bug.
 *
 * Matching is EXACT, never case-insensitive. Kalshi nickname case-sensitivity is
 * UNVERIFIED, and a loose match could bind two distinct accounts: a missed match
 * costs one skipped signal, a wrong match costs a wrong position.
 *
 * NOT DECIDED HERE: whether a maker fill is worth copying at all. This function
 * reports the truth of the fill; `maker_fill_unmirrorable` in the scan is where
 * the caller may refuse it.
 */
export function resolveRole(row: KalshiSocialTrade, nickname: string): RoleResult {
  const nick = typeof nickname === "string" ? nickname.trim() : "";
  if (nick === "") {
    return {
      ok: false,
      reason: "ambiguous_role",
      detail: "no nickname was asked about, so no role can be assigned to this row",
    };
  }
  const id = str(row.trade_id) || "<no trade_id>";

  const isMaker = str(row.maker_nickname) === nick;
  const isTaker = str(row.taker_nickname) === nick;
  if (isMaker && isTaker) {
    return {
      ok: false,
      reason: "self_trade",
      detail: `trade ${id}: ${nick} is both maker and taker, so the legs cancel and the role is undecidable`,
    };
  }
  if (!isMaker && !isTaker) {
    return {
      ok: false,
      reason: "ambiguous_role",
      detail: `trade ${id}: neither maker_nickname nor taker_nickname is ${nick}, so the side cannot be resolved`,
    };
  }

  // The feed's side/action arrive RAW and are validated HERE. Coercing an
  // unrecognised value to "yes"/"buy" at parse time — which this file used to do
  // — turns a garbled row into a confident position on a side nobody traded.
  const rawSide = str(row.taker_side).toLowerCase();
  if (rawSide !== "yes" && rawSide !== "no") {
    return {
      ok: false,
      reason: "unusable_side",
      detail: `trade ${id}: taker_side ${JSON.stringify(row.taker_side)} is neither "yes" nor "no"`,
    };
  }
  const rawAction = str(row.taker_action).toLowerCase();
  if (rawAction !== "buy" && rawAction !== "sell") {
    return {
      ok: false,
      reason: "unusable_side",
      detail: `trade ${id}: taker_action ${JSON.stringify(row.taker_action)} is neither "buy" nor "sell"`,
    };
  }
  const takerSide: Side = rawSide;
  const takerAction: Action = rawAction;

  // An empty trade_id cannot be de-duplicated, and MINTING one would make the
  // same fill read as a brand-new signal on the next scan — a second position on
  // a bet already held. Refuse instead of inventing identity.
  const tradeId = str(row.trade_id);
  if (tradeId === "") {
    return {
      ok: false,
      reason: "missing_trade_id",
      detail: `${nick} ${str(row.ticker) || "<no ticker>"}: trade_id is empty, so this fill cannot be de-duplicated`,
    };
  }

  const marketKey = str(row.ticker);
  if (marketKey === "") {
    return {
      ok: false,
      reason: "missing_market_key",
      detail: `trade ${tradeId}: ticker is empty, so there is no market to match against`,
    };
  }

  // An unparseable timestamp makes the staleness gate meaningless: Date.parse
  // returns NaN and every comparison against NaN is false, so a fill of unknown
  // age would sail through as if it were seconds old. A timestamp in the FUTURE
  // does the same thing by arithmetic — a negative age is under every ceiling.
  const observedAt = str(row.create_date);
  const observedMs = Date.parse(observedAt);
  if (observedAt === "" || !Number.isFinite(observedMs)) {
    return {
      ok: false,
      reason: "unusable_timestamp",
      detail: `trade ${tradeId}: create_date ${JSON.stringify(row.create_date)} does not parse, so its age is unknown`,
    };
  }

  // ★ The feed's price is the YES price regardless of side; convert it to what
  //   THIS trader's side cost. See sidePriceCents() — this is the 49x bug.
  const yesPriceCents = yesPriceCentsOf(row);
  if (yesPriceCents === null) {
    return {
      ok: false,
      reason: "unusable_price",
      detail: `trade ${tradeId}: price ${String(row.price)} / price_dollars ${JSON.stringify(row.price_dollars)} is not an orderable 1..99c print`,
    };
  }
  const priceCents = sidePriceCents(yesPriceCents, takerSide);
  if (priceCents === null) {
    // Unreachable while yesPriceCentsOf() enforces 1..99 — kept so the guard
    // survives a change to either function rather than failing open.
    return {
      ok: false,
      reason: "unusable_price",
      detail: `trade ${tradeId}: yes price ${yesPriceCents}c has no orderable ${takerSide} complement`,
    };
  }

  const count = wholeCountOf(row);
  if (count === null) {
    return {
      ok: false,
      reason: "unusable_count",
      detail: `trade ${tradeId}: count ${String(row.count)} / count_fp ${JSON.stringify(row.count_fp)} is under one whole contract`,
    };
  }

  const role: Role = isMaker ? "maker" : "taker";
  return {
    ok: true,
    fill: {
      tradeId,
      venue: "kalshi",
      sourceTrader: nick,
      marketKey,
      side: takerSide, // preserved in BOTH roles — see the accounting above
      action: role === "maker" ? flipAction(takerAction) : takerAction,
      priceCents, // THEIR side's cost, not the YES print
      count,
      role,
      observedAt,
    },
  };
}

export type PolyLeaderRow = { proxyWallet: string; pseudonym: string; amount: number };

/** Ranked BY PROFIT. `limit` is hard-capped at 50 by the API itself. */
export async function fetchPolyLeaderboard(
  window: string,
  limit: number,
  fetchJson: (url: string) => Promise<unknown>,
): Promise<PolyLeaderRow[]> {
  const capped = Math.max(1, Math.min(50, limit));
  const raw = await fetchJson(`${POLY_LB_BASE}/profit?window=${encodeURIComponent(window)}&limit=${capped}`);
  return asArray(raw).map((r) => {
    const o = asRecord(r);
    return {
      proxyWallet: String(o.proxyWallet ?? ""),
      pseudonym: String(o.pseudonym ?? o.name ?? ""),
      amount: typeof o.amount === "number" ? o.amount : 0,
    };
  });
}

/**
 * Polymarket activity, filtered to `type === "TRADE"`.
 *
 * REDEEM, MAKER_REBATE and TAKER_REBATE are not trades and must not become
 * signals. Polymarket has no maker/taker field on this feed, so every fill is
 * recorded `role: "taker"` — the CONSERVATIVE reading, because it is the one
 * that assumes we must pay the spread.
 *
 * SAME REJECTIONS AS THE KALSHI PATH, and for the same reasons. This used to
 * `continue` silently on a bad price and substitute `new Date(0)` for a missing
 * timestamp — a 1970 fill that happens to be caught by the staleness gate by
 * accident, labelled nothing. Every drop here is now named and counted, so a
 * Polymarket lane that reads 50 wallets and produces nothing says WHY.
 *
 * ★ ONE DIFFERENCE FROM KALSHI, AND IT IS DELIBERATE: no side complement is
 *   applied. Polymarket prices the TOKEN that was traded, so a row's `outcome`
 *   and its `price` describe the same leg, whereas Kalshi's social tape reports
 *   only the YES price. UNVERIFIED: there is no Polymarket equivalent of the
 *   41-row `trade_id` cross-check behind `sidePriceCents()`. If a NO-outcome row
 *   is ever found carrying the complement, THIS is the line to fix.
 *
 * ★ `side` here is a NORMALISATION, not a match. A Polymarket SPREAD bet arrives
 *   as outcome "Patriots" on slug "nfl-ne-buf-2026-10-04-spread-home-6pt5" and
 *   becomes side "yes" — which is correct for the token, and says NOTHING about
 *   which Kalshi market is the same bet. Refusing the moneyline that merely
 *   shares the team name is `resolveMarket`'s job (the deck's equivalent is
 *   `matchOutcomeGuarded` in src/lib/copy-match.ts).
 */
export async function fetchPolyTrades(
  wallet: string,
  pseudonym: string,
  limit: number,
  fetchJson: (url: string) => Promise<unknown>,
  rejected?: Rejected[],
): Promise<TraderFill[]> {
  const raw = await fetchJson(
    `${POLY_DATA_BASE}/activity?user=${encodeURIComponent(wallet)}&limit=${Math.max(1, Math.min(500, limit))}`,
  );
  const who = pseudonym || wallet;
  const drop = (reason: FillRejection, detail: string): void => {
    rejected?.push({ reason, detail: `polymarket ${who}: ${detail}` });
  };

  const out: TraderFill[] = [];
  for (const r of asArray(raw)) {
    const o = asRecord(r);
    if (o.type !== "TRADE") continue; // not a trade at all — not a drop, a filter

    // No id means no de-duplication, and minting one re-fires the same bet.
    const tradeId = String(o.transactionHash ?? o.id ?? "").trim();
    if (tradeId === "") {
      drop("missing_trade_id", "a TRADE row carries neither transactionHash nor id");
      continue;
    }

    const marketKey = String(o.conditionId ?? o.slug ?? "").trim();
    if (marketKey === "") {
      drop("missing_market_key", `trade ${tradeId}: no conditionId and no slug`);
      continue;
    }

    const seconds = typeof o.timestamp === "number" ? o.timestamp : Number(o.timestamp ?? Number.NaN);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      drop("unusable_timestamp", `trade ${tradeId}: timestamp ${String(o.timestamp)} is unusable, so its age is unknown`);
      continue;
    }

    // Polymarket quotes DOLLARS 0..1. 1..99c is the orderable band on Kalshi, so
    // a 0.995 fill has no mirror a limit order could be placed at.
    const priceDollars = typeof o.price === "number" ? o.price : Number(o.price ?? Number.NaN);
    if (!Number.isFinite(priceDollars)) {
      drop("unusable_price", `trade ${tradeId}: price ${String(o.price)} is not a number`);
      continue;
    }
    const priceCents = Math.round(priceDollars * 100);
    if (priceCents < 1 || priceCents > 99) {
      drop("unusable_price", `trade ${tradeId}: ${priceCents}c is outside the orderable 1..99c band`);
      continue;
    }

    const sizeRaw = typeof o.size === "number" ? o.size : Number(o.size ?? Number.NaN);
    const count = Number.isFinite(sizeRaw) ? Math.floor(sizeRaw) : 0;
    if (count < 1) {
      drop("unusable_count", `trade ${tradeId}: size ${String(o.size)} is under one whole contract`);
      continue;
    }

    out.push({
      tradeId,
      venue: "polymarket",
      sourceTrader: who,
      marketKey,
      side: String(o.outcome ?? "").trim().toLowerCase() === "no" ? "no" : "yes",
      action: String(o.side ?? "").trim().toUpperCase() === "SELL" ? "sell" : "buy",
      priceCents,
      count,
      role: "taker",
      observedAt: new Date(seconds * 1000).toISOString(),
    });
  }
  return out;
}

/* ── IDENTITY ────────────────────────────────────────────────────────────── */

/**
 * The SAME canonical string and the same hash as the deck's
 * `newClientOrderId` (src/lib/dragon-orders.ts:80-91). Keeping them identical
 * is not cosmetic: it means a copy the deck fires and a copy this lane fires for
 * the same intent in the same second carry the SAME id, so the existing
 * `POST /order` idempotency store catches a double-fire across BOTH callers.
 */
export function newClientOrderId(order: Omit<OrderInput, "clientOrderId">, nowMs: number): string {
  const canonical = [
    order.ticker,
    order.side,
    order.action,
    order.count,
    order.priceCents,
    Math.floor(nowMs / 1000),
  ].join("|");
  return `starra-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/** Cross-scan identity: who, where, which market, which direction. Not price, not size. */
export function intentKey(fill: TraderFill, ticker: string): string {
  return [fill.venue, fill.sourceTrader, ticker, fill.side, fill.action].join("|");
}

/* ── THE ROUTER ──────────────────────────────────────────────────────────── */

function fail(res: Response, status: number, error: string): void {
  res.status(status).json({ error });
}

export function createCopyRouter(opts: CopyRouterOptions): Router {
  const { services, liveTradingEnabled, copyLaneEnabled } = opts;
  const now = opts.now ?? (() => Date.now());
  const fetchJson = services.fetchJson ?? defaultFetchJson;
  const router = Router();

  // NOTE: mount this router BEHIND the same Bearer middleware that already
  // guards /api/agent/v1/stats. That middleware owns 401 missing_agent_token /
  // invalid_agent_token and the 429 temporarily_blocked lockout. Nothing below
  // re-implements auth, so the lockout behaviour cannot drift between routes.

  function guard(handler: (req: Request, res: Response) => Promise<void>) {
    return (req: Request, res: Response) => {
      handler(req, res).catch(() => {
        if (!res.headersSent) fail(res, 500, "agent_internal_error");
      });
    };
  }

  /** Collect every fill both venues will admit to, naming every drop. */
  async function collectFills(
    cfg: CopyConfig,
    rejected: Rejected[],
  ): Promise<{
    fills: TraderFill[];
    kalshiTradersRead: number;
    kalshiVisible: number;
    polymarketTradersRead: number;
  }> {
    const fills: TraderFill[] = [];
    let kalshiTradersRead = 0;
    let kalshiVisible = 0;
    let polymarketTradersRead = 0;

    if (cfg.kalshiTraders > 0) {
      let board: KalshiLeaderRow[] = [];
      try {
        board = await fetchKalshiLeaderboard(cfg.kalshiTraders, fetchJson);
      } catch (e) {
        rejected.push({ reason: "leaderboard_unreachable", detail: `kalshi social leaderboard: ${String(e)}` });
      }
      for (const row of board.slice(0, cfg.kalshiTraders)) {
        if (!row.nickname || row.is_anonymous) continue;
        kalshiTradersRead += 1;
        try {
          const { trades, visible } = await fetchKalshiTrades(row.nickname, cfg.tradesPerTrader, fetchJson);
          if (!visible) {
            // EXPECTED, not an error: 98 of the top 100 are hidden. Visibility
            // is opt-in on Kalshi.
            rejected.push({ reason: "trades_hidden", detail: `rank ${row.rank} ${row.nickname} has trades hidden` });
            continue;
          }
          kalshiVisible += 1;
          for (const t of trades) {
            // Every refusal carries its OWN reason — see RoleResult. A single
            // "ambiguous_role" count would hide five other causes behind the
            // one that is merely the most common.
            const resolved = resolveRole(t, row.nickname);
            if (!resolved.ok) {
              rejected.push({ reason: resolved.reason, detail: `kalshi ${row.nickname}: ${resolved.detail}` });
              continue;
            }
            fills.push(resolved.fill);
          }
        } catch (e) {
          rejected.push({ reason: "leaderboard_unreachable", detail: `kalshi trades ${row.nickname}: ${String(e)}` });
        }
      }
    }

    if (cfg.polymarketTraders > 0) {
      let board: PolyLeaderRow[] = [];
      try {
        board = await fetchPolyLeaderboard(cfg.polymarketWindow, cfg.polymarketTraders, fetchJson);
      } catch (e) {
        rejected.push({ reason: "leaderboard_unreachable", detail: `polymarket profit board: ${String(e)}` });
      }
      for (const row of board.slice(0, cfg.polymarketTraders)) {
        if (!row.proxyWallet) continue;
        polymarketTradersRead += 1;
        try {
          const got = await fetchPolyTrades(row.proxyWallet, row.pseudonym, cfg.tradesPerTrader, fetchJson, rejected);
          for (const f of got) fills.push(f);
        } catch (e) {
          rejected.push({ reason: "leaderboard_unreachable", detail: `polymarket activity ${row.proxyWallet}: ${String(e)}` });
        }
      }
    }

    return { fills, kalshiTradersRead, kalshiVisible, polymarketTradersRead };
  }

  /**
   * POST /copy/scan — one scan.
   *
   * DRY RUN BY DEFAULT. `{"live": true}` in the body is the ONLY way an order is
   * placed, and it still has to get past the agent toggle, the copy-lane switch,
   * AGENT_LIVE_TRADING_ENABLED, the bot mode allow-list and the daily loss
   * floor. Reading the leaderboards costs nothing and touches no money, so a
   * dry scan is always allowed.
   */
  router.post(
    "/copy/scan",
    guard(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.live !== undefined && typeof body.live !== "boolean") {
        fail(res, 400, "invalid_scan_request");
        return;
      }
      const wantsLive = body.live === true;

      if (!copyLaneEnabled()) {
        fail(res, 409, "copy_lane_disabled");
        return;
      }

      const cfg = mergeCopyConfig(await services.loadCopyConfig());
      const settings = await services.agentSettings();
      const state = await services.botState();

      if (wantsLive) {
        if (!settings.enabled) {
          fail(res, 409, "agent_trading_disabled");
          return;
        }
        if (!liveTradingEnabled()) {
          fail(res, 409, "live_trading_disabled");
          return;
        }
        // READ the mode; never set it. A mode this lane was not told to accept
        // is a 409, NOT a 403 — a 403 would send him to rotate a healthy token.
        if (!cfg.acceptModes.includes(state.mode)) {
          fail(res, 409, "copy_mode_not_accepted");
          return;
        }
        if (settings.dailyLossFloorCents > 0) {
          const today = await services.realizedTodayCents();
          if (today <= -Math.abs(settings.dailyLossFloorCents)) {
            fail(res, 423, "daily_loss_floor_reached");
            return;
          }
        }
      }

      const rejected: Rejected[] = [];
      const collected = await collectFills(cfg, rejected);

      const previous = await services.loadCopyState();
      const acted = new Set<string>(previous?.acted ?? []);
      const seenKeys = new Set<string>();
      const seenOrders = new Set<string>();

      // Ceilings tighten and never widen: his app's own per-order cap is the
      // hard wall, and the copy lane's cap can only come in under it.
      const appCeilingCents = Math.round(settings.maxOrderNotionalUsd * 100);
      const perOrderCents = Math.min(cfg.perOrderCents, appCeilingCents);
      const perScanCents = Math.min(cfg.perScanCents, appCeilingCents * Math.max(1, cfg.maxOpenCopies));

      const balanceCents = await services.balanceCents();
      const scanBudgetCents = Math.min(perScanCents, balanceCents);

      let open = await services.openCopyCount();
      const accepted: PlannedCopy[] = [];
      const nowMs = now();
      let committedCents = 0;

      for (const fill of collected.fills) {
        const ageMin = (nowMs - Date.parse(fill.observedAt)) / 60_000;
        if (!Number.isFinite(ageMin) || ageMin > cfg.maxSignalAgeMinutes) {
          rejected.push({
            reason: "stale_signal",
            detail: `${fill.sourceTrader} ${fill.marketKey} is ${Number.isFinite(ageMin) ? Math.round(ageMin) : "?"}m old (max ${cfg.maxSignalAgeMinutes}m)`,
          });
          continue;
        }
        // A fill timestamped in the FUTURE has a negative age, which is under
        // every ceiling — so an age gate alone treats a clock-skewed or bad row
        // as the freshest signal in the scan. One minute of slack absorbs real
        // clock drift between his app and the venue.
        if (ageMin < -1) {
          rejected.push({
            reason: "unusable_timestamp",
            detail: `${fill.sourceTrader} ${fill.marketKey} is timestamped ${Math.abs(Math.round(ageMin))}m in the FUTURE (${fill.observedAt})`,
          });
          continue;
        }
        if (!cfg.allowMakerFills && fill.role === "maker") {
          rejected.push({
            reason: "maker_fill_unmirrorable",
            detail: `${fill.sourceTrader} ${fill.marketKey} was a MAKER fill — they collected the spread`,
          });
          continue;
        }
        if (open >= cfg.maxOpenCopies) {
          rejected.push({ reason: "max_open_copies", detail: `${open} copies open, cap is ${cfg.maxOpenCopies}` });
          continue;
        }

        const market = await services.resolveMarket(fill);
        if (!market) {
          rejected.push({
            reason: "no_kalshi_match",
            detail: `${fill.venue} ${fill.marketKey} has no live, tradeable Kalshi market`,
          });
          continue;
        }

        const key = intentKey(fill, market.ticker);
        if (acted.has(key) || seenKeys.has(key)) {
          rejected.push({ reason: "duplicate_intent", detail: `${key} already acted on` });
          continue;
        }
        // The ask for THE SIDE THIS ORDER WILL BE PLACED ON — `side: fill.side`
        // below is "yes" or "no", and pricing a NO order at the YES ask is the
        // wrong side of the book. askForSide() never derives one side from the
        // other; see the ResolvedMarket doc block.
        const askCents = askForSide(market, fill.side);
        if (askCents === null) {
          rejected.push({
            reason: "missing_side_ask",
            detail: `${market.ticker} is not quoting an orderable 1..99c ${fill.side} ask (yesAskCents ${String(market.yesAskCents)}, noAskCents ${String(market.noAskCents)})`,
          });
          continue;
        }
        if (askCents < cfg.minPriceCents || askCents > cfg.maxPriceCents) {
          rejected.push({
            reason: "price_out_of_band",
            detail: `${market.ticker} ${fill.side} ask ${askCents}c outside ${cfg.minPriceCents}-${cfg.maxPriceCents}c`,
          });
          continue;
        }
        if (!Number.isInteger(cfg.count) || cfg.count < 1) {
          rejected.push({ reason: "below_min_count", detail: `count ${cfg.count} is not a positive integer` });
          continue;
        }

        const notionalCents = cfg.count * askCents;
        if (notionalCents > perOrderCents) {
          const fits = Math.floor(perOrderCents / askCents);
          rejected.push({
            reason: "exceeds_per_order_cap",
            detail: `${market.ticker} is ${notionalCents}c, over the ${perOrderCents}c per-order cap — ${fits} contracts fit, so slice it`,
          });
          continue;
        }
        if (committedCents + notionalCents > scanBudgetCents) {
          rejected.push({
            reason: "exceeds_scan_budget",
            detail: `${market.ticker} needs ${notionalCents}c, scan has committed ${committedCents}c of ${scanBudgetCents}c`,
          });
          continue;
        }

        /* The order. `priceCents` is the ask FOR THIS SIDE, so nothing here ever
         * sends a market order — a buy at the ask crosses and fills, which is
         * the faithful mirror.
         *
         * ★ NAMED, NOT FIXED, because fixing it needs a bid this interface does
         *   not carry: when `action` is "sell", pricing at the ASK makes a
         *   PASSIVE resting offer that joins the current best offer instead of
         *   crossing. It is not mispriced — it is simply unlikely to fill, so a
         *   mirrored sell can be a silent no-op rather than a loss. If that
         *   matters, `ResolvedMarket` needs yesBidCents/noBidCents too and a
         *   sell should be priced at the bid for its side.
         * ★ ALSO UNVERIFIED: how his app's POST /order handles action "sell" on a
         *   position the account does not hold. On Kalshi that is a short, which
         *   it may open, reject, or interpret as a close. One live paper order is
         *   the only thing that answers it.
         */
        const bare = {
          ticker: market.ticker,
          side: fill.side,
          action: fill.action,
          count: cfg.count,
          priceCents: askCents,
        };
        const clientOrderId = newClientOrderId(bare, nowMs);
        if (seenOrders.has(clientOrderId)) {
          rejected.push({ reason: "duplicate_intent", detail: `${key} builds the byte-identical order as an earlier signal in this scan` });
          continue;
        }

        seenKeys.add(key);
        seenOrders.add(clientOrderId);
        accepted.push({
          order: { ...bare, clientOrderId },
          notionalCents,
          venue: fill.venue,
          sourceTrader: fill.sourceTrader,
          role: fill.role,
          intentKey: key,
          // Both prices, labelled. `fill.priceCents` is what THEIR side cost
          // (side-corrected, not the YES print); `askCents` is what ours will.
          why: `${fill.venue} ${fill.role} fill by ${fill.sourceTrader}: ${fill.action} ${fill.side} at ${fill.priceCents}c (their side's price), ${Math.round(ageMin)}m ago — mirrored as a limit at the ${fill.side} ask ${askCents}c`,
        });
        committedCents += notionalCents;
        open += 1;
      }

      /* SEND — sequentially, one attempt each, stopping the WHOLE batch on the
       * first refusal. Walking the rest of the list after a lockout or a
       * rejected token just deepens it. */
      const sent: StoredCopyState["sent"] = [];
      if (wantsLive) {
        for (const p of accepted) {
          try {
            const result = await services.placeOrder(p.order);
            sent.push({ clientOrderId: p.order.clientOrderId, result });
          } catch (e) {
            sent.push({ clientOrderId: p.order.clientOrderId, result: { error: String(e) } });
            break;
          }
        }
      }

      const rejectedByReason: Record<string, number> = {};
      for (const r of rejected) rejectedByReason[r.reason] = (rejectedByReason[r.reason] ?? 0) + 1;

      const stored: StoredCopyState = {
        scannedAt: new Date(nowMs).toISOString(),
        dryRun: !wantsLive,
        mode: state.mode,
        checked: {
          kalshiTradersRead: collected.kalshiTradersRead,
          kalshiVisible: collected.kalshiVisible,
          polymarketTradersRead: collected.polymarketTradersRead,
          fillsConsidered: collected.fills.length,
        },
        accepted,
        committedCents,
        rejectedByReason,
        // Bounded so a long scan cannot grow the stored state without limit.
        // The COUNTS above are complete; this is the readable sample.
        rejected: rejected.slice(0, 200),
        sent,
        // Keyed once, at the moment the copy was accepted — never recomputed from
        // the order, which has lost the venue and the trader by then.
        acted: [...acted, ...accepted.map((p) => p.intentKey)].slice(-2_000),
      };
      await services.saveCopyState(stored);
      res.json(stored);
    }),
  );

  /** GET /copy/state — the last scan. Counts and rejections BY REASON. */
  router.get(
    "/copy/state",
    guard(async (_req, res) => {
      const [stored, cfgRaw] = await Promise.all([services.loadCopyState(), services.loadCopyConfig()]);
      res.json({
        enabled: copyLaneEnabled(),
        liveTradingEnabled: liveTradingEnabled(),
        config: mergeCopyConfig(cfgRaw),
        last: stored ?? null,
      });
    }),
  );

  /** POST /copy/config — validated field by field. An empty patch is a 400, never a silent no-op. */
  router.post(
    "/copy/config",
    guard(async (req, res) => {
      const current = mergeCopyConfig(await services.loadCopyConfig());
      const v = validateCopyConfig(current, (req.body ?? {}) as Record<string, unknown>);
      if (!v.ok) {
        fail(res, 400, v.code);
        return;
      }
      await services.saveCopyConfig(v.config);
      res.json(v.config);
    }),
  );

  return router;
}
