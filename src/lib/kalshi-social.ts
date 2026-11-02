/**
 * KALSHI SOCIAL — the free, keyless, UNDOCUMENTED leaderboard + public trade tape.
 *
 * The public web consensus is that Kalshi has no leaderboard API. That is wrong:
 * it lives at /v1/social/*, takes no key, and answers 200 to a plain GET.
 * Every shape in this file came from a LIVE probe on 2026-10-04, never from docs.
 *
 *   GET /v1/social/leaderboard?metric_name=volume&limit=<1..100>
 *   GET /v1/social/trades?nickname=<nick>&page_size=<n>
 *   GET /v1/social/profile?nickname=<nick>            (not used here)
 *
 * READ THIS BEFORE USING ANY OF IT — three measured facts decide the design:
 *
 *  1. THE ONLY RANKING IS VOLUME. `metric_name` is a required enum validated by a
 *     Go `oneof` tag and "volume" is the only accepted value — profit, pnl,
 *     realized_pnl, roi, win_rate, trades, streak, notional and 13 more all come
 *     back 400 invalid_parameters. Volume is TURNOVER, NOT SKILL: a market maker
 *     churning both sides of a book ranks above a profitable directional bettor.
 *     So "top of the Kalshi leaderboard" is not evidence anybody is winning.
 *     Polymarket is the only one of the two venues that ranks BY PROFIT
 *     (src/lib/polymarket.ts:38).
 *
 *  2. THE COPYABLE UNIVERSE IS TINY. Trade visibility is opt-in. Of the top 100
 *     by volume, exactly 2 had visibility_state "visible" on 2026-10-04:
 *     rank 67 BitcoinTradingChallenge and rank 87 szg.szg. The other 98 return
 *     {"trades":[],"visibility_state":"hidden"}. Neither visible trader is in the
 *     top 50. findVisibleTraders() exists to re-measure this, not to assume it.
 *
 *  3. THE TRADE ROW DESCRIBES THE COUNTERPARTY. `taker_side`/`taker_action` are
 *     the TAKER's view even when the trader you asked about was the MAKER — and
 *     they were the maker on 77/100 and 91/100 of those two traders' rows.
 *     Copying those fields verbatim inverts the position on ~85% of rows.
 *     resolveFill() is the one place that correction is allowed to happen.
 *
 * No auth, no key, no cost. This module never writes, never POSTs, and never
 * touches Kalshi's trading API — src/lib/kalshi.ts owns signed orders.
 */

import type { Action, Role, Side, TraderFill } from "./copy-contracts";

const SOCIAL = "https://api.elections.kalshi.com/v1/social";

/**
 * A browser-shaped User-Agent. MEASURED on lb-api.polymarket.com, where the
 * default urllib/Node UA gets a 403 (src/lib/polymarket.ts:13-17). Whether
 * api.elections.kalshi.com cares is UNVERIFIED — the probe that produced every
 * fact in this file sent this header, so this is the configuration known to
 * return 200, and it costs nothing to keep sending it.
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/** Same 20s ceiling as the Polymarket reader (src/lib/polymarket.ts:22). */
const TIMEOUT_MS = 20_000;

async function get<T>(url: string): Promise<T> {
  const res = await globalThis.fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`kalshi-social ${url} → ${res.status}`);
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ helpers */

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/* -------------------------------------------------------------- leaderboard */

/** One leaderboard row, exactly the five fields the API gives that we use. */
export type KalshiLeader = {
  nickname: string;
  socialId: string;
  /**
   * The RAW integer the API returns under `value`. It is CENTS of volume.
   *
   * HOW THAT WAS ESTABLISHED (live GET, 2026-10-04, limit=100, 14,624 bytes):
   *   rank  1 imawhale                 value 2302314200
   *   rank 67 BitcoinTradingChallenge  value  111068410
   *   rank 87 szg.szg                  value   86590110
   * The same two traders' volumes were reported independently as $1,110,684 and
   * $865,901. 111068410/100 = $1,110,684.10 and 86590110/100 = $865,901.10 —
   * both reproduce exactly, and no other divisor does. That is the evidence.
   * (Secondary sanity check only, not proof: as cents rank 1 is $23.0M of
   * turnover, which is an ordinary number for a top account; read as dollars it
   * would be $2.3bn.)
   *
   * Use volumeDollars() rather than dividing at each call site.
   */
  value: number;
  rank: number;
  isAnonymous: boolean;
};

