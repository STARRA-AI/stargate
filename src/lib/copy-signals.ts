/**
 * COPY SIGNALS — the venue-neutral layer that turns somebody else's observed
 * fill into something we could mirror, or into a NAMED reason we will not.
 *
 * This file never touches the network and never places an order. It takes rows
 * that someone else fetched and answers one question per row: is this a
 * mirrorable instruction, and if not, exactly why not. Every drop is a
 * `CopyRejection` from ./copy-contracts — there is no silent filtering here,
 * because a scan that returns zero intents has to be able to say WHY it
 * returned zero. A silent zero is indistinguishable from a broken fetcher.
 *
 * ── WHAT THE TWO VENUES ACTUALLY GIVE US (measured live 2026-10-04) ──────────
 *
 * KALSHI ranks ONLY by volume. `metric_name` is a validated enum and the only
 * value it accepts is "volume" — profit, pnl, roi, win_rate and 16 other names
 * all return 400. So the Kalshi leaderboard ranks TURNOVER, not skill: a market
 * maker churning both sides of a book sits at the top of it. That is why every
 * Kalshi confidence in this file is capped well below 0.5 (see kalshiConfidence)
 * and why the `why` string says so out loud.
 *
 * KALSHI trade visibility is OPT-IN, and almost nobody opts in. Of the top 100
 * traders by volume, exactly TWO had `visibility_state == "visible"`:
 * "BitcoinTradingChallenge" (rank 67) and "szg.szg" (rank 87). The other 98
 * return an empty trade list. The copyable universe on Kalshi is two people,
 * neither of them in the top 50. `gatherCopyScan` reports that as 98
 * `trades_hidden` rows rather than as a quiet zero.
 *
 * POLYMARKET ranks by PROFIT, which is better evidence — but one week of profit
 * is a hot streak, not a track record. Of the 21 wallets that cleared $100k in
 * 7d (measured 2026-09-04), ZERO had meaningful profit in the prior three
 * weeks. `minPolyPriorWeeks` is the correction and `trader_not_persistent` is
 * what it emits. See src/lib/polymarket.ts:118-148 for the measurement.
 *
 * ── THE MAKER ECONOMICS LANDMINE ─────────────────────────────────────────────
 *
 * 77-91% of the readable fills belonging to those two Kalshi traders are fills
 * where THEY were the maker: they posted a resting limit order and somebody
 * crossed the spread to them, so they COLLECTED the spread. Mirroring that with
 * a market order PAYS the spread — the exact opposite trade economically. A
 * faithful mirror of a maker fill is a resting limit at the same price, which
 * this lane cannot currently send. So `includeMakerFills` defaults to FALSE and
 * maker fills are dropped as `maker_fill_unmirrorable`. Turning it on is a
 * deliberate choice to copy a trade whose edge we are structurally giving away,
 * and the confidence drops by 0.10 to say so.
 *
 * (Resolving WHICH side the observed trader took — Kalshi's row describes the
 * COUNTERPARTY — belongs to `resolveFill` in src/lib/kalshi-social.ts, not
 * here. This file consumes already-resolved `TraderFill`s.)
 *
 * ── THREE HONEST GAPS IN THE FROZEN CONTRACT ─────────────────────────────────
 *
 * 1. `CopyIntent` has no market-identity field for a non-Kalshi venue: `ticker`
 *    is defined as "the Kalshi ticker we would actually send", and writing a
 *    Polymarket conditionId into it would be a lie that could end up in an
 *    order body. So a Polymarket intent carries its conditionId and outcome in
 *    `why` only, and a downstream Kalshi matcher needs the originating
 *    `PolyFill` alongside the intent — the intent alone is not enough.
 * 2. `CopyRejection` has no reason for "we already have N fresher intents from
 *    this trader". The per-trader cap therefore reports overflow as
 *    `duplicate_intent` with a detail string that spells out it was the cap and
 *    not a defect. The label is the nearest available one, not an exact one.
 * 3. `CopyRejection` has no reason for "we do not believe this trader enough".
 *    The `minConfidence` floor therefore reports a drop as
 *    `trader_not_persistent` — the nearest available label, since every term in
 *    both confidence functions is evidence ABOUT THE TRADER (rank, prior-week
 *    profit, role) and nothing about the fill. The detail always says the words
 *    CONFIDENCE FLOOR so it is never mistaken for the Polymarket 30d-vs-7d gate.
 *
 * ── THE CONFIDENCE FLOOR IS ENFORCED, NOT DECORATION ─────────────────────────
 *
 * `kalshiConfidence` caps at 0.449 on purpose, to say out loud that a VOLUME
 * rank is not skill. For a while that honesty was reportorial only: the number
 * was computed, printed in `why`, and then nothing read it — a scan could say
 * "we barely believe this" and send it anyway. `minConfidence` closes that:
 * every intent is now measured against it and dropped by name.
 *
 * THE DEFAULT IS 0.25, chosen to change today's output by NOTHING. The lowest
 * confidence either lane can currently produce for a fill that reaches the floor
 * is 0.3 (a Kalshi TAKER fill with an unknown rank); Polymarket's lowest is 0.35.
 * So at the shipped defaults the floor drops zero intents and exists as a live
 * tripwire rather than a silent kill. What it DOES bite is the opt-in case: with
 * `includeMakerFills: true`, a MAKER fill scores 0.2 + 0.15*(101-rank)/100, which
 * falls under 0.25 at volume rank 68 and worse — so mid-table churn stops being
 * mirrorable the moment maker fills are admitted. A floor ABOVE 0.45 would mute
 * the entire Kalshi lane, which is why nothing here defaults near it.
 *
 * ── THE MARKET GATE IS INJECTED, AND ABSENT BY DEFAULT ───────────────────────
 *
 * A Kalshi intent used to reach the router with no check that its market is
 * still open or still quoted: `copy-match.ts` owns those two questions, and no
 * Kalshi intent ever passes through it (the ticker resolver only runs on
 * Polymarket intents). So a fill observed on a market that has already closed
 * became an order into a closed market.
 *
 * `CopyScanDeps.kalshiMarket` is the gate, and it is a LOOKUP THE CALLER
 * INJECTS. Left undefined there is no gate at all and this file makes no request
 * — the same posture as every other fetcher here. The gate itself is
 * `copy-match.ts`'s own `isLive` / `isTradeable`, imported rather than
 * re-implemented, because two copies of one rule drift. Note which clock
 * `isLive` uses: `occurrence_datetime`, the actual start. `close_time` is the
 * SETTLEMENT window, so a Thursday game shows a Sunday close.
 *
 * ── WHY THIS FILE DOES NOT CALL kalshi-social.findVisibleTraders ─────────────
 *
 * It cannot, and the reason is structural rather than stylistic. See the
 * paragraph above `gatherCopyScan`'s leaderboard walk.
 */
import type {
  Action,
  CopyIntent,
  CopyRejection,
  CopyScan,
  Rejected,
  Role,
  Side,
  TraderFill,
} from "./copy-contracts";
import type { PolyTrade } from "./polymarket";
// ★ VALUE import, deliberately: the liveness/tradeability rules are copy-match's
//   and are used here rather than re-implemented. copy-match.ts imports NOTHING
//   (verified: 0 import statements), so this cannot cycle.
import { isLive, isTradeable, type KalshiMarketLite } from "./copy-match";

