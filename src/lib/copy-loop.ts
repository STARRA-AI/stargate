/**
 * The copy-trade loop: scan Polymarket for what persistent traders just bought,
 * find the same bet LIVE on Kalshi, and place it.
 *
 * Every limit here is a KNOB, not a rule — defaults are set wide and Classic
 * moves them. The one thing that is always on is the daily loss floor, because
 * an unattended loop with no floor cannot be stopped by anyone who is asleep.
 *
 * Placing is opt-in per call (`live: true`). Default is dry.
 */
import { promises as fs } from "fs";
import path from "path";
import { scoreTraders, fetchTrades, aggregateFills, type PolyTrade } from "./polymarket";
import {
  matchOutcome,
  isLive,
  isTradeable,
  COPY_SERIES,
  type KalshiMarketLite,
  type Match,
} from "./copy-match";
import { placeOrder, fetchShardBalances, fetchPortfolio, fetchRealisedPnl } from "./kalshi";

const BASE = "https://api.elections.kalshi.com";
const STATE = path.join(process.cwd(), "data", "copy-loop.json");

export type LoopConfig = {
  /** Traders to copy, ranked by profit BEFORE this week. */
  traders: number;
  /** Contracts per order. */
  count: number;
  /** Never pay more than this per contract. Above it, the edge is gone. */
  maxPriceDollars: number;
  /** Only copy when Kalshi is at least this much cheaper than Polymarket. */
  minEdgeDollars: number;
  /**
   * ★ CEILING on edge. A huge gap is not opportunity — it means the two venues
   * are looking at different information, and on a live game that almost always
   * means the Kalshi book has already resolved while the Polymarket fill was
   * placed earlier in the game.
   *
   * Caught live 2026-09-04: Detroit showed a "$0.51 edge" at a $0.01 ask while
   * Cleveland — the SAME GAME — sat at $1.00. The game was over. Sorting by
   * biggest edge put that lost game FIRST in the queue.
   */
  maxEdgeDollars: number;
  /** Reject near-certain books. $0.01 and $0.99 are decided outcomes, not prices. */
  minPriceDollars: number;
  /** Ignore a signal older than this — their fill must still describe this moment. */
  maxSignalAgeMinutes: number;
  /** Stop the whole loop once realised P&L for the UTC day is below this. */
  dailyLossFloorDollars: number;
  /** Don't hold more than this many open positions at once. */
  maxOpenPositions: number;
  /** Actually send orders. False = report only. */
  live: boolean;
};

export const DEFAULTS: LoopConfig = {
  traders: 5,
  count: 1,
  maxPriceDollars: 0.9,
  minEdgeDollars: 0.02,
  maxEdgeDollars: 0.15,
  minPriceDollars: 0.05,
  maxSignalAgeMinutes: 30,
  dailyLossFloorDollars: -10,
  maxOpenPositions: 10,
  live: false,
};

type State = {
  /** `${utcDay}|${ticker}` we already acted on, so a signal fires once. */
  acted: string[];
  /** Realised P&L snapshot at the start of the UTC day, to measure the floor against. */
  dayKey: string;
  startPnl: number;
  /** Explicit flag: a startPnl of exactly 0 is a legitimate value, not "unset". */
  snapshotTaken: boolean;
};

const utcDay = () => new Date().toISOString().slice(0, 10);

async function loadState(): Promise<State> {
  try {
    const raw = JSON.parse(await fs.readFile(STATE, "utf8")) as State;
    if (raw.dayKey === utcDay()) return raw;
    // New UTC day — the floor resets and yesterday's dedupe keys stop mattering.
    return { acted: [], dayKey: utcDay(), startPnl: raw.startPnl, snapshotTaken: false };
  } catch {
    return { acted: [], dayKey: utcDay(), startPnl: 0, snapshotTaken: false };
  }
}

async function saveState(s: State): Promise<void> {
  await fs.mkdir(path.dirname(STATE), { recursive: true });
  await fs.writeFile(STATE, JSON.stringify(s, null, 2));
}