/** `value` is cents of VOLUME (turnover) — see KalshiLeader.value for the proof. */
export function volumeDollars(leader: KalshiLeader | number): number {
  const cents = typeof leader === "number" ? leader : leader.value;
  return cents / 100;
}

/**
 * MEASURED cap: limit is REQUIRED; 50 returns 50 rows, 100 returns 100, and 200
 * or 500 returns an error/empty body. So 100 is the ceiling and we never ask for
 * more. 0 or negative would drop the required parameter's meaning, so it floors
 * at 1. A non-numeric limit falls back to the full 100 rather than guessing.
 */
export function clampLeaderboardLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(100, Math.max(1, Math.floor(limit)));
}

/**
 * Top traders BY VOLUME. There is no other ranking on Kalshi.
 *
 * `metric_name` is hardcoded "volume" because every other value — profit, pnl,
 * realized_pnl, roi, win_rate, trades, streak, notional and 13 more — returns
 * 400 invalid_parameters from a Go `oneof` validator. There is NO profit
 * leaderboard on Kalshi, so nothing downstream may treat a high rank here as
 * evidence of skill; it is turnover, and a two-sided market maker maximises it.
 *
 * `period`, `window`, `timeframe`, `category` and `series_ticker` are all
 * IGNORED by the server (identical rank 1 for every value), so they are not
 * sent: there is exactly one window and it is unlabelled. Anything that needs a
 * time-boxed view has to collect snapshots itself.
 */
export async function fetchKalshiLeaderboard(limit = 100): Promise<KalshiLeader[]> {
  const n = clampLeaderboardLimit(limit);
  const body = await get<{ rank_list?: unknown }>(
    `${SOCIAL}/leaderboard?metric_name=volume&limit=${n}`,
  );
  const rows = Array.isArray(body?.rank_list) ? body.rank_list : [];

  const out: KalshiLeader[] = [];
  rows.forEach((raw, i) => {
    const row = asRecord(raw);
    if (!row) return; // not an object at all — nothing to read, nothing to copy
    out.push({
      nickname: asString(row.nickname),
      socialId: asString(row.social_id),
      // A non-numeric value reports 0 rather than throwing the whole walk away.
      // 0 is also a legitimate volume, so callers must not read 0 as an error.
      value: asFiniteNumber(row.value) ?? 0,
      // Fall back to the row's POSITION, which is the same ordering the server
      // ranked by — never an invented number.
      rank: asFiniteNumber(row.rank) ?? i + 1,
      isAnonymous: row.is_anonymous === true,
    });
  });
  return out;
}

/* ------------------------------------------------------------- public trades */

/**
 * One row of the public trade tape, snake_case mapped to camelCase and nothing
 * else — no interpretation happens here. The raw key set is EXACTLY:
 * trade_id, market_id, ticker, price, price_dollars, count, count_fp,
 * taker_side, taker_action, maker_nickname, taker_nickname, create_date.
 *
 * There is NO `created_time` and NO `ts` field. The timestamp is `create_date`.
 */
export type KalshiPublicTrade = {
  tradeId: string;
  marketId: string;
  /** Kalshi market ticker, e.g. "KXNHL2P-26OCT04WPGDET-TIE". */
  ticker: string;
  /** Integer cents as the API sends it. */
  price: number;
  /** The API's string dollar form, e.g. "0.99". Kept as the fallback source. */
  priceDollars: string;
  count: number;
  countFp: string;
  /** THE COUNTERPARTY'S side/action — see resolveFill() before using either. */
  takerSide: string;
  takerAction: string;
  makerNickname: string;
  takerNickname: string;
  /** ISO 8601 Z. */
  createDate: string;
};

/**
 * "visible" | "hidden" are the two values measured. Anything else (including a
 * missing field, reported as "unknown") must block copying: only "visible" is
 * ever treated as copyable — see isVisible().
 */