/* ───────────────────────────── configuration ───────────────────────────── */

export type CopySignalConfig = {
  /**
   * Drop a fill older than this. A prediction-market edge is perishable: by the
   * time a 30-minute-old fill is mirrored, the book has usually moved to it.
   * Boundary is INCLUSIVE — a fill exactly this old is already stale.
   */
  maxSignalAgeMin: number;
  /** Fewer contracts than this is noise, not a position. */
  minCount: number;
  /**
   * Prices we will mirror, in whole cents. 1c and 99c are decided outcomes, not
   * prices: there is no edge left to capture and no liquidity to exit into.
   */
  priceBandCents: { min: number; max: number };
  /** DEFAULT FALSE. See the maker-economics landmine in the file header. */
  includeMakerFills: boolean;
  /**
   * Lowest confidence we will mirror, 0..1. ENFORCED, not printed: an intent
   * under this floor is dropped as `trader_not_persistent` with CONFIDENCE FLOOR
   * in the detail.
   *
   * 0.25 by default, which drops nothing at the shipped defaults and bites
   * mid-table MAKER fills the moment `includeMakerFills` is turned on. A Kalshi
   * intent can never score above 0.449, so a floor above that mutes the whole
   * Kalshi lane — see the header section on this.
   */
  minConfidence: number;
  /**
   * Dollars a Polymarket trader must have made BEFORE the current week
   * (30d profit minus 7d profit) to be worth copying at all. 0 means "must not
   * have been losing money before this week".
   */
  minPolyPriorWeeks: number;
  /** Ceiling on intents from one trader per scan, so one churner cannot flood the queue. */
  maxIntentsPerTrader: number;
  /** Kalshi leaderboard rows to examine. Server hard-caps at 100. */
  kalshiTraderLimit: number;
  /** Polymarket leaderboard rows to examine. Server hard-caps at 50. */
  polyTraderLimit: number;
};

export const DEFAULT_SIGNAL_CONFIG: CopySignalConfig = {
  maxSignalAgeMin: 10,
  minCount: 1,
  priceBandCents: { min: 2, max: 98 },
  includeMakerFills: false,
  minConfidence: 0.25,
  minPolyPriorWeeks: 0,
  maxIntentsPerTrader: 5,
  kalshiTraderLimit: 100,
  polyTraderLimit: 50,
};

/** Measured server caps. Asking for more returns an error or an empty body. */
export const KALSHI_LEADERBOARD_MAX = 100;
export const POLY_LEADERBOARD_MAX = 50;

/** A fill stamped further than this into the future is a bad clock, not a signal. */
const FUTURE_SLACK_MS = 60_000;

/** The rejection reasons THIS layer can emit. */
export const SIGNAL_REJECTIONS: readonly CopyRejection[] = [
  "trades_hidden",
  "stale_signal",
  "no_kalshi_match",
  "price_out_of_band",
  "below_min_count",
  "maker_fill_unmirrorable",
  "trader_not_persistent",
  "self_trade",
  "duplicate_intent",
  // ★ Emitted ONLY when `CopyScanDeps.kalshiMarket` is injected — see
  //   MARKET_GATE_REJECTIONS directly below.
  "market_not_live",
  "market_not_tradeable",
];

/**
 * The two reasons this file emits ONLY when a market lookup is injected.
 *
 * ★ THIS CONSTANT USED TO BE CALLED `MATCH_OWNED_REJECTIONS` and it used to say
 *   these reasons were "never emitted here: this file has no Kalshi market
 *   object to ask about liveness or tradeability". That was true, and it was the
 *   defect: no Kalshi intent ever reaches copy-match.ts, so nobody asked those
 *   two questions about a Kalshi intent at all. Now the caller may hand in the
 *   lookup (`CopyScanDeps.kalshiMarket`) and `gateMarketLiveness` asks them with
 *   copy-match.ts's own `isLive` / `isTradeable`.
 *
 * With no lookup injected, neither reason can appear — that is asserted in
 * tests/copy-signals.test.ts, because "absent by default" is the whole contract.
 */
export const MARKET_GATE_REJECTIONS: readonly CopyRejection[] = [
  "market_not_live",
  "market_not_tradeable",
];

/* ─────────────────────────── inputs from the venues ────────────────────── */

/**
 * The Kalshi leaderboard row, as src/lib/kalshi-social.ts produces it.
 *
 * Declared structurally here rather than imported so this module compiles and
 * tests green on its own; TypeScript's structural typing means the real
 * `KalshiLeader` drops straight into `CopyScanDeps`. A field rename there
 * becomes a compile error at the wiring site, which is where it belongs.
 */
export type KalshiLeaderLite = {
  nickname: string;
  socialId: string;
  /**
   * ★ THE RAW `value` INTEGER, WHICH IS **CENTS** OF VOLUME — NOT DOLLARS.
   *
   * Division 1 measured it live (src/lib/kalshi-social.ts:86-108): rank 67
   * BitcoinTradingChallenge came back as 111068410 and rank 87 szg.szg as
   * 86590110, against independently reported volumes of $1,110,684 and
   * $865,901. Only a divisor of 100 reproduces both. Pass it through
   * `leaderVolumeDollars()` — never straight into a dollar string.
   *
   * Turnover either way: a two-sided market maker maximises this by definition.
   */
  value: number;
  rank: number;
  isAnonymous: boolean;
};

/** Cents-of-volume -> dollars. See the note on KalshiLeaderLite.value. */
export const leaderVolumeDollars = (value: number): number => value / 100;

/**
 * THE ONLY PART OF A KALSHI TRADE ROW THIS FILE READS.
 *
 * `gatherCopyScan` touches four fields: the two nicknames (to catch a wash
 * print) and the id plus ticker (to name a row in a rejection). Price, count,
 * side and action are `resolveFill`'s business, and the only thing this file
 * consumes from it is the `TraderFill` it returns.
 *
 * Depending on four fields instead of eleven is deliberate. The seam was first
 * written against the full eleven and did NOT compile against Division 1's real
 * row, which ships `price` where the contract said `priceCents`, adds
 * `countFp`, and widens `takerSide`/`takerAction` from the literal unions to
 * plain `string` (src/lib/kalshi-social.ts:177-195). None of those fields are
 * read here, so none of them can break this lane.
 */
export type KalshiRowIdentity = {
  tradeId: string;
  ticker: string;
  makerNickname: string;
  takerNickname: string;
};

/**
 * The row shape as the frozen contract described it, kept as the documented
 * reference and as the default type argument for `CopyScanDeps`.
 *
 * ★ Division 1's live `KalshiPublicTrade` is NOT this shape — see the
 *   deviations listed on KalshiRowIdentity. Anything that needs the price or
 *   the counterparty fields should take Division 1's type, not this one.
 */
export type KalshiPublicTradeLite = {
  tradeId: string;
  marketId: string;
  ticker: string;
  priceCents: number;
  priceDollars: string;
  count: number;
  /** ★ THE COUNTERPARTY's side, not the observed trader's. */
  takerSide: Side;
  /** ★ THE COUNTERPARTY's action, not the observed trader's. */
  takerAction: Action;
  makerNickname: string;
  takerNickname: string;
  createDate: string;
};