async function marketsFor(series: string): Promise<KalshiMarketLite[]> {
  const res = await fetch(`${BASE}/trade-api/v2/markets?series_ticker=${series}&limit=200&status=open`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  return ((await res.json()) as { markets?: KalshiMarketLite[] }).markets ?? [];
}

export type Candidate = {
  match: Match;
  signal: PolyTrade;
  sport: string;
  edgeDollars: number;
};

/** Everything a persistent trader bought that is ALSO live and quoted on Kalshi. */
export async function scanCandidates(cfg: LoopConfig): Promise<Candidate[]> {
  const scored = await scoreTraders();
  const pool = scored.filter((t) => t.persistent).slice(0, cfg.traders);
  if (pool.length === 0) return [];

  const signals: PolyTrade[] = [];
  for (const t of pool) {
    signals.push(...aggregateFills(await fetchTrades(t.proxyWallet, 100)));
  }
  const buys = signals.filter((s) => s.side === "BUY");

  const out: Candidate[] = [];
  for (const { series, sport, matcher } of COPY_SERIES) {
    const all = await marketsFor(series);
    const live = all.filter((m) => isLive(m) && isTradeable(m));
    if (live.length === 0) continue;

    for (const sig of buys) {
      const m = matchOutcome(sig.outcome, live, matcher);
      if (!m || m.askDollars <= 0) continue;
      // Their price minus ours: positive means Kalshi is the cheaper side of
      // the same bet, which is the only reason to copy rather than just follow.
      const edge = sig.price - m.askDollars;
      out.push({ match: m, signal: sig, sport, edgeDollars: edge });
    }
  }

  // ★ Sort by PLAUSIBLE edge, not maximum edge. Anything above maxEdgeDollars
  //   is pushed to the back rather than the front, because an outsized gap is
  //   evidence the book already knows something, not evidence of a bargain.
  const plausible = (c: Candidate) =>
    c.edgeDollars >= cfg.minEdgeDollars && c.edgeDollars <= cfg.maxEdgeDollars;
  const seen = new Set<string>();
  return out
    .sort((a, b) => {
      if (plausible(a) !== plausible(b)) return plausible(a) ? -1 : 1;
      return b.edgeDollars - a.edgeDollars;
    })
    .filter((c) => (seen.has(c.match.ticker) ? false : (seen.add(c.match.ticker), true)));
}

export type LoopResult = {
  scanned: number;
  eligible: number;
  placed: { ticker: string; price: number; count: number }[];
  skipped: { ticker: string; why: string }[];
  halted?: string;
};

/** One pass. Safe to call on an interval. */
export async function runOnce(partial: Partial<LoopConfig> = {}): Promise<LoopResult> {
  const cfg = { ...DEFAULTS, ...partial };
  const state = await loadState();
  const result: LoopResult = { scanned: 0, eligible: 0, placed: [], skipped: [] };

  // ── the floor, checked BEFORE anything is placed ────────────────────────
  const port = await fetchPortfolio();
  const openNow = port.positions?.length ?? 0;

  // ★ Kalshi exposes no "P&L since T", so the day's figure is lifetime realised
  //   P&L minus a snapshot taken on the first pass of the UTC day. Reading 0
  //   here (as an earlier draft did) makes the floor compare 0 against -10 and
  //   NEVER fire — a stop that cannot trip is worse than no stop at all.
  const realised = await fetchRealisedPnl();
  if (!realised) {
    result.halted = "cannot read realised P&L — refusing to trade without a working loss floor";
    return result;
  }
  const pnlNow = realised.pnl - realised.fees;
  if (!state.snapshotTaken) {
    state.startPnl = pnlNow;
    state.snapshotTaken = true;
    await saveState(state);
  }
  const dayPnl = pnlNow - state.startPnl;
  if (dayPnl <= cfg.dailyLossFloorDollars) {
    result.halted = `daily loss floor hit (${dayPnl.toFixed(2)} <= ${cfg.dailyLossFloorDollars})`;
    return result;
  }
  if (openNow >= cfg.maxOpenPositions) {
    result.halted = `already holding ${openNow} positions (max ${cfg.maxOpenPositions})`;
    return result;
  }

  const candidates = await scanCandidates(cfg);
  result.scanned = candidates.length;

  const shards = await fetchShardBalances();
  const freeOn = (i: number) => shards?.find((s) => s.exchangeIndex === i)?.dollars ?? 0;

  for (const c of candidates) {
    const key = `${utcDay()}|${c.match.ticker}`;
    const price = c.match.askDollars;
    const notional = price * cfg.count;

    if (state.acted.includes(key)) {
      result.skipped.push({ ticker: c.match.ticker, why: "already acted today" });
      continue;
    }
    if (c.edgeDollars < cfg.minEdgeDollars) {
      result.skipped.push({
        ticker: c.match.ticker,
        why: `edge $${c.edgeDollars.toFixed(2)} < $${cfg.minEdgeDollars}`,
      });
      continue;
    }
    // ★ The one that would have bought a finished game at a penny.
    if (c.edgeDollars > cfg.maxEdgeDollars) {
      result.skipped.push({
        ticker: c.match.ticker,
        why: `edge $${c.edgeDollars.toFixed(2)} too large — the book likely already resolved`,
      });
      continue;
    }
    if (price < cfg.minPriceDollars || price > cfg.maxPriceDollars) {
      result.skipped.push({
        ticker: c.match.ticker,
        why: `ask $${price.toFixed(2)} outside $${cfg.minPriceDollars}-$${cfg.maxPriceDollars}`,
      });
      continue;
    }
    const ageMin = (Date.now() / 1000 - c.signal.timestamp) / 60;
    if (ageMin > cfg.maxSignalAgeMinutes) {
      result.skipped.push({
        ticker: c.match.ticker,
        why: `signal is ${Math.round(ageMin)}m old (max ${cfg.maxSignalAgeMinutes}m)`,
      });
      continue;
    }
    // ★ Collateral lives on the shard the MARKET settles on, not shard 0.
    if (freeOn(c.match.shard) < notional) {
      result.skipped.push({
        ticker: c.match.ticker,
        why: `shard ${c.match.shard} has $${freeOn(c.match.shard).toFixed(2)}, needs $${notional.toFixed(2)}`,
      });
      continue;
    }

    result.eligible++;
    if (!cfg.live) {
      result.skipped.push({ ticker: c.match.ticker, why: "dry run" });
      continue;
    }

    await placeOrder({ ticker: c.match.ticker, side: "bid", count: cfg.count, priceDollars: price });
    state.acted.push(key);
    await saveState(state);
    result.placed.push({ ticker: c.match.ticker, price, count: cfg.count });
  }

  return result;
}