export type TradeVisibility = "visible" | "hidden" | string;

export function isVisible(visibility: TradeVisibility): boolean {
  return visibility === "visible";
}

/** Raw row → KalshiPublicTrade. Returns null for anything that isn't an object. */
export function normaliseTradeRow(raw: unknown): KalshiPublicTrade | null {
  const row = asRecord(raw);
  if (!row) return null;
  return {
    tradeId: asString(row.trade_id),
    marketId: asString(row.market_id),
    ticker: asString(row.ticker),
    price: asFiniteNumber(row.price) ?? Number.NaN,
    priceDollars: asString(row.price_dollars),
    count: asFiniteNumber(row.count) ?? Number.NaN,
    countFp: asString(row.count_fp),
    takerSide: asString(row.taker_side),
    takerAction: asString(row.taker_action),
    makerNickname: asString(row.maker_nickname),
    takerNickname: asString(row.taker_nickname),
    createDate: asString(row.create_date),
  };
}

/**
 * MEASURED: `page_size` is the parameter that works. `limit` is IGNORED (it
 * returns 100 regardless) and `cursor` is IGNORED, so there is no pagination —
 * one call is the whole window you can see. Default page size is 100.
 *
 * 100 is the largest page observed; whether a larger value is accepted is
 * UNVERIFIED, so this never sends one.
 */
export function clampPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return 100;
  return Math.min(100, Math.max(1, Math.floor(pageSize)));
}

export type PublicTradesResult = {
  trades: KalshiPublicTrade[];
  visibility: TradeVisibility;
  /**
   * Rows the server sent that were not objects and so could not be mapped.
   * Reported rather than silently dropped — a zero-length tape with malformed>0
   * is a different fact from an empty tape.
   */
  malformed: number;
};

/**
 * One trader's public tape. A hidden trader answers 200 with an EMPTY trades
 * array and visibility_state "hidden" — that is a normal answer, not an error,
 * and it must not throw.
 */
export async function fetchKalshiPublicTrades(
  nickname: string,
  pageSize = 100,
): Promise<PublicTradesResult> {
  const n = clampPageSize(pageSize);
  const body = await get<{ trades?: unknown; visibility_state?: unknown }>(
    `${SOCIAL}/trades?nickname=${encodeURIComponent(nickname)}&page_size=${n}`,
  );

  const raw = Array.isArray(body?.trades) ? body.trades : [];
  const trades: KalshiPublicTrade[] = [];
  let malformed = 0;
  for (const r of raw) {
    const row = normaliseTradeRow(r);
    if (row) trades.push(row);
    else malformed++;
  }

  // A missing visibility_state is reported as "unknown", not quietly promoted to
  // "visible" or mislabelled "hidden". Only "visible" unlocks copying anyway.
  const visibility = asString(body?.visibility_state) || "unknown";
  return { trades, visibility, malformed };
}

/* ------------------------------------------------------- the load-bearing bit */

function flip(action: Action): Action {
  return action === "buy" ? "sell" : "buy";
}

/**
 * The YES price of the print, in cents.
 *
 * ★★★ THIS IS THE **YES** PRICE, WHATEVER SIDE ANYONE WAS ON. It is NOT the
 * price the observed trader paid unless their resolved side is also "yes".
 * Use sidePriceCents() for that. MEASURED, not inferred: 41 rows of
 * BitcoinTradingChallenge's social tape were matched by `trade_id` against
 * `GET /trade-api/v2/markets/trades`, which publishes `yes_price` and
 * `no_price` separately. `social.price === v2.yes_price` on **all 41**,
 * including every row whose `taker_side` is "no" — e.g. trade
 * 072529dc-5c51-8e7a-8f6d-0f39d2963f52 (KXWNBA3QTOTAL-26OCT04NYATL-45) is
 * social `taker_side=no price=99` while v2 reports `yes_price=99, no_price=1`.
 * That NO side transacted at 1c, not 99c.
 *
 * Kalshi contracts print between 1c and 99c. A 0 or 100 print is not a price a
 * mirror order could be placed at, so it is REJECTED rather than clamped into
 * something we never saw. `price` is preferred; `price_dollars` is the fallback.
 */