/** What we know about a Kalshi trader when we score their fills. */
export type KalshiTraderEvidence = {
  /** 1-based leaderboard rank. 0 = unknown. */
  rank: number;
  /** Leaderboard volume in dollars. */
  volumeDollars: number;
};

/** A Polymarket leaderboard trader, already scored for persistence. */
export type PolyTraderRef = {
  pseudonym: string;
  proxyWallet: string;
  /** 1-based rank in the profit leaderboard. 0 = unknown. */
  rank: number;
  /** Profit in the 7d window, dollars. */
  profit7d: number;
  /** 30d profit minus 7d profit — what they earned BEFORE this week. */
  priorWeeks: number;
};

/**
 * One Polymarket TRADE row. Structurally a subset of `PolyTrade`
 * (src/lib/polymarket.ts:47-56), so `fetchTrades` output drops straight in.
 *
 * ★ `price` is DOLLARS (0..1) and `timestamp` is UNIX SECONDS — both unlike
 *   Kalshi, which is why the conversion lives in one place below.
 * ★ There is NO maker/taker field on this row. `RawActivity`
 *   (src/lib/polymarket.ts:58-67) has none, and the feed carries making income
 *   as separate MAKER_REBATE rows that `fetchTrades` already filters out. So a
 *   Polymarket fill is treated as a TAKER fill. That is an ASSUMPTION, not a
 *   measurement, and it is the one thing in this file I could not verify.
 */
export type PolyFill = Pick<
  PolyTrade,
  // `slug` is the market-KIND signal and the only field that distinguishes a
  // spread bet from a moneyline — `outcome` is just a competitor name on both.
  // Optional on PolyTrade, so it stays optional here.
  "side" | "outcome" | "title" | "slug" | "price" | "size" | "timestamp" | "conditionId"
>;

/** What every converter returns: what we would send, and why we dropped the rest. */
export type IntentBatch = { intents: CopyIntent[]; rejected: Rejected[] };

/* ──────────────────────────────── helpers ──────────────────────────────── */

