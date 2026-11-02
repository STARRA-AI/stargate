/**
 * Frozen contracts for the leaderboard copy-trade lane.
 *
 * Every type here was derived from a LIVE probe on 2026-10-04, not from docs.
 * The venues disagree about almost everything, so this file is the only place
 * their vocabularies are allowed to meet.
 *
 *   Kalshi   GET https://api.elections.kalshi.com/v1/social/leaderboard
 *                ?metric_name=volume&limit=<=100              (free, no auth)
 *            GET https://api.elections.kalshi.com/v1/social/trades
 *                ?nickname=<nick>&page_size=<n>                (free, no auth)
 *   Polymarket GET https://lb-api.polymarket.com/profit?window=7d&limit=<=50
 *            GET https://data-api.polymarket.com/activity?user=<wallet>
 */

/** Which exchange the SIGNAL was observed on. Not necessarily where it executes. */
export type Venue = "kalshi" | "polymarket";

/** Kalshi contract side. Polymarket outcomes are normalised onto this. */
export type Side = "yes" | "no";
export type Action = "buy" | "sell";

/**
 * Which side of the match our observed trader stood on.
 *
 * This is load-bearing. Kalshi's public trade row reports `taker_side` and
 * `taker_action` — the COUNTERPARTY's view — and 77-91% of the rows belonging
 * to the two visible top-100 traders are rows where they were the MAKER
 * (measured 2026-10-04: BitcoinTradingChallenge 77/100, szg.szg 91/100).
 * Copying those fields verbatim takes the WRONG SIDE on most trades.
 */
export type Role = "maker" | "taker";

/** One fill, already resolved to what the OBSERVED TRADER actually did. */
export type TraderFill = {
  tradeId: string;
  /** Kalshi market ticker, or a Polymarket conditionId. */
  marketKey: string;
  side: Side;
  action: Action;
  /** Always in cents, 1-99. Polymarket dollar prices are converted. */
  priceCents: number;
  /** Contracts (Kalshi) or shares (Polymarket), rounded down to whole units. */
  count: number;
  role: Role;
  /** ISO 8601 UTC. */
  observedAt: string;
};

/** A venue-neutral instruction to mirror one trader's position. */
export type CopyIntent = {
  venue: Venue;
  /** Kalshi nickname, or Polymarket pseudonym. Never a wallet secret. */
  sourceTrader: string;
  /** The Kalshi ticker we would actually send. null = not matched to Kalshi yet. */
  ticker: string | null;
  side: Side;
  action: Action;
  priceCents: number;
  count: number;
  role: Role;
  observedAt: string;
  /** 0..1. Why we believe this trader, not how sure we are of the fill. */
  confidence: number;
  /** Human-readable provenance, shown in the ops feed. */
  why: string;
  /**
   * The RAW venue fields this intent came from, kept only so a later pass can
   * resolve `ticker` without re-walking the tape.
   *
   * ★ `outcome` is ONLY ever a competitor name — a point-spread bet on
   *   "Spread: Bills (-6.5)" arrives as outcome "Patriots". Anything resolving a
   *   ticker from these fields MUST classify the market kind from `slug` (falling
   *   back to `title`) first, or it will match a spread bet to a game-winner
   *   market and call the price difference edge. See copy-match.ts
   *   matchOutcomeGuarded.
   *
   * Optional: Kalshi intents are already native and never need it.
   */
  source?: { outcome: string; slug?: string; title: string };
};

/** Why a candidate intent was dropped. Every drop is named, never silent. */
export type CopyRejection =
  | "trades_hidden"
  | "stale_signal"
  | "no_kalshi_match"
  | "market_not_live"
  | "market_not_tradeable"
  | "price_out_of_band"
  | "below_min_count"
  | "maker_fill_unmirrorable"
  | "trader_not_persistent"
  | "self_trade"
  | "duplicate_intent";

export type Rejected = { reason: CopyRejection; detail: string };

export type CopyScan = {
  intents: CopyIntent[];
  rejected: Rejected[];
  /** Counts by venue so a silent zero is always explainable. */
  checked: { kalshiTraders: number; kalshiVisible: number; polyTraders: number };
  scannedAt: string;
};