function priceCentsOf(row: KalshiPublicTrade): number | null {
  const direct = Number.isFinite(row.price) ? Math.round(row.price) : null;
  if (direct !== null && direct >= 1 && direct <= 99) return direct;
  const dollars = asFiniteNumber(row.priceDollars);
  if (dollars !== null) {
    const cents = Math.round(dollars * 100);
    if (cents >= 1 && cents <= 99) return cents;
  }
  return null;
}

/**
 * What the OBSERVED TRADER's side actually cost, in cents.
 *
 * ★★★ THE 49x BUG THIS EXISTS TO PREVENT. The social feed reports only the YES
 * price (proven in priceCentsOf's doc block). 21 of 100 rows on a live tape
 * resolve to side "no". Passing the YES price through for those rows mis-states
 * the cost by (100 - p), and the error runs BOTH ways:
 *
 *   - A NO fill reported at 2c truly cost 98c. 895 contracts is $877.10, not
 *     $17.90 — so a $20 per-scan ceiling waves through a commitment 49x larger
 *     than his entire $42.40 balance.
 *   - A NO fill reported at 98c truly cost 2c, so a mirror limit is placed 49x
 *     above the market and sweeps every ask between.
 *
 * A binary market's two sides sum to 100c, so the NO price is the complement.
 * Rejects the degenerate ends the same way priceCentsOf does: a complement of
 * 0 or 100 is not an orderable price.
 */
export function sidePriceCents(yesPriceCents: number, side: Side): number | null {
  if (!Number.isFinite(yesPriceCents)) return null;
  const yes = Math.round(yesPriceCents);
  if (yes < 1 || yes > 99) return null;
  const px = side === "yes" ? yes : 100 - yes;
  return px >= 1 && px <= 99 ? px : null;
}

/**
 * Whole contracts only, floor — a fractional mirror cannot be sent.
 *
 * MEASURED on the 100-row BitcoinTradingChallenge tape (2026-10-04): `count` is
 * exactly floor(Number(count_fp)) on all 100 rows, so count_fp is the fractional
 * truth and count is already the server's own floor. Kalshi DOES print
 * sub-contract fills — one of those 100 rows was count 0 / count_fp "0.10" — and
 * there is no whole-contract order that mirrors it, so it is rejected. That row
 * is the single rejection out of 100 on live data.
 */
function countOf(row: KalshiPublicTrade): number | null {
  const direct = Number.isFinite(row.count) ? Math.floor(row.count) : null;
  if (direct !== null && direct >= 1) return direct;
  const fp = asFiniteNumber(row.countFp);
  if (fp !== null) {
    const floored = Math.floor(fp);
    if (floored >= 1) return floored;
  }
  return null;
}

/**
 * Resolve ONE public trade row into what the trader you asked about ACTUALLY
 * DID. This is the function that stands between a copied signal and an inverted
 * position, so it is written to fail closed: anything it cannot prove returns
 * null and is counted as a rejection by the caller.
 *
 * THE INVERSION, with the accounting spelled out. Kalshi's row reports the
 * TAKER's side and action no matter which side our trader stood on:
 *
 *   maker_nickname === nickname  → our trader was the MAKER.
 *       side   = taker_side        (PRESERVED)
 *       action = OPPOSITE of taker_action
 *     Why: a trade moves contracts between the two parties. If the taker SELLS
 *     NO, those NO contracts land with the maker, so the maker BOUGHT NO. The
 *     contract type (the side) is the same object for both parties; only the
 *     direction of the transfer differs. Hence side stays, action flips.
 *
 *   taker_nickname === nickname → our trader was the TAKER. side/action verbatim.
 *
 *   neither matches → return null. On anonymised rows the other party's
 *     nickname is "", so this case is common and ordinary. Never guess a role.
 *
 *   both match → a self-trade: the role is undecidable, so null.
 *
 * Matching is EXACT. Kalshi nickname case-sensitivity is UNVERIFIED, and a
 * case-insensitive match could bind two distinct accounts; a missed match costs
 * one skipped signal while a wrong match costs a wrong position, so exact wins.
 *
 * NOT HANDLED HERE, and it matters: a MAKER fill means they posted a resting
 * limit order and someone crossed to them — they COLLECTED the spread. Mirroring
 * that with a market order PAYS the spread, which is the opposite economics.
 * A faithful mirror of a maker fill is a resting limit at the same price. The
 * `maker_fill_unmirrorable` rejection in copy-contracts.ts:78 exists for the
 * caller that refuses to pay it; this function only reports the truth of the
 * fill, it does not decide whether the fill is worth copying.
 */