const toMs = (now: Date | number): number => (typeof now === "number" ? now : now.getTime());

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** 3dp so confidences compare exactly in tests instead of by epsilon. */
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Lookahead-only thousands separator (no lookbehind — WebKit forbids it in client code). */
const usd = (n: number): string => {
  const r = Math.round(n);
  const sign = r < 0 ? "-" : "";
  return `${sign}$${Math.abs(r)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
};

const parseMs = (iso: string): number => Date.parse(iso);

const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type Freshness = { ok: true; ageMs: number } | { ok: false; detail: string };

/**
 * Age gate. The boundary is INCLUSIVE: a fill exactly `maxSignalAgeMin` old is
 * stale, because by the time we act on it it is older than that.
 */
function freshness(observedAt: string, cfg: CopySignalConfig, nowMs: number): Freshness {
  const t = parseMs(observedAt);
  if (!Number.isFinite(t)) {
    return { ok: false, detail: `observedAt "${observedAt}" is not a parseable timestamp` };
  }
  const ageMs = nowMs - t;
  const limitMs = cfg.maxSignalAgeMin * 60_000;
  if (ageMs >= limitMs) {
    return {
      ok: false,
      detail: `${Math.round(ageMs / 1000)}s old, limit ${cfg.maxSignalAgeMin}m (${Math.round(limitMs / 1000)}s, inclusive)`,
    };
  }
  if (ageMs < -FUTURE_SLACK_MS) {
    return {
      ok: false,
      detail: `stamped ${Math.round(-ageMs / 1000)}s in the FUTURE — bad clock, not a signal`,
    };
  }
  return { ok: true, ageMs };
}

/**
 * Kalshi confidence, deliberately capped low: the only ranking the venue
 * exposes is VOLUME, which a two-sided market maker maximises by definition.
 * Rank 1 as a taker tops out at 0.449.
 */
function kalshiConfidence(rank: number, role: Role): number {
  const rankTerm = rank > 0 ? 0.15 * (Math.max(0, 101 - rank) / 100) : 0;
  const roleTerm = role === "maker" ? -0.1 : 0;
  return clamp01(round3(0.3 + rankTerm + roleTerm));
}

/**
 * Polymarket confidence can exceed Kalshi's because that leaderboard ranks by
 * PROFIT. The 0.20 term is reserved for the only evidence that separates an
 * earner from a hot streak: money made BEFORE this week.
 */
function polyConfidence(rank: number, priorWeeks: number, role: Role): number {
  const rankTerm = rank > 0 ? 0.1 * (Math.max(0, 51 - rank) / 50) : 0;
  const priorTerm = priorWeeks > 0 ? 0.2 : 0;
  const roleTerm = role === "maker" ? -0.1 : 0;
  return clamp01(round3(0.35 + rankTerm + priorTerm + roleTerm));
}

/**
 * Polymarket outcome -> Kalshi-shaped side.
 *
 * A binary market's outcomes are literally "Yes"/"No". A multi-outcome market
 * names the competitor ("Chiefs"), and buying that token is a YES on that
 * competitor — the NO side of a named outcome is a different token entirely.
 * An empty outcome is unusable: there is no side and nothing to match on.
 */
function polySide(outcome: string): { side: Side; label: string } | null {
  const raw = outcome.trim();
  if (raw === "") return null;
  const o = raw.toLowerCase();
  if (o === "yes") return { side: "yes", label: "YES" };
  if (o === "no") return { side: "no", label: "NO" };
  return { side: "yes", label: `YES on "${clip(raw, 40)}"` };
}

/** Polymarket stamps unix SECONDS. Anything already in ms is passed through. */
function tsToIso(timestamp: number): string | null {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const ms = timestamp < 1e12 ? Math.round(timestamp * 1000) : Math.round(timestamp);
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * WHY A KALSHI ROW DID NOT RESOLVE — named from what this lane can actually see.
 *
 * `resolveFill` (src/lib/kalshi-social.ts:399-434) returns a bare `null` for
 * SEVEN distinct conditions and reports none of them:
 *   1. the nickname is empty                                   (:400-402)
 *   2. the trader is on neither side, or on BOTH               (:404-406)
 *   3. `taker_side` is not yes|no                              (:408-410)
 *   4. `taker_action` is not buy|sell                          (:409-411)
 *   5. `trade_id` is empty                                     (:415-418)
 *   6. `ticker` is empty                                       (:420-421)
 *   7. `create_date` is empty or unparseable                   (:423-424)
 *   8. the YES price is missing or outside 1..99, or count < 1 (:428-434)
 *
 * This lane used to file EVERY one of them under the single sentence "neither
 * nickname matches … refusing to guess the side", which is false for most of
 * them and sends whoever reads the scan hunting a nickname problem that is not
 * there.
 *
 * `Row` is only guaranteed to carry `KalshiRowIdentity` — four fields — so 1, 2,
 * 5 and 6 are PROVABLE from here and the rest are not. Those four are named; the
 * rest are reported as genuinely UNKNOWN, with the candidate list in the detail.
 *
 * ★ One honest limit: resolveFill checks side/action BEFORE the ids, so when a
 *   row has both a bad side and an empty tradeId, this names the empty tradeId
 *   while resolveFill actually tripped on the side. The named cause is always a
 *   REAL defect of the row, not always the first one that fired. The real fix is
 *   for resolveFill to return its reason, and that belongs in kalshi-social.ts.
 */
export function classifyUnresolvedRow(row: KalshiRowIdentity, nickname: string): Rejected {
  const where = `kalshi ${nickname} row ${row.tradeId || "(no tradeId)"} (${row.ticker || "no ticker"})`;
  const nick = nickname.trim();

  if (nick === "") {
    return {
      reason: "trades_hidden",
      detail: `${where}: the leaderboard row carries no nickname, so no role can be resolved for it`,
    };
  }

  const isMaker = row.makerNickname === nick;
  const isTaker = row.takerNickname === nick;

  if (isMaker && isTaker) {
    return {
      reason: "self_trade",
      detail: `${where}: "${nick}" is BOTH maker and taker — wash print, role undecidable`,
    };
  }
  if (!isMaker && !isTaker) {
    return {
      reason: "trades_hidden",
      detail: `${where}: neither nickname matches (maker="${row.makerNickname}" taker="${row.takerNickname}") — role unresolvable, refusing to guess the side. Matching is case-SENSITIVE.`,
    };
  }
  if (row.tradeId.trim() === "") {
    return {
      reason: "duplicate_intent",
      detail: `${where}: NO TRADE ID, so this fill cannot be de-duplicated and a repeat of it would read as a new signal (nearest frozen reason; the contract has no malformed-row reason)`,
    };
  }
  if (row.ticker.trim() === "") {
    return {
      reason: "no_kalshi_match",
      detail: `${where}: the row carries no ticker, so there is no Kalshi market to send anything to`,
    };
  }
  return {
    reason: "trades_hidden",
    detail: `${where}: resolveFill refused the row and the cause is UNKNOWN from here — it is one of taker_side not yes|no, taker_action not buy|sell, create_date empty/unparseable, YES price outside 1-99, or count < 1 (src/lib/kalshi-social.ts:408-434). resolveFill returns a bare null and reports no reason; this lane does not have those fields and will not guess which one it was.`,
  };
}

/* ─────────────────────────────── Kalshi lane ───────────────────────────── */

/**
 * Already-resolved Kalshi fills -> intents, with a named reason for every drop.
 *
 * Fills are sorted freshest-first before the cap is applied, so the cap keeps
 * the freshest fills rather than whatever order the API happened to return.
 */
export function kalshiFillsToIntents(
  nickname: string,
  fills: TraderFill[],
  cfg: CopySignalConfig = DEFAULT_SIGNAL_CONFIG,
  now: Date | number = Date.now(),
  evidence?: KalshiTraderEvidence,
): IntentBatch {
  const nowMs = toMs(now);
  const intents: CopyIntent[] = [];
  const rejected: Rejected[] = [];
  const rank = evidence && evidence.rank > 0 ? evidence.rank : 0;
  const volume = evidence && evidence.volumeDollars > 0 ? evidence.volumeDollars : 0;
  const rankText = rank > 0 ? `volume rank ${rank}` : "volume rank unknown";
  const volText = volume > 0 ? `, ${usd(volume)} turnover` : "";

  const ordered = [...fills].sort((a, b) => {
    const am = parseMs(a.observedAt);
    const bm = parseMs(b.observedAt);
    const an = Number.isFinite(am) ? am : -Infinity;
    const bn = Number.isFinite(bm) ? bm : -Infinity;
    if (an !== bn) return bn - an;
    return a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0;
  });

  for (const f of ordered) {
    const where = `kalshi ${nickname} fill ${f.tradeId} (${f.marketKey})`;

    const fresh = freshness(f.observedAt, cfg, nowMs);
    if (!fresh.ok) {
      rejected.push({ reason: "stale_signal", detail: `${where}: ${fresh.detail}` });
      continue;
    }

    if (!Number.isInteger(f.count) || f.count < 1 || f.count < cfg.minCount) {
      rejected.push({
        reason: "below_min_count",
        detail: `${where}: count ${f.count}, need a whole count >= ${Math.max(1, cfg.minCount)}`,
      });
      continue;
    }

    if (
      !Number.isInteger(f.priceCents) ||
      f.priceCents < cfg.priceBandCents.min ||
      f.priceCents > cfg.priceBandCents.max
    ) {
      rejected.push({
        reason: "price_out_of_band",
        detail: `${where}: ${f.priceCents}c outside ${cfg.priceBandCents.min}-${cfg.priceBandCents.max}c — no edge left and nothing to exit into`,
      });
      continue;
    }

    if (f.role === "maker" && !cfg.includeMakerFills) {
      rejected.push({
        reason: "maker_fill_unmirrorable",
        detail: `${where}: they were the MAKER and COLLECTED the spread at ${f.priceCents}c; a market-order mirror PAYS it. Set includeMakerFills to copy it anyway.`,
      });
      continue;
    }

    // ★ THE FLOOR IS ENFORCED HERE, not merely printed. Kalshi confidence is
    //   rank + role only, so this is a judgement about the TRADER, which is why
    //   the nearest frozen reason is `trader_not_persistent`.
    const confidence = kalshiConfidence(rank, f.role);
    // `<` rather than `!(>=)` deliberately: a NaN floor here DISABLES the gate
    // instead of muting the lane, and dragon-copy's own floor is NaN-proof and
    // still refuses (resolveCaps -> raiseConfidence). A broken config must not be
    // able to silently kill every signal; the money layer is the one that must
    // never fail open, and it does not.
    if (confidence < cfg.minConfidence) {
      rejected.push({
        reason: "trader_not_persistent",
        detail: `${where}: CONFIDENCE FLOOR — ${confidence} < minConfidence ${cfg.minConfidence} (${rankText}, ${f.role}). Kalshi ranks by VOLUME only, so a mid-table ${f.role} fill is not evidence. Not the Polymarket persistence gate; nearest frozen reason.`,
      });
      continue;
    }

    // Cap last: a defective fill is reported as the defect, not as overflow.
    if (intents.length >= cfg.maxIntentsPerTrader) {
      rejected.push({
        reason: "duplicate_intent",
        detail: `${where}: maxIntentsPerTrader=${cfg.maxIntentsPerTrader} already reached for ${nickname} — PER-TRADER CAP, not a defect (contract has no cap reason)`,
      });
      continue;
    }

    const makerNote =
      f.role === "maker"
        ? " MAKER FILL: they collected the spread, a market-order mirror pays it."
        : "";

    intents.push({
      venue: "kalshi",
      sourceTrader: nickname,
      // Kalshi is native: the ticker we observed is the ticker we would send.
      ticker: f.marketKey,
      side: f.side,
      action: f.action,
      priceCents: f.priceCents,
      count: f.count,
      role: f.role,
      observedAt: f.observedAt,
      confidence,
      why: `kalshi ${nickname} (${rankText}${volText}) was the ${f.role}: ${f.action} ${f.count} ${f.side.toUpperCase()} @ ${f.priceCents}c in ${f.marketKey}, ${Math.round(fresh.ageMs / 1000)}s ago. Kalshi ranks by VOLUME only — turnover, not skill.${makerNote}`,
    });
  }

  return { intents, rejected };
}

/* ───────────────────────────── Polymarket lane ─────────────────────────── */

/**
 * Polymarket TRADE rows -> intents. `ticker` is always null: matching a
 * Polymarket market to a Kalshi ticker is src/lib/copy-match.ts's job, not
 * this file's. Pass `kalshiExecutableOnly` when the caller needs output it can
 * actually send to Kalshi — every unmatched intent then becomes
 * `no_kalshi_match` instead of being handed on as unexecutable.
 */
export function polyTradesToIntents(
  trader: PolyTraderRef,
  trades: PolyFill[],
  cfg: CopySignalConfig = DEFAULT_SIGNAL_CONFIG,
  now: Date | number = Date.now(),
  opts: { kalshiExecutableOnly?: boolean } = {},
): IntentBatch {
  const nowMs = toMs(now);
  const intents: CopyIntent[] = [];
  const rejected: Rejected[] = [];
  const who = trader.pseudonym || trader.proxyWallet;

  // The persistence gate is about the TRADER, so it runs once and stops the
  // whole trader rather than repeating itself on every one of their fills.
  if (!(trader.priorWeeks >= cfg.minPolyPriorWeeks)) {
    rejected.push({
      reason: "trader_not_persistent",
      detail: `polymarket ${who}: ${usd(trader.priorWeeks)} earned before this week, need >= ${usd(cfg.minPolyPriorWeeks)} (7d was ${usd(trader.profit7d)}). One hot week is not a track record.`,
    });
    return { intents, rejected };
  }

  const rank = trader.rank > 0 ? trader.rank : 0;
  const rankText = rank > 0 ? `profit rank ${rank}` : "profit rank unknown";

  const ordered = [...trades].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    if (a.conditionId !== b.conditionId) return a.conditionId < b.conditionId ? -1 : 1;
    return a.outcome < b.outcome ? -1 : a.outcome > b.outcome ? 1 : 0;
  });

  for (const t of ordered) {
    const where = `polymarket ${who} ${t.conditionId || "(no conditionId)"}`;

    const observedAt = tsToIso(t.timestamp);
    if (observedAt === null) {
      rejected.push({
        reason: "stale_signal",
        detail: `${where}: timestamp ${t.timestamp} is not usable, so age cannot be checked`,
      });
      continue;
    }

    const fresh = freshness(observedAt, cfg, nowMs);
    if (!fresh.ok) {
      rejected.push({ reason: "stale_signal", detail: `${where}: ${fresh.detail}` });
      continue;
    }

    const resolved = polySide(t.outcome);
    if (resolved === null) {
      rejected.push({
        reason: "no_kalshi_match",
        detail: `${where}: outcome field is empty — no side to take and nothing to match on Kalshi`,
      });
      continue;
    }

    const count = Math.floor(t.size);
    if (!Number.isFinite(count) || count < 1 || count < cfg.minCount) {
      rejected.push({
        reason: "below_min_count",
        detail: `${where}: size ${t.size} floors to ${count}, need >= ${Math.max(1, cfg.minCount)}`,
      });
      continue;
    }

    // Dollars (0..1) -> whole cents. 0.47 -> 47c; 0.005 -> 1c and 0.999 -> 100c
    // both land outside the band, which is the correct answer for both.
    const priceCents = Math.round(t.price * 100);
    if (
      !Number.isFinite(priceCents) ||
      priceCents < cfg.priceBandCents.min ||
      priceCents > cfg.priceBandCents.max
    ) {
      rejected.push({
        reason: "price_out_of_band",
        detail: `${where}: $${t.price} -> ${priceCents}c outside ${cfg.priceBandCents.min}-${cfg.priceBandCents.max}c`,
      });
      continue;
    }

    // ★ ASSUMPTION, not a measurement: the activity feed's TRADE rows carry no
    //   maker/taker field, and its making income arrives as separate
    //   MAKER_REBATE rows that polymarket.ts already filters out.
    //
    //   So there is NO maker gate on this lane — `includeMakerFills` cannot
    //   apply to a row whose role we never learn. If that assumption is wrong,
    //   Polymarket maker fills are silently being treated as taker fills here,
    //   and this comment is where to come looking.
    const role: Role = "taker";

    // Same floor, same reason, before the caller's executable-only preference:
    // "we do not believe this trader enough" is a truer answer than "you asked
    // for Kalshi-executable output", and it is the one that would still apply.
    const confidence = polyConfidence(rank, trader.priorWeeks, role);
    if (confidence < cfg.minConfidence) {
      rejected.push({
        reason: "trader_not_persistent",
        detail: `${where}: CONFIDENCE FLOOR — ${confidence} < minConfidence ${cfg.minConfidence} (${rankText}, ${usd(trader.priorWeeks)} before this week). The persistence gate above passed; this is the floor.`,
      });
      continue;
    }

    if (opts.kalshiExecutableOnly) {
      rejected.push({
        reason: "no_kalshi_match",
        detail: `${where}: ${resolved.label} "${clip(t.title, 60)}" has no Kalshi ticker yet; caller asked for Kalshi-executable output only`,
      });
      continue;
    }

    if (intents.length >= cfg.maxIntentsPerTrader) {
      rejected.push({
        reason: "duplicate_intent",
        detail: `${where}: maxIntentsPerTrader=${cfg.maxIntentsPerTrader} already reached for ${who} — PER-TRADER CAP, not a defect (contract has no cap reason)`,
      });
      continue;
    }

    const action: Action = t.side === "SELL" ? "sell" : "buy";

    intents.push({
      venue: "polymarket",
      sourceTrader: who,
      // Never a conditionId: `ticker` is the Kalshi ticker we would SEND, and a
      // wrong value here could reach an order body.
      ticker: null,
      side: resolved.side,
      action,
      priceCents,
      count,
      role,
      observedAt,
      confidence,
      // Kept so resolvePolyTickers() can find a Kalshi market later without
      // re-walking the tape. See CopyIntent.source for the spread-bet warning.
      source: { outcome: t.outcome, slug: t.slug, title: t.title },
      why: `polymarket ${who} (${rankText}, ${usd(trader.profit7d)} 7d, ${usd(trader.priorWeeks)} before this week) ${action === "buy" ? "bought" : "sold"} ${count} ${resolved.label} @ ${priceCents}c in "${clip(t.title, 60)}" [conditionId ${t.conditionId || "unknown"}], ${Math.round(fresh.ageMs / 1000)}s ago. ticker=null — copy-match.ts owns finding the Kalshi market.`,
    });
  }

  return { intents, rejected };
}

/* ──────────────────────────────── dedupe ──────────────────────────────── */

type Agg = {
  intent: CopyIntent;
  clips: number;
  minPrice: number;
  maxPrice: number;
  mixedRole: boolean;
};

/**
 * Collapse one trader's burst of clips into the ORDER that caused it.
 *
 * Top accounts fill in many small clips at one price inside the same second —
 * twelve $5 prints are one $60 intent, not twelve signals. Mirroring each clip
 * would fire a dozen tiny orders, pay a dozen spreads, and on Dragon Tradar's
 * $42.40 balance exhaust the account on one trader's single order.
 *
 * Bucket is trader + ticker + side + action + WHOLE SECOND — the same
 * floor(ms/1000) idea `newClientOrderId` uses in src/lib/dragon-orders.ts:80-91.
 *
 * When clips inside one bucket disagree on price, the merged price is the WORST
 * one for us: the highest clip on a buy, the lowest on a sell. That overstates
 * notional rather than understating it, so the ceiling in dragon-orders.ts
 * brakes early instead of late, and a limit set there would actually fill.
 */
export function dedupeIntents(intents: CopyIntent[]): IntentBatch {
  const byKey = new Map<string, Agg>();
  const rejected: Rejected[] = [];

  for (const i of intents) {
    const ms = parseMs(i.observedAt);
    const bucket = Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : `unparseable:${i.observedAt}`;
    // ★★★ THE MARKET IDENTITY MUST BE IN THIS KEY, and `ticker` alone is not it.
    //   Every Polymarket intent carries ticker=null until resolvePolyTickers runs
    //   (which is AFTER this pass), so `i.ticker ?? "<unmatched>"` made the market
    //   component a CONSTANT for the whole Polymarket lane: one trader's bets on
    //   completely different markets, same side/action in the same second, merged
    //   into ONE intent with their counts SUMMED. The survivor then resolved to a
    //   single ticker and would have been sent at the combined size.
    //   `outcome` is in the key too: "buy YES Patriots" and "buy YES Bills" in the
    //   same market are opposite bets that both read side=yes action=buy.
    const market =
      i.ticker ??
      (i.source ? `${i.source.slug ?? i.source.title}|${i.source.outcome}` : "<unidentified>");
    const key = `${i.venue}|${i.sourceTrader}|${market}|${i.side}|${i.action}|${bucket}`;
    const prev = byKey.get(key);

    if (!prev) {
      byKey.set(key, {
        intent: { ...i },
        clips: 1,
        minPrice: i.priceCents,
        maxPrice: i.priceCents,
        mixedRole: false,
      });
      continue;
    }

    prev.clips += 1;
    prev.intent.count += i.count;
    prev.minPrice = Math.min(prev.minPrice, i.priceCents);
    prev.maxPrice = Math.max(prev.maxPrice, i.priceCents);
    prev.intent.priceCents = prev.intent.action === "buy" ? prev.maxPrice : prev.minPrice;
    prev.intent.confidence = Math.min(prev.intent.confidence, i.confidence);
    if (prev.intent.role !== i.role) prev.mixedRole = true;

    rejected.push({
      reason: "duplicate_intent",
      detail: `${key}: clip ${prev.clips} (${i.count} @ ${i.priceCents}c) merged into one intent of ${prev.intent.count} @ ${prev.intent.priceCents}c`,
    });
  }

  const out: CopyIntent[] = [];
  for (const agg of byKey.values()) {
    if (agg.clips > 1) {
      const spread =
        agg.minPrice === agg.maxPrice
          ? `all at ${agg.minPrice}c`
          : `prices ${agg.minPrice}-${agg.maxPrice}c, kept the worst for us (${agg.intent.priceCents}c)`;
      agg.intent.why += ` Merged ${agg.clips} same-second clips (${spread}).`;
      if (agg.mixedRole) {
        agg.intent.why += ` Clips disagreed on role; kept ${agg.intent.role}.`;
      }
    }
    out.push(agg.intent);
  }

  return { intents: out, rejected };
}

/* ──────────────────────────────── ranking ─────────────────────────────── */

/** Every field that distinguishes two intents, so the order cannot depend on input order. */
function tiebreakKey(i: CopyIntent): string {
  return [
    i.observedAt,
    i.venue,
    i.sourceTrader,
    i.ticker ?? "",
    i.side,
    i.action,
    i.priceCents,
    i.count,
    i.role,
    i.confidence,
    i.why,
  ].join("\u0000");
}

/**
 * Freshest first, then larger count, then a full-field key.
 *
 * The key matters: `Array.prototype.sort` is stable, so any pair that ties on
 * every compared field would come out in INPUT order — which would make the
 * ranking depend on whatever order the fetchers returned. Two intents that tie
 * on the full key are byte-identical and therefore interchangeable.
 */
export function rankIntents(intents: CopyIntent[]): CopyIntent[] {
  return [...intents].sort((a, b) => {
    const am = parseMs(a.observedAt);
    const bm = parseMs(b.observedAt);
    const an = Number.isFinite(am) ? am : -Infinity;
    const bn = Number.isFinite(bm) ? bm : -Infinity;
    if (an !== bn) return bn - an;
    if (a.count !== b.count) return b.count - a.count;
    const ak = tiebreakKey(a);
    const bk = tiebreakKey(b);
    return ak < bk ? -1 : ak > bk ? 1 : 0;
  });
}

/* ────────────────────────────── orchestrator ──────────────────────────── */

/**
 * Injected fetchers. Grouped per venue so "leaderboard without trades" cannot
 * be expressed, and `poly` is optional so a Kalshi-only scan is a valid scan
 * with an honest `checked.polyTraders` of 0.
 */
export type CopyScanDeps<Row extends KalshiRowIdentity = KalshiPublicTradeLite> = {
  kalshi: {
    leaderboard: (limit: number) => Promise<KalshiLeaderLite[]>;
    trades: (nickname: string, pageSize: number) => Promise<{ trades: Row[]; visibility: string }>;
    /**
     * Resolves the COUNTERPARTY-shaped row into what the observed trader did.
     *
     * Generic in `Row` on purpose: the fetcher and the resolver come from the
     * same module and agree on the row shape, so this lane does not need to —
     * it only needs `KalshiRowIdentity`. A non-generic version of this type
     * would force every field rename in that module through here.
     */
    resolveFill: (row: Row, nickname: string) => TraderFill | null;
  };
  poly?: {
    leaderboard: (limit: number) => Promise<PolyTraderRef[]>;
    trades: (wallet: string, limit: number) => Promise<PolyFill[]>;
  };
  /**
   * OPTIONAL Polymarket -> Kalshi ticker resolver.
   *
   * ★ Why this exists: Dragon Tradar executes on KALSHI ONLY. A Polymarket
   *   intent with `ticker: null` is a real signal that cannot be sent, and the
   *   live scan on 2026-10-04 dropped 15 of them as `no_ticker` at the routing
   *   stage. Injecting a resolver is what turns those into executable orders.
   *
   * ★ It MUST be market-kind-aware. `outcome` is only ever a competitor name, so
   *   a point-spread bet arrives as outcome "Patriots"; resolving that against a
   *   game-winner series buys the wrong event at a price that looks like edge.
   *   Pass copy-match.ts's `matchOutcomeGuarded`-backed resolver, never a bare
   *   name matcher. Returning null is always a safe answer.
   *
   * Left undefined, this lane behaves exactly as before: ticker stays null.
   */
  resolveKalshiTicker?: (signal: {
    outcome: string;
    slug?: string;
    title: string;
    side: Side;
  }) => Promise<{ ticker: string; kind?: string } | null> | { ticker: string; kind?: string } | null;
  /**
   * OPTIONAL Kalshi market lookup — the LIVENESS / TRADEABILITY GATE.
   *
   * ★ WHY THIS EXISTS: a Kalshi intent never passes through copy-match.ts (the
   *   ticker resolver above only runs on Polymarket intents), so until this was
   *   added nothing asked whether the market behind a Kalshi fill was still open
   *   or still quoted. A fill observed a few minutes ago on a market that has
   *   since closed became an order into a closed market.
   *
   * ★ ABSENT BY DEFAULT, and this file never fetches on its own. Left undefined
   *   there is NO gate — same posture as every other fetcher here, and the reason
   *   the tests need no network.
   *
   * ★ RETURN null FOR "not listed / cannot read it". That is treated as
   *   `market_not_tradeable`, not as permission: a ticker the venue does not list
   *   is a ticker nothing can be sent to. A lookup that THROWS is treated the same
   *   way, so a flaky market fetch costs signals rather than money.
   *
   * Only the four fields `isLive` / `isTradeable` read are needed:
   * occurrence_datetime, close_time, yes_ask_dollars, ticker.
   */
  kalshiMarket?: (
    ticker: string,
  ) => Promise<KalshiMarketLite | null> | KalshiMarketLite | null;
  /** Injectable clock so a scan is reproducible in a test. */
  now?: () => number;
};

/**
 * One scan across both venues.
 *
 * Reads are sequential and never retried: these are free, undocumented
 * endpoints, and Dragon Tradar's own API answers one bad token with a 429 that
 * locks Classic out of his bot. A per-trader read failure is recorded as
 * `trades_hidden` (we could not see their trades — the detail names the cause)
 * instead of killing the other 99 traders.
 *
 * Nothing here POSTs anywhere. There is no order path in this file.
 */
export async function gatherCopyScan<Row extends KalshiRowIdentity>(
  cfg: CopySignalConfig,
  deps: CopyScanDeps<Row>,
  opts: { kalshiExecutableOnly?: boolean; kalshiPageSize?: number; polyTradeLimit?: number } = {},
): Promise<CopyScan> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const rejected: Rejected[] = [];
  const collected: CopyIntent[] = [];
  const checked = { kalshiTraders: 0, kalshiVisible: 0, polyTraders: 0 };

  const kalshiLimit = Math.max(1, Math.min(cfg.kalshiTraderLimit, KALSHI_LEADERBOARD_MAX));
  const pageSize = Math.max(1, opts.kalshiPageSize ?? 100);

  // ★ WHY THIS WALK IS NOT `kalshi-social.findVisibleTraders()`, which does look
  //   like the same walk (and is tested there). Three structural reasons, all of
  //   them in that function's signature:
  //
  //   1. IT TAKES NO FETCHERS. `findVisibleTraders(limit, PoliteWalkOptions)` —
  //      src/lib/kalshi-social.ts:490-496 — calls `fetchKalshiLeaderboard` and
  //      `fetchKalshiPublicTrades` directly; `PoliteWalkOptions` is only
  //      {delayMs, sleep, pageSize} (:465-475). This lane is injected end to end
  //      (`CopyScanDeps`), which is the only reason its tests touch no network.
  //      Calling it would put live HTTP inside every scan test.
  //   2. IT THROWS AWAY THE TAPE IT READ. It probes with page_size 5 (:496) and
  //      keeps only the leader objects (:520). This lane needs the FULL rows from
  //      the same read, so going through it means two reads per trader — ~200
  //      requests on somebody else's free, undocumented endpoint instead of ~100.
  //   3. ITS ACCOUNTING IS A DIFFERENT SHAPE. `VisibilityWalk` reports
  //      {visible, checkedCount, hiddenCount, skipped[], errors[]} (:452-463);
  //      this lane has to emit one NAMED `CopyRejection` per skipped trader.
  //
  //   So the duplication is real and it is NOT fixed here. The fix is in
  //   kalshi-social.ts: give `findVisibleTraders` injectable fetchers and have it
  //   RETURN the rows it read, then this walk can call it. That file is not this
  //   division's to edit.
  const leaders = await deps.kalshi.leaderboard(kalshiLimit);
  checked.kalshiTraders = leaders.length;

  for (let idx = 0; idx < leaders.length; idx++) {
    const leader = leaders[idx];
    const rank = leader.rank > 0 ? leader.rank : idx + 1;

    // An anonymised leaderboard row has no nickname to query. Say so instead of
    // spending a request to be told nothing.
    if (leader.isAnonymous || !leader.nickname) {
      rejected.push({
        reason: "trades_hidden",
        detail: `kalshi rank ${rank}: anonymous leaderboard row, no nickname to read trades for`,
      });
      continue;
    }

    let res: { trades: Row[]; visibility: string };
    try {
      res = await deps.kalshi.trades(leader.nickname, pageSize);
    } catch (e) {
      rejected.push({
        reason: "trades_hidden",
        detail: `kalshi ${leader.nickname} (rank ${rank}): trade read FAILED — ${errText(e)}`,
      });
      continue;
    }

    if (res.visibility !== "visible") {
      // The measured normal case: 98 of the top 100 sit here. Trade visibility
      // is opt-in on Kalshi, so this is a setting, not an error.
      rejected.push({
        reason: "trades_hidden",
        detail: `kalshi ${leader.nickname} (rank ${rank}, ${usd(leaderVolumeDollars(leader.value))} volume): visibility_state="${res.visibility}" — trade sharing is opt-in and they have it off`,
      });
      continue;
    }

    checked.kalshiVisible += 1;

    const fills: TraderFill[] = [];
    for (const row of res.trades) {
      // Both sides the same account is a wash print. On a leaderboard ranked by
      // VOLUME that is the cheapest way to climb, so it is also the thing most
      // worth refusing to copy.
      if (row.makerNickname && row.makerNickname === row.takerNickname) {
        rejected.push({
          reason: "self_trade",
          detail: `kalshi ${leader.nickname} row ${row.tradeId} (${row.ticker}): maker and taker are both "${row.makerNickname}" — wash print, inflates a volume rank and means nothing`,
        });
        continue;
      }

      const fill = deps.kalshi.resolveFill(row, leader.nickname);
      if (fill === null) {
        // ★ ONE hardcoded cause used to be printed for all seven of resolveFill's
        //   null paths. A wrong reason is worse than no reason.
        rejected.push(classifyUnresolvedRow(row, leader.nickname));
        continue;
      }
      fills.push(fill);
    }

    const batch = kalshiFillsToIntents(leader.nickname, fills, cfg, nowMs, {
      rank,
      // ★ /100: the leaderboard's `value` is CENTS. Passing it raw printed a
      //   100x-too-large turnover in the ops feed. Display-only either way —
      //   confidence is computed from RANK, never from volume — but a wrong
      //   number in front of Classic is still a wrong number.
      volumeDollars: leaderVolumeDollars(leader.value),
    });
    collected.push(...batch.intents);
    rejected.push(...batch.rejected);
  }

  if (deps.poly) {
    const polyLimit = Math.max(1, Math.min(cfg.polyTraderLimit, POLY_LEADERBOARD_MAX));
    const tradeLimit = Math.max(1, opts.polyTradeLimit ?? 100);
    const polyLeaders = await deps.poly.leaderboard(polyLimit);
    checked.polyTraders = polyLeaders.length;

    for (const trader of polyLeaders) {
      let trades: PolyFill[];
      try {
        trades = await deps.poly.trades(trader.proxyWallet, tradeLimit);
      } catch (e) {
        rejected.push({
          reason: "trades_hidden",
          detail: `polymarket ${trader.pseudonym || trader.proxyWallet}: activity read FAILED — ${errText(e)}`,
        });
        continue;
      }

      const batch = polyTradesToIntents(trader, trades, cfg, nowMs, {
        kalshiExecutableOnly: opts.kalshiExecutableOnly,
      });
      collected.push(...batch.intents);
      rejected.push(...batch.rejected);
    }
  }

  const deduped = dedupeIntents(collected);
  rejected.push(...deduped.rejected);

  // ★ Resolve Polymarket intents to a Kalshi ticker, if a resolver was injected.
  //   Dragon Tradar executes on Kalshi only, so an unresolved Polymarket intent
  //   is a real signal that cannot be sent. Runs AFTER dedupe so one market is
  //   resolved once rather than once per clip.
  let finalIntents = deduped.intents;
  if (deps.resolveKalshiTicker) {
    const r = await resolvePolyTickers(finalIntents, deps.resolveKalshiTicker);
    finalIntents = r.intents;
    rejected.push(...r.rejected);
  }

  // ★ THE MARKET GATE, LAST, so it sees every ticker that now exists — the native
  //   Kalshi ones AND the Polymarket ones the resolver just filled in. Absent
  //   lookup = no gate and no request; see CopyScanDeps.kalshiMarket.
  if (deps.kalshiMarket) {
    const g = await gateMarketLiveness(finalIntents, deps.kalshiMarket, nowMs);
    finalIntents = g.intents;
    rejected.push(...g.rejected);
  }

  return {
    intents: rankIntents(finalIntents),
    rejected,
    checked,
    scannedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Fill in `ticker` on Polymarket intents, using an injected resolver.
 *
 * ★ WHY THIS IS A SEPARATE PASS: polyTradesToIntents is synchronous and pure,
 *   and resolving a Kalshi ticker needs the live market list. Keeping the two
 *   apart means every existing caller and test of that function is untouched.
 *
 * ★ THE RESOLVER MUST BE MARKET-KIND-AWARE. Pass something backed by
 *   copy-match.ts matchOutcomeGuarded. A bare name matcher will resolve a
 *   point-spread bet onto a game-winner market — a different, less likely event
 *   at a cheaper price that reads as edge. Returning null is always safe.
 *
 * A resolver that throws is treated as "no match" for that one intent: a flaky
 * market fetch must not take down a whole scan, and an unresolved intent is
 * merely unexecutable, never wrong.
 */
export async function resolvePolyTickers(
  intents: CopyIntent[],
  resolve: NonNullable<CopyScanDeps["resolveKalshiTicker"]>,
): Promise<{ intents: CopyIntent[]; resolved: number; rejected: Rejected[] }> {
  const out: CopyIntent[] = [];
  const rejected: Rejected[] = [];
  let resolved = 0;

  for (const intent of intents) {
    if (intent.venue !== "polymarket" || intent.ticker !== null || !intent.source) {
      out.push(intent);
      continue;
    }
    let hit: { ticker: string; kind?: string } | null = null;
    try {
      hit = await resolve({
        outcome: intent.source.outcome,
        slug: intent.source.slug,
        title: intent.source.title,
        side: intent.side,
      });
    } catch (e) {
      rejected.push({
        reason: "no_kalshi_match",
        detail: `polymarket ${intent.sourceTrader} "${intent.source.title}": resolver threw (${e instanceof Error ? e.message : String(e)}) — treated as no match, scan continues`,
      });
      out.push(intent);
      continue;
    }
    if (!hit) {
      rejected.push({
        reason: "no_kalshi_match",
        detail: `polymarket ${intent.sourceTrader} "${intent.source.title}" (outcome "${intent.source.outcome}"): no live Kalshi market matched${intent.source.slug ? `, slug ${intent.source.slug}` : ""}`,
      });
      out.push(intent);
      continue;
    }
    resolved++;
    out.push({
      ...intent,
      ticker: hit.ticker,
      why: `${intent.why} RESOLVED to Kalshi ${hit.ticker}${hit.kind ? ` (kind ${hit.kind})` : ""}.`,
    });
  }
  return { intents: out, resolved, rejected };
}

/* ─────────────────────── the market liveness/tradeability gate ──────────── */

type MarketLookup = { ok: true; market: KalshiMarketLite | null } | { ok: false; error: string };

/**
 * Drop any intent whose Kalshi market is closed, unquoted, or unknown.
 *
 * Uses copy-match.ts's `isLive` and `isTradeable` rather than its own copies of
 * them — one rule, one place. `isLive` measures against `occurrence_datetime`
 * (the actual start); `close_time` is the SETTLEMENT window and would read a
 * Thursday game as open until Sunday (src/lib/copy-match.ts:85-98).
 *
 * REFUSING IS THE SAFE DIRECTION HERE, which is the opposite of
 * `resolvePolyTickers`: an unresolved ticker is merely unsendable, but an intent
 * that HAS a ticker and fails this gate would be sent. So an unknown market and a
 * lookup that throws are both refusals, and both cost a signal rather than money.
 *
 * `ticker: null` intents pass through untouched — there is nothing to look up,
 * and dragon-copy rejects them as `no_ticker` at the routing stage.
 *
 * One lookup per DISTINCT ticker, cached for the pass: a dozen clips of one
 * market must not become a dozen requests to somebody else's free endpoint.
 */
export async function gateMarketLiveness(
  intents: CopyIntent[],
  lookup: NonNullable<CopyScanDeps["kalshiMarket"]>,
  now: Date | number = Date.now(),
): Promise<{ intents: CopyIntent[]; rejected: Rejected[] }> {
  const at = new Date(toMs(now));
  const out: CopyIntent[] = [];
  const rejected: Rejected[] = [];
  const cache = new Map<string, MarketLookup>();

  for (const intent of intents) {
    const ticker = intent.ticker;
    if (ticker === null || ticker === "") {
      out.push(intent);
      continue;
    }

    let res = cache.get(ticker);
    if (res === undefined) {
      try {
        res = { ok: true, market: (await lookup(ticker)) ?? null };
      } catch (e) {
        res = { ok: false, error: errText(e) };
      }
      cache.set(ticker, res);
    }

    const where = `${intent.venue} ${intent.sourceTrader} ${ticker}`;

    if (!res.ok) {
      rejected.push({
        reason: "market_not_tradeable",
        detail: `${where}: market lookup FAILED (${res.error}) — tradeability unprovable, refusing rather than assuming. A flaky fetch costs a signal, not money.`,
      });
      continue;
    }
    if (res.market === null) {
      rejected.push({
        reason: "market_not_tradeable",
        detail: `${where}: no such market came back from the lookup — not listed or not readable, so there is nothing to send an order to`,
      });
      continue;
    }
    if (!isLive(res.market, at)) {
      rejected.push({
        reason: "market_not_live",
        detail: `${where}: not live at ${at.toISOString()} — occurrence_datetime ${res.market.occurrence_datetime ?? "MISSING"}, close_time ${res.market.close_time ?? "none"} (occurrence_datetime is the start; close_time is the SETTLEMENT window, not the final whistle)`,
      });
      continue;
    }
    if (!isTradeable(res.market)) {
      rejected.push({
        reason: "market_not_tradeable",
        detail: `${where}: nobody is offering — yes_ask_dollars ${res.market.yes_ask_dollars ?? "absent"}. An order into an empty book rests forever.`,
      });
      continue;
    }

    out.push(intent);
  }

  return { intents: out, rejected };
}