export function resolveFill(row: KalshiPublicTrade, nickname: string): TraderFill | null {
  if (!row || typeof nickname !== "string") return null;
  const nick = nickname.trim();
  if (nick === "") return null;

  const isMaker = row.makerNickname === nick;
  const isTaker = row.takerNickname === nick;
  if (isMaker === isTaker) return null; // neither party, or both (self-trade)

  const rawSide = row.takerSide.trim().toLowerCase();
  const rawAction = row.takerAction.trim().toLowerCase();
  if (rawSide !== "yes" && rawSide !== "no") return null;
  if (rawAction !== "buy" && rawAction !== "sell") return null;
  const takerSide: Side = rawSide;
  const takerAction: Action = rawAction;

  const tradeId = row.tradeId.trim();
  // A fill with no id cannot be de-duplicated, and inventing an id would make a
  // repeat look like a new signal. Reject instead.
  if (tradeId === "") return null;

  const marketKey = row.ticker.trim();
  if (marketKey === "") return null;

  const observedAt = row.createDate.trim();
  if (observedAt === "" || !Number.isFinite(Date.parse(observedAt))) return null;

  // ★ The feed's price is the YES price regardless of side; convert to what THIS
  //   trader's side cost. See sidePriceCents() — this is the 49x notional bug.
  const yesPriceCents = priceCentsOf(row);
  if (yesPriceCents === null) return null;
  const priceCents = sidePriceCents(yesPriceCents, takerSide);
  if (priceCents === null) return null;

  const count = countOf(row);
  if (count === null) return null;

  const role: Role = isMaker ? "maker" : "taker";

  return {
    tradeId,
    marketKey,
    side: takerSide, // preserved in BOTH roles — see the accounting above
    action: role === "maker" ? flip(takerAction) : takerAction,
    priceCents,
    count,
    role,
    observedAt,
  };
}

/* ----------------------------------------------------------- visibility walk */

export type VisibilityWalk = {
  /** Leaders whose tape actually reads "visible" — the copyable universe. */
  visible: KalshiLeader[];
  /** How many nicknames were actually probed. */
  checkedCount: number;
  /** Probed and reported anything other than "visible". */
  hiddenCount: number;
  /** Rows never probed, each with a named reason. Never a silent drop. */
  skipped: { nickname: string; reason: string }[];
  /** Probed and the request failed. Not counted as hidden — it is unknown. */
  errors: { nickname: string; message: string }[];
};

export type PoliteWalkOptions = {
  /** Gap between calls. Default 120ms. Tests pass 0. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Page size for the visibility probe. Default 5 — the smallest page size
   * MEASURED to work (page_size=5 returned 5 rows). page_size=1 is unverified,
   * so the cheap-looking value is not used.
   */
  pageSize?: number;
};

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Walk the volume leaderboard and find which traders' tapes are actually
 * readable. On 2026-10-04 that was 2 of 100 — this re-measures it rather than
 * trusting that number, because visibility is a per-user opt-in that can change
 * any day, in either direction.
 *
 * DELIBERATELY SERIAL with a ~120ms gap. This is somebody else's free,
 * undocumented, unauthenticated endpoint; firing 100 parallel requests at it is
 * how a free lane gets rate-limited or closed. The walk is slow on purpose
 * (~12s for 100 traders) and that is the right trade.
 */
export async function findVisibleTraders(
  limit = 100,
  opts: PoliteWalkOptions = {},
): Promise<VisibilityWalk> {
  const delayMs = opts.delayMs ?? 120;
  const sleep = opts.sleep ?? defaultSleep;
  const pageSize = clampPageSize(opts.pageSize ?? 5);

  const leaders = await fetchKalshiLeaderboard(limit);

  const visible: KalshiLeader[] = [];
  const skipped: { nickname: string; reason: string }[] = [];
  const errors: { nickname: string; message: string }[] = [];
  let checkedCount = 0;
  let hiddenCount = 0;

  for (let i = 0; i < leaders.length; i++) {
    const leader = leaders[i];
    const nick = leader.nickname.trim();
    if (nick === "") {
      // Cannot be queried and cannot be copied; named, not swallowed.
      skipped.push({ nickname: leader.nickname, reason: "no_nickname" });
      continue;
    }

    if (checkedCount > 0 && delayMs > 0) await sleep(delayMs);

    checkedCount++;
    try {
      const res = await fetchKalshiPublicTrades(nick, pageSize);
      if (isVisible(res.visibility)) visible.push(leader);
      else hiddenCount++;
    } catch (err) {
      errors.push({ nickname: nick, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return { visible, checkedCount, hiddenCount, skipped, errors };
}

/* --------------------------------------------------------------- summarising */

export type TraderSummary = {
  nickname: string;
  /** Rows handed in. */
  rows: number;
  /** Rows resolveFill() could prove. */
  resolved: number;
  /** Rows it refused — ambiguous role, unusable price/count/time, no id. */
  unresolved: number;
  makerFills: number;
  takerFills: number;
  /** makerFills / resolved, 0 when nothing resolved. */
  makerShare: number;
  distinctTickers: number;
  tickers: string[];
  /** Tickers where BOTH yes and no were traded — the churn tell. */
  bothSidesTickers: number;
  contracts: number;
  /** Σ priceCents × count over resolved fills. */
  notionalCents: number;
  newestObservedAt: string | null;
  oldestObservedAt: string | null;
  /**
   * A classification, not an opinion: makerShare >= 0.6 → "maker_dominant",
   * <= 0.4 → "taker_dominant", between → "mixed", nothing resolved → "unknown".
   * Both measured visible traders are maker_dominant (77/100 and 91/100), which
   * is what "the volume leaderboard ranks market makers" looks like in the data.
   */
  profile: "maker_dominant" | "taker_dominant" | "mixed" | "unknown";
};

/** Pure. No network. Give it the rows from fetchKalshiPublicTrades(). */
export function summariseTrader(nickname: string, trades: KalshiPublicTrade[]): TraderSummary {
  const rowsIn = Array.isArray(trades) ? trades : [];
  const sidesByTicker = new Map<string, Set<Side>>();
  let resolved = 0;
  let makerFills = 0;
  let takerFills = 0;
  let contracts = 0;
  let notionalCents = 0;
  let newest: string | null = null;
  let oldest: string | null = null;

  for (const row of rowsIn) {
    const fill = resolveFill(row, nickname);
    if (!fill) continue;
    resolved++;
    if (fill.role === "maker") makerFills++;
    else takerFills++;
    contracts += fill.count;
    notionalCents += fill.priceCents * fill.count;

    const set = sidesByTicker.get(fill.marketKey) ?? new Set<Side>();
    set.add(fill.side);
    sidesByTicker.set(fill.marketKey, set);

    const t = Date.parse(fill.observedAt);
    if (newest === null || t > Date.parse(newest)) newest = fill.observedAt;
    if (oldest === null || t < Date.parse(oldest)) oldest = fill.observedAt;
  }

  const makerShare = resolved === 0 ? 0 : makerFills / resolved;
  const profile: TraderSummary["profile"] =
    resolved === 0
      ? "unknown"
      : makerShare >= 0.6
        ? "maker_dominant"
        : makerShare <= 0.4
          ? "taker_dominant"
          : "mixed";

  return {
    nickname,
    rows: rowsIn.length,
    resolved,
    unresolved: rowsIn.length - resolved,
    makerFills,
    takerFills,
    makerShare,
    distinctTickers: sidesByTicker.size,
    tickers: [...sidesByTicker.keys()].sort(),
    bothSidesTickers: [...sidesByTicker.values()].filter((s) => s.size > 1).length,
    contracts,
    notionalCents,
    newestObservedAt: newest,
    oldestObservedAt: oldest,
    profile,
  };
}
