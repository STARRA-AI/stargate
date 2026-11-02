/**
 * The copy-trade loop: scan Polymarket for what persistent traders just bought,
 * find the same bet LIVE on Kalshi, and place it.
 *
 * Every limit here is a KNOB, not a rule — defaults are set wide and Classic
 * moves them. The one thing that is always on is the daily loss floor, because
 * an unattended loop with no floor cannot be stopped by anyone who is asleep.
 *
 * Placing is opt-in per call (`live: true`). Default is dry.
 *
 * ── TWO SIGNAL SOURCES, TWO EXECUTION VENUES (added 2026-10-04) ──────────────
 *
 * SIGNALS. `polymarket-edge` is the original lane: a persistent Polymarket
 * wallet's fill, matched to a LIVE Kalshi market that is quoting CHEAPER. It is
 * an arbitrage-flavoured bet and it needs a price gap to exist at all.
 * `kalshi-leaderboard` is the new one: a top-volume Kalshi trader's own public
 * tape, mirrored on the SAME ticker they traded. No cross-venue match, no edge
 * requirement — and no profit evidence either, because Kalshi ranks ONLY by
 * volume (turnover), which a two-sided market maker maximises by definition.
 *
 * EXECUTION. `kalshi-direct` is the original: `kalshi.placeOrder`, signed with
 * his RSA key. `dragon-tradar` routes the same decisions through his own bot's
 * agent API via `dragon-copy`, under that module's caps.
 *
 * ★ THE DEFAULT IS UNCHANGED. `sources: ["polymarket-edge"]` and
 *   `executionVenue: "kalshi-direct"` reproduce the pre-2026-10-04 behaviour
 *   exactly: the same reads in the same order, the same gates, the same
 *   `kalshi.placeOrder` call at the same point. Nothing moves under Classic
 *   unless he passes a different venue or a second source.
 *
 * ★ THE TWO EXECUTION LANES ARE MUTUALLY EXCLUSIVE, BY CONSTRUCTION.
 *   `executionVenue` is ONE enum value, not a pair of booleans, so there is no
 *   config that arms both — see `armedExecutionLanes()`, which is the thing the
 *   tests assert against. Two engines sizing against ONE bankroll is how the
 *   same $42.40 gets committed twice. On top of that, going live on the
 *   `dragon-tradar` lane REFUSES while his own Dragon Tradar scanner is
 *   `running` (`GET /bot/state`), because that scanner and this loop would be
 *   spending the same balance with no knowledge of each other — and `autoFire`
 *   was measured TRUE on 2026-10-04, so it would fire with nobody watching.
 *   This loop never sets the mode and never sets `autoFire`; it only reads them.
 *
 * ★ BOTH LANES NOW CARRY BOTH CEILINGS (added 2026-10-04). `dragon-copy` always
 *   had a per-ORDER and a per-SCAN notional cap; `kalshi-direct` had NEITHER,
 *   and its collateral read was a SNAPSHOT — `fetchShardBalances` once per pass,
 *   never reduced as orders went out — so N orders each individually affordable
 *   could commit N times the same money. At the measured $42.40 balance and his
 *   bot's own $10 `minBetCents`, the account is four minimum bets wide, which is
 *   exactly how far a per-order ceiling alone gets you. See
 *   `DIRECT_PER_ORDER_DEFAULT_CENTS`, `DIRECT_PER_SCAN_DEFAULT_CENTS` and the
 *   `committedOnShard` map inside `runOnce`.
 *
 * ★ AN UNKNOWN SEND IS TREATED AS A FILL. On the dragon lane a timeout comes
 *   back `state: "error"` with `status: 0` (src/lib/dragon-tradar.ts:153-156) and
 *   the order MAY HAVE LANDED. Those intents are recorded as acted, so the next
 *   pass does not re-fire them under a fresh `clientOrderId` and walk past his
 *   app's idempotency store. A missed copy is a cost; a double position is a
 *   loss he did not choose.
 */
import { promises as fs } from "fs";
import path from "path";
import { scoreTraders, fetchTrades, aggregateFills, type PolyTrade } from "./polymarket";
import {
  matchOutcomeGuarded,
  isLive,
  isTradeable,
  isSideTradeable,
  COPY_SERIES,
  type KalshiMarketLite,
  type Match,
  type PolyMarketKind,
} from "./copy-match";
import { placeOrder, fetchShardBalances, fetchPortfolio, fetchRealisedPnl } from "./kalshi";
import type { CopyIntent, CopyScan, Rejected } from "./copy-contracts";
import {
  fetchKalshiLeaderboard,
  fetchKalshiPublicTrades,
  resolveFill,
  type KalshiPublicTrade,
} from "./kalshi-social";
import {
  DEFAULT_SIGNAL_CONFIG,
  gatherCopyScan,
  type CopySignalConfig,
  type CopyScanDeps,
} from "./copy-signals";
import { runCopyLane, type CopyCaps, type CopyLaneRun } from "./dragon-copy";
import { readAgent, readBotState, type AgentDeps } from "./dragon-tradar";

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

  /* ── added 2026-10-04. ALL OPTIONAL, so every existing caller — and every
     existing `LoopConfig` literal — still typechecks and still behaves the way
     it did. `DEFAULTS` supplies the unchanged values. ───────────────────────── */

  /**
   * Which signal lanes run. Default `["polymarket-edge"]` — the original lane
   * alone, so the default pass is the old pass.
   */
  sources?: readonly SignalSource[];
  /**
   * Where an accepted decision is SENT. Default `"kalshi-direct"`.
   * ONE value, never a set: see the exclusivity note in the file header.
   */
  executionVenue?: ExecutionVenue;
  /** Leaderboard rows the `kalshi-leaderboard` lane reads. Server caps at 100. */
  kalshiTraderLimit?: number;
  /**
   * Gap between the per-trader tape reads on the `kalshi-leaderboard` lane.
   * Default 120ms. This is somebody else's free, undocumented, unauthenticated
   * endpoint and the walk is ~100 requests; firing them flat out is how a free
   * lane gets closed. Tests pass 0.
   */
  kalshiWalkDelayMs?: number;
  /**
   * On the `dragon-tradar` lane, going live REFUSES while his own Dragon Tradar
   * scanner reports `running: true`. Default true. Setting it false is Classic
   * saying he accepts two engines on one bankroll — it is not a thing this file
   * decides for him, and it is not a thing it does quietly.
   */
  requireDragonIdle?: boolean;
  /**
   * ★ THE kalshi-direct LANE'S OWN NOTIONAL CEILINGS, in cents. Added
   *   2026-10-04 because that lane had NONE. `fetchShardBalances` is read ONCE
   *   per pass and the old `freeOn` was a pure read of that snapshot, never
   *   reduced as orders went out — so N orders each individually affordable
   *   could commit N times the same collateral. His balance is $42.40 and his
   *   own bot's `minBetCents` is $10, four minimum bets wide, so a per-order
   *   ceiling alone cannot protect it. `dragon-copy` has had both ceilings
   *   since it was written (`COPY_LANE_DEFAULT_CENTS` / `COPY_SCAN_BANKROLL_FRACTION`,
   *   src/lib/dragon-copy.ts:91 and :101 as of 2026-10-04); this is the
   *   equivalent pair for the direct lane.
   *
   *   Both may only TIGHTEN — see `resolveDirectCaps`, where every combination
   *   is a `Math.min` against the constants, exactly as in
   *   `dragon-copy.resolveCaps`.
   */
  directPerOrderCents?: number;
  directPerScanCents?: number;
  /** Caps handed to `dragon-copy.resolveCaps`. May only TIGHTEN its ceilings. */
  copyCaps?: Partial<CopyCaps>;
  /** Injected Dragon Tradar transport, so a test never reaches the network. */
  deps?: AgentDeps;
  /** Overrides for the `kalshi-leaderboard` lane's own gates (age, band, cap). */
  signalConfig?: Partial<CopySignalConfig>;
  /**
   * Injected Kalshi-social fetchers. Supplied = ZERO requests leave this process
   * for api.elections.kalshi.com, which is how the tests stay offline.
   */
  kalshiSocialDeps?: KalshiSocialDeps;
  /**
   * Injected DIRECT-KALSHI transport and the Polymarket-edge scanner.
   *
   * This exists for one reason: the claim "the venue switch sends to
   * dragon-copy, and the default still sends to kalshi.placeOrder" is only worth
   * anything if a test can WATCH it happen. Without injection the only way to
   * exercise `runOnce` is to sign a real order with his RSA key, which is not a
   * test. Omitted in production, where every field resolves to the real
   * function — so the default path is unchanged.
   */
  io?: Partial<LoopIo>;
};

/** The network edges of `runOnce`. Replaceable in a test, real everywhere else. */
export type LoopIo = {
  fetchPortfolio: typeof fetchPortfolio;
  fetchRealisedPnl: typeof fetchRealisedPnl;
  fetchShardBalances: typeof fetchShardBalances;
  /** ★ The direct lane's SEND. The thing a test counts to prove the routing. */
  placeOrder: typeof placeOrder;
  /** The Polymarket-edge scanner, so a test can hand in candidates. */
  scanCandidates: (cfg: LoopConfig) => Promise<Candidate[]>;
  /** State persistence, so a test never writes data/copy-loop.json. */
  loadState: () => Promise<State>;
  saveState: (s: State) => Promise<void>;
};

/** Where a signal came FROM. Both may run; they do not spend, they propose. */
export type SignalSource = "polymarket-edge" | "kalshi-leaderboard";
export const SIGNAL_SOURCES: readonly SignalSource[] = ["polymarket-edge", "kalshi-leaderboard"];

/** Where an order GOES. Exactly one per pass — see `armedExecutionLanes()`. */
export type ExecutionVenue = "kalshi-direct" | "dragon-tradar";
export const EXECUTION_VENUES: readonly ExecutionVenue[] = ["kalshi-direct", "dragon-tradar"];

/**
 * $20 — the kalshi-direct lane's per-ORDER notional ceiling, in cents.
 *
 * The same number as `dragon-copy.COPY_LANE_DEFAULT_CENTS`
 * (src/lib/dragon-copy.ts:91, verified 2026-10-04) on purpose: whichever venue is
 * armed, ONE copy
 * order gets the same room. At the DEFAULT `count: 1` with
 * `maxPriceDollars: 0.9` the largest order this lane can build is 90c, so this
 * ceiling cannot bite on a default pass — it exists for the day Classic raises
 * `count`.
 */
export const DIRECT_PER_ORDER_DEFAULT_CENTS = 2_000;

/**
 * $20 — the ceiling on the TOTAL notional ONE kalshi-direct pass may commit.
 *
 * ★ THIS IS THE ONE THAT MATTERS, and it is the one brake added on 2026-10-04
 *   that CAN change a default pass. Before it, nothing stopped a scan from
 *   placing order after individually-legal order until the account was gone,
 *   because the shard snapshot never decremented. $20 of the measured $42.40 is
 *   just under half the account per pass — the same fraction
 *   `dragon-copy.COPY_SCAN_BANKROLL_FRACTION` (src/lib/dragon-copy.ts:101)
 *   applies on the other lane.
 */
export const DIRECT_PER_SCAN_DEFAULT_CENTS = 2_000;

/** The kalshi-direct lane's resolved ceilings for one pass. */
export type DirectCaps = { perOrderCents: number; perScanCents: number };

/**
 * The kalshi-direct lane's caps for this pass.
 *
 * ONE-WAY BY CONSTRUCTION. Every field is a `Math.min` against the constants
 * above, so no caller — and no env var — can make either ceiling larger, and
 * one order can never be allowed to eat more than the whole pass may commit.
 * Same rule and same direction as `dragon-copy.resolveCaps`.
 */
export function resolveDirectCaps(
  cfg: Pick<LoopConfig, "directPerOrderCents" | "directPerScanCents"> = {},
): DirectCaps {
  const tighten = (ceiling: number, requested: unknown): number =>
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? Math.min(requested, ceiling)
      : ceiling;
  const perScanCents = tighten(DIRECT_PER_SCAN_DEFAULT_CENTS, cfg.directPerScanCents);
  const perOrderCents = Math.min(
    tighten(DIRECT_PER_ORDER_DEFAULT_CENTS, cfg.directPerOrderCents),
    perScanCents,
  );
  return { perOrderCents, perScanCents };
}

/**
 * ★★★ THE DEFAULTS ARE THE PRE-2026-10-04 BEHAVIOUR, AND THAT IS DELIBERATE.
 *
 * NOTHING IN PRODUCTION ARMS THE NEW LANE, BY DESIGN. Both callers of `runOnce`
 * pass neither `sources` nor `executionVenue` — `src/lib/tools/trade-voice.ts`
 * (`spokenTrade`, which calls `runOnce({ live })`) and
 * `scripts/starra-trade-loop.ts` (its `cfg` literal sets live/traders/count/
 * minEdge/maxEdge/floor/maxOpen and nothing else). So Classic's running
 * behaviour does not move underneath him, and `copy-loop-dragon.test.ts` asserts
 * that both of those files still pass neither field.
 *
 * TO ARM SOMETHING, A CALLER HAS TO SAY SO, BY NAME:
 *
 *   the Kalshi leaderboard SOURCE   `sources: ["kalshi-leaderboard"]`
 *                                   (or `["polymarket-edge", "kalshi-leaderboard"]`
 *                                    to read both — reading is not spending)
 *   the Dragon Tradar VENUE         `executionVenue: "dragon-tradar"`
 *   spending at all                 `live: true`
 *
 * All three are independent, and `live: true` is required for ANY of it to send
 * — `armedExecutionLanes()` returns [] without it. Changing either default here
 * silently arms a lane for every existing caller; the test named
 * "DEFAULTS still name the original lane and the original venue" is what fails
 * if someone does.
 */
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
  // ★ The two fields that decide whether anything about this file behaves
  //   differently than it did before. Both are the OLD behaviour.
  sources: ["polymarket-edge"],
  executionVenue: "kalshi-direct",
  kalshiTraderLimit: 100,
  kalshiWalkDelayMs: 120,
  requireDragonIdle: true,
  directPerOrderCents: DIRECT_PER_ORDER_DEFAULT_CENTS,
  directPerScanCents: DIRECT_PER_SCAN_DEFAULT_CENTS,
};

export type LoopState = {
  /** `${utcDay}|${ticker}` we already acted on, so a signal fires once. */
  acted: string[];
  /**
   * `dragon-copy.intentKey()`s acted on, for the copy lane. A SEPARATE key
   * space from `acted`: that one is day-scoped and ticker-only, this one is
   * venue|trader|ticker|side|action and is what `planCopyBatch` dedupes on.
   * Mixing them would make a ticker we bought once un-copyable from any trader.
   */
  actedIntents?: string[];
  /** Realised P&L snapshot at the start of the UTC day, to measure the floor against. */
  dayKey: string;
  startPnl: number;
  /** Explicit flag: a startPnl of exactly 0 is a legitimate value, not "unset". */
  snapshotTaken: boolean;
};

/** Internal alias so every existing reference below reads the same as before. */
type State = LoopState;

const utcDay = () => new Date().toISOString().slice(0, 10);

async function loadState(): Promise<State> {
  try {
    const raw = JSON.parse(await fs.readFile(STATE, "utf8")) as State;
    // A state file written before `actedIntents` existed has none. Coerce it
    // here rather than at every read site, so no caller can hit `undefined`.
    if (raw.dayKey === utcDay()) return { ...raw, actedIntents: raw.actedIntents ?? [] };
    // New UTC day — the floor resets and yesterday's dedupe keys stop mattering.
    return {
      acted: [],
      actedIntents: [],
      dayKey: utcDay(),
      startPnl: raw.startPnl,
      snapshotTaken: false,
    };
  } catch {
    return { acted: [], actedIntents: [], dayKey: utcDay(), startPnl: 0, snapshotTaken: false };
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
  /**
   * The Polymarket pseudonym behind the fill, when the leaderboard gave one.
   * OPTIONAL and additive — every pre-existing reader of `Candidate` is
   * unaffected. It exists so a copy intent can name a trader in the ops feed
   * instead of a 42-character wallet address. The wallet is a PUBLIC address,
   * not a secret, so the fallback is safe; it is just unreadable out loud.
   */
  trader?: string;
};

/**
 * Refusals from the LAST scanCandidates() pass, by Polymarket market kind.
 *
 * ★ This exists so a zero-candidate scan is never mistaken for "no opportunity".
 *   Before the market-kind gate, 43.9% of sports BUY rows (316 of 719, measured
 *   2026-10-04) were non-moneyline bets that the name matcher would have copied
 *   onto the wrong Kalshi market. Those are now refused — correctly — but a
 *   refusal that nobody can see is how a whole market type goes dark quietly.
 *   `scanCandidates` has to keep returning Candidate[] for its existing callers,
 *   so the tally is published here instead of widening that return type.
 */
let lastMarketKindRefusals: { buysConsidered: number; byKind: Partial<Record<PolyMarketKind, number>> } = {
  buysConsidered: 0,
  byKind: {},
};

/**
 * Build a Polymarket -> Kalshi ticker resolver for the leaderboard copy lane.
 *
 * ★ THE WHOLE POINT: Dragon Tradar executes on KALSHI ONLY, so a Polymarket
 *   intent with ticker=null cannot be sent. The live scan on 2026-10-04 dropped
 *   15 such signals as `no_ticker`. This is what makes them executable.
 *
 * ★ IT GOES THROUGH matchOutcomeGuarded, ALWAYS. `outcome` is only ever a
 *   competitor name: a point-spread bet on "Spread: Bills (-6.5)" arrives as
 *   outcome "Patriots". Resolving that against a game-winner series would buy
 *   "Patriots win outright" — a different event, at a cheaper price that reads
 *   as edge. The guard classifies the market kind from `slug` (then `title`)
 *   and refuses anything that is not a plain moneyline.
 *
 * Markets are fetched once per series and CACHED for the life of the returned
 * resolver, so resolving 50 intents costs one pass over COPY_SERIES, not 50.
 * Any fetch failure for a series is swallowed into "no match for this series" —
 * an unresolved intent is unexecutable, never wrong.
 */
export function makeKalshiTickerResolver(opts: { now?: () => Date } = {}) {
  const cache = new Map<string, KalshiMarketLite[]>();
  return async (signal: {
    outcome: string;
    slug?: string;
    title: string;
    side?: "yes" | "no";
  }): Promise<{ ticker: string; kind?: string } | null> => {
    const now = opts.now ? opts.now() : new Date();
    for (const { series, matcher } of COPY_SERIES) {
      let live = cache.get(series);
      if (!live) {
        try {
          const all = await marketsFor(series);
          live = all.filter((m) => isLive(m, now) && isTradeable(m));
        } catch {
          live = [];
        }
        cache.set(series, live);
      }
      if (live.length === 0) continue;
      // ★ Quote the side we would actually send. isTradeable above is YES-only, so
      //   a NO-side intent could otherwise resolve onto a market with no NO offer.
      const quoted = signal.side ? live.filter((m) => isSideTradeable(m, signal.side!)) : live;
      if (quoted.length === 0) continue;
      const guarded = matchOutcomeGuarded({
        outcome: signal.outcome,
        slug: signal.slug,
        title: signal.title,
        candidates: quoted,
        matcher,
        now,
      });
      // A kind refusal is final: no other series can rescue a spread bet.
      if (!guarded.ok) {
        if (guarded.reason === "market_kind_not_copyable") return null;
        continue;
      }
      return { ticker: guarded.match.ticker, kind: "moneyline" };
    }
    return null;
  };
}

/** Read the last pass's market-kind refusals. Empty before the first scan. */
export function marketKindRefusals(): {
  buysConsidered: number;
  byKind: Partial<Record<PolyMarketKind, number>>;
  refusedTotal: number;
} {
  const byKind = { ...lastMarketKindRefusals.byKind };
  let refusedTotal = 0;
  for (const n of Object.values(byKind)) refusedTotal += n ?? 0;
  return { buysConsidered: lastMarketKindRefusals.buysConsidered, byKind, refusedTotal };
}

/** Everything a persistent trader bought that is ALSO live and quoted on Kalshi. */
export async function scanCandidates(cfg: LoopConfig): Promise<Candidate[]> {
  const scored = await scoreTraders();
  const pool = scored.filter((t) => t.persistent).slice(0, cfg.traders);
  if (pool.length === 0) {
    lastMarketKindRefusals = { buysConsidered: 0, byKind: {} };
    return [];
  }

  const signals: PolyTrade[] = [];
  // Wallet -> pseudonym, so a Candidate can name a person instead of an address.
  const nameOf = new Map<string, string>();
  for (const t of pool) {
    if (t.pseudonym) nameOf.set(t.proxyWallet, t.pseudonym);
    signals.push(...aggregateFills(await fetchTrades(t.proxyWallet, 100)));
  }
  const buys = signals.filter((s) => s.side === "BUY");

  const out: Candidate[] = [];
  /** Refusals by Polymarket market kind, so a zero-signal scan is explainable. */
  const skippedKinds: Partial<Record<PolyMarketKind, number>> = {};
  let buysConsidered = 0;
  for (const { series, sport, matcher } of COPY_SERIES) {
    const all = await marketsFor(series);
    const live = all.filter((m) => isLive(m) && isTradeable(m));
    if (live.length === 0) continue;

    for (const sig of buys) {
      buysConsidered++;
      // ★ GUARDED, and it must stay guarded. `sig.outcome` is ONLY a competitor
      //   name: a point-spread bet on "Spread: Bills (-6.5)" arrives as
      //   outcome "Patriots" (real row, #1 profit wallet, 2026-10-04). The
      //   unguarded matchOutcome would hand back the Kalshi MONEYLINE for the
      //   Patriots, and because that outright is CHEAPER than the 46c spread
      //   price, `edge` below would read as free money on a strictly worse bet.
      //   Measured exposure before this gate: 316 of 719 sports BUY rows (43.9%)
      //   were not moneylines. classifyPolyMarket reads `slug` first and falls
      //   back to `title`; on all 253 distinct markets observed that day the two
      //   signals agreed, so a row with no slug is still classified correctly.
      const guarded = matchOutcomeGuarded({
        outcome: sig.outcome,
        slug: sig.slug,
        title: sig.title,
        candidates: live,
        matcher,
      });
      if (!guarded.ok) {
        // Count every refusal by kind. A silent skip here is how a whole market
        // type goes dark without anyone noticing it stopped producing signals.
        skippedKinds[guarded.kind] = (skippedKinds[guarded.kind] ?? 0) + 1;
        continue;
      }
      const m = guarded.match;
      if (m.askDollars <= 0) continue;
      // Their price minus ours: positive means Kalshi is the cheaper side of
      // the same bet, which is the only reason to copy rather than just follow.
      const edge = sig.price - m.askDollars;
      out.push({
        match: m,
        signal: sig,
        sport,
        edgeDollars: edge,
        trader: nameOf.get(sig.wallet),
      });
    }
  }

  // ★ Sort by PLAUSIBLE edge, not maximum edge. Anything above maxEdgeDollars
  //   is pushed to the back rather than the front, because an outsized gap is
  //   evidence the book already knows something, not evidence of a bargain.
  const plausible = (c: Candidate) =>
    c.edgeDollars >= cfg.minEdgeDollars && c.edgeDollars <= cfg.maxEdgeDollars;
  lastMarketKindRefusals = { buysConsidered, byKind: skippedKinds };
  const seen = new Set<string>();
  return out
    .sort((a, b) => {
      if (plausible(a) !== plausible(b)) return plausible(a) ? -1 : 1;
      return b.edgeDollars - a.edgeDollars;
    })
    .filter((c) => (seen.has(c.match.ticker) ? false : (seen.add(c.match.ticker), true)));
}

/* ═══════════════════════════ THE VENUE SWITCH ═══════════════════════════════
 * One enum, resolved once per pass. The whole exclusivity argument lives here.
 * ═════════════════════════════════════════════════════════════════════════════ */

/** The venue this pass will use. An unrecognised value falls back to the OLD lane. */
export function executionVenueOf(cfg: Pick<LoopConfig, "executionVenue">): ExecutionVenue {
  return cfg.executionVenue === "dragon-tradar" ? "dragon-tradar" : "kalshi-direct";
}

/** The signal lanes this pass will read. An empty or unrecognised list falls back to the OLD lane. */
export function signalSourcesOf(cfg: Pick<LoopConfig, "sources">): SignalSource[] {
  const want = cfg.sources ?? ["polymarket-edge"];
  const out = SIGNAL_SOURCES.filter((s) => want.includes(s));
  return out.length > 0 ? out : ["polymarket-edge"];
}

/**
 * THE MUTUAL-EXCLUSION PROOF, as a function the tests can hold.
 *
 * An "armed" lane is one that can actually SEND an order on this pass. A dry run
 * arms NOTHING — it cannot spend, by construction, because `cfg.live` gates
 * every send site in `runOnce`. A live run arms EXACTLY ONE, because the venue
 * is a single enum value and this returns a one-element tuple built from it.
 *
 * It is written as an array on purpose: the invariant worth asserting is
 * `length <= 1`, and an array is the only shape where that assertion means
 * something. If a future change makes it possible to return two, the test that
 * says "never more than one lane is armed" fails — which is the point.
 */
export function armedExecutionLanes(
  cfg: Pick<LoopConfig, "executionVenue" | "live">,
): ExecutionVenue[] {
  if (cfg.live !== true) return [];
  return [executionVenueOf(cfg)];
}

/* ═══════════════════════ THE POLYMARKET-EDGE BRIDGE ═════════════════════════ */

/**
 * The original lane's `Candidate` as a venue-neutral `CopyIntent`.
 *
 * ALWAYS yes/buy. The pre-existing lane only ever bought YES — `placeOrder`
 * is called with `side: "bid"`, and `kalshi.ts:281` documents `bid = buy YES`.
 * Nothing here invents a short or a sell that the old lane could not express.
 *
 * `role` is "taker": the price used is `match.askDollars`, i.e. we cross the
 * book and PAY the spread. Calling that a maker fill would make `dragon-copy`'s
 * maker accounting lie about what we are doing.
 */
export function candidateToIntent(c: Candidate, cfg: LoopConfig): CopyIntent {
  const priceCents = Math.round(c.match.askDollars * 100);
  const who = c.trader ?? c.signal.wallet;
  return {
    venue: "polymarket",
    sourceTrader: who,
    ticker: c.match.ticker,
    side: "yes",
    action: "buy",
    priceCents,
    count: cfg.count,
    role: "taker",
    observedAt: new Date(c.signal.timestamp * 1000).toISOString(),
    // Confidence here is about the PRICE GAP, which is a measurable thing,
    // unlike a Kalshi volume rank. Scaled so the configured maximum plausible
    // edge reads 1.0 and anything at the minimum reads near 0.
    confidence: edgeConfidence(c.edgeDollars, cfg),
    why:
      `polymarket ${who} paid $${c.signal.price.toFixed(2)} on ${c.signal.outcome}; ` +
      `${c.match.ticker} asks $${c.match.askDollars.toFixed(2)} — $${c.edgeDollars.toFixed(2)} cheaper (${c.sport})`,
  };
}

/** 0..1 from the edge, relative to the configured plausible band. Pure. */
function edgeConfidence(edgeDollars: number, cfg: LoopConfig): number {
  const span = cfg.maxEdgeDollars - cfg.minEdgeDollars;
  if (!(span > 0)) return 0.5;
  const t = (edgeDollars - cfg.minEdgeDollars) / span;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * A `CopyIntent` as a `kalshi.placeOrder` body — or a named refusal.
 *
 * ★ THE DIRECT LANE CANNOT EXPRESS EVERY INTENT, AND IT MUST NOT PRETEND TO.
 *   `KalshiOrder` (src/lib/kalshi.ts:279-290) models only `bid` / `ask` on the
 *   YES side. A NO-side intent has no representation there, and a `sell` is a
 *   position the pre-existing loop never took. Coercing either one onto `bid`
 *   would take the OPPOSITE side of what the trader did — the same class of
 *   error as copying `taker_action` verbatim, which is the bug this whole lane
 *   exists to avoid. So anything other than yes/buy is refused BY NAME and the
 *   signal is reported, not quietly dropped and not quietly inverted.
 *
 *   The faithful route for a NO-side or a sell is the `dragon-tradar` lane:
 *   `dragon-orders.OrderIntent` carries `side` and `action` separately.
 */
export function intentToDirectKalshiOrder(
  intent: CopyIntent,
): { ok: true; ticker: string; side: "bid"; count: number; priceDollars: number } | { ok: false; why: string } {
  if (!intent.ticker) {
    return { ok: false, why: "no kalshi ticker on the intent — nothing to send direct" };
  }
  if (intent.side !== "yes" || intent.action !== "buy") {
    return {
      ok: false,
      why:
        `${intent.action} ${intent.side.toUpperCase()} is not expressible on the kalshi-direct lane ` +
        `(KalshiOrder models bid/ask on YES only) — route it through dragon-tradar`,
    };
  }
  const priceDollars = intent.priceCents / 100;
  if (!(priceDollars > 0 && priceDollars < 1)) {
    return { ok: false, why: `price ${intent.priceCents}c is outside 1-99c` };
  }
  if (!Number.isInteger(intent.count) || intent.count < 1) {
    return { ok: false, why: `count ${intent.count} is not a positive whole number` };
  }
  return { ok: true, ticker: intent.ticker, side: "bid", count: intent.count, priceDollars };
}

/* ════════════════════ THE KALSHI-LEADERBOARD SOURCE ═════════════════════════ */

/** A throttle that sleeps BEFORE every call after the first. Sequential by design. */
function throttled<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  delayMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): (...args: A) => Promise<R> {
  let first = true;
  return async (...args: A) => {
    if (!first && delayMs > 0) await sleep(delayMs);
    first = false;
    return fn(...args);
  };
}

/** The live fetchers, injectable so a test never reaches api.elections.kalshi.com. */
export type KalshiSocialDeps = CopyScanDeps<KalshiPublicTrade>["kalshi"];

export function liveKalshiSocialDeps(
  delayMs: number,
  sleep?: (ms: number) => Promise<void>,
): KalshiSocialDeps {
  return {
    leaderboard: (limit: number) => fetchKalshiLeaderboard(limit),
    // ★ Throttled, not parallel. `gatherCopyScan` walks every leaderboard row
    //   to find the ~2% whose tape is public; at 100 rows that is 100 requests
    //   to a free endpoint nobody owes us.
    trades: throttled(
      (nickname: string, pageSize: number) => fetchKalshiPublicTrades(nickname, pageSize),
      delayMs,
      sleep,
    ),
    resolveFill,
  };
}

/**
 * The new source: top-volume Kalshi traders' own public tapes, as intents.
 *
 * READ-ONLY. Nothing here sends anything anywhere.
 *
 * ★ WHAT THIS CAN AND CANNOT TELL YOU. Kalshi's only leaderboard metric is
 *   `volume` — every other value 400s from a Go `oneof` validator
 *   (src/lib/kalshi-social.ts:141-166). Volume is TURNOVER. A market maker
 *   churning both sides of one book tops it without having made a dollar. So a
 *   high rank here is evidence of ACTIVITY, not of skill, and the `why` string
 *   on every intent says so out loud rather than letting a rank read as an
 *   endorsement.
 *
 * ★ AND THE UNIVERSE IS TINY. Trade visibility is opt-in; on 2026-10-04 exactly
 *   2 of the top 100 had a readable tape, neither inside the top 50. The other
 *   98 arrive as named `trades_hidden` rejections, not as a silent zero.
 *
 * The Polymarket half of `gatherCopyScan` is deliberately NOT wired in here:
 * this file already has a Polymarket lane (`scanCandidates`), and running both
 * would count one wallet's fill twice under two different sets of gates.
 */
export async function scanKalshiLeaderboardIntents(
  cfg: LoopConfig,
  deps?: KalshiSocialDeps,
  sleep?: (ms: number) => Promise<void>,
): Promise<CopyScan> {
  const signalCfg: CopySignalConfig = {
    ...DEFAULT_SIGNAL_CONFIG,
    // The loop's own knobs win where they overlap, so one number governs the
    // whole file instead of two that can silently disagree.
    maxSignalAgeMin: cfg.maxSignalAgeMinutes,
    priceBandCents: {
      min: Math.max(1, Math.round(cfg.minPriceDollars * 100)),
      max: Math.min(99, Math.round(cfg.maxPriceDollars * 100)),
    },
    kalshiTraderLimit: cfg.kalshiTraderLimit ?? 100,
    ...(cfg.signalConfig ?? {}),
  };
  const kalshi = deps ?? liveKalshiSocialDeps(cfg.kalshiWalkDelayMs ?? 120, sleep);
  return gatherCopyScan<KalshiPublicTrade>(signalCfg, { kalshi });
}

/* ══════════════════════ THE DOUBLE-ARM GUARD (DRAGON) ═══════════════════════ */

export type DragonLaneGuard =
  | { ok: true; balanceCents: number; openCopies: number; mode: string }
  | { ok: false; detail: string };

/**
 * Before the copy lane sends ANYTHING through his bot, prove two things:
 *
 *  1. HIS OWN SCANNER IS NOT ARMED. `GET /bot/state` → `running`. If his bot is
 *     running, it is already sizing bets against the balance this lane is about
 *     to size against, and neither knows about the other. `autoFire` was
 *     measured TRUE on 2026-10-04, so his scanner does not pause for a human.
 *     Two engines, one bankroll, double-committed dollars — refused.
 *  2. THE BALANCE IS READABLE. `GET /stats` → `balanceCents`. A lane that
 *     cannot read the money refuses to spend it; an unknown balance is not zero
 *     and it is not "unlimited" either.
 *
 * ONE ATTEMPT EACH, NO RETRY, AND /stats IS NOT SENT IF /bot/state FAILED.
 * A single bad token makes this API answer 429 temporarily_blocked and locks
 * Classic out of his own bot (src/lib/dragon-tradar.ts:18-25), so a failed first
 * read is a reason to stop asking, not a reason to ask again.
 *
 * It READS ONLY. Nothing here starts, stops, or reconfigures his bot.
 */
export async function guardDragonLane(
  deps: AgentDeps = {},
  requireIdle = true,
): Promise<DragonLaneGuard> {
  // 20s rather than `agentRequest`'s 10s default; a caller's own value wins.
  // This is headroom, not a diagnosis: on 2026-10-04 this endpoint returned
  // `status: 0` ("no HTTP response") inside a process that had just made ~150
  // HTTPS requests elsewhere, while DNS resolved, TCP 443 connected, and a fresh
  // process read the same endpoint in 263ms. The mechanism is UNKNOWN and it is
  // NOT a cold start. The extra headroom costs nothing and removes the timeout
  // from the list of possible causes; this function still makes ONE attempt and
  // halts the lane on anything that is not "ok", which is the safe direction.
  const d: AgentDeps = { timeoutMs: 20_000, ...deps };
  const st = await readBotState(d);
  if (st.state !== "ok") {
    const extra = st.state === "error" ? ` status=${st.status}${st.code ? ` code=${st.code}` : ""}` : "";
    return {
      ok: false,
      detail: `dragon-tradar: GET /bot/state came back ${st.state}${extra} — refusing to route orders through a bot whose state I cannot read`,
    };
  }
  const mode = typeof st.stats.mode === "string" ? st.stats.mode : "";
  if (requireIdle && st.stats.running === true) {
    const autoFire = (st.stats.config ?? {})["autoFire"];
    return {
      ok: false,
      detail:
        `dragon-tradar: his own scanner is RUNNING (category=${st.stats.category || "?"}, mode=${mode || "?"}` +
        `, autoFire=${String(autoFire)}) — two engines sizing against one bankroll can commit the same dollars twice. ` +
        `Stop his bot, or pass requireDragonIdle:false to accept that.`,
    };
  }

  const stats = await readAgent(d);
  if (stats.state !== "ok") {
    const extra =
      stats.state === "error" ? ` status=${stats.status}${stats.code ? ` code=${stats.code}` : ""}` : "";
    return {
      ok: false,
      detail: `dragon-tradar: GET /stats came back ${stats.state}${extra} — refusing to size orders against a balance I cannot read`,
    };
  }
  return {
    ok: true,
    balanceCents: stats.stats.balanceCents,
    openCopies: stats.stats.positions.length,
    mode,
  };
}

export type LoopResult = {
  scanned: number;
  eligible: number;
  placed: { ticker: string; price: number; count: number }[];
  skipped: { ticker: string; why: string }[];
  halted?: string;
  /* ── added 2026-10-04, all optional: nothing that read a LoopResult before
     needs to change, and the default pass leaves `copy` undefined. ─────────── */
  /** Which venue actually ran. */
  venue?: ExecutionVenue;
  /** Which signal lanes actually ran. */
  sources?: SignalSource[];
  /** The `kalshi-leaderboard` lane's own bookkeeping, when that lane ran. */
  leaderboard?: { intents: number; rejected: Rejected[]; checked: CopyScan["checked"] };
  /** The dragon lane's plan + submission, when that venue ran. */
  copy?: CopyLaneRun;
};

/**
 * One pass. Safe to call on an interval.
 *
 * ★ THE DEFAULT PASS IS THE OLD PASS. With no overrides the venue is
 *   `kalshi-direct` and the only source is `polymarket-edge`, so the reads, the
 *   gates and the `placeOrder` call all happen exactly where they did before.
 *   Every branch added on 2026-10-04 is behind a config value Classic has to
 *   set, and `armedExecutionLanes()` is the assertion that only one of them can
 *   ever be spending.
 */
export async function runOnce(partial: Partial<LoopConfig> = {}): Promise<LoopResult> {
  const cfg = { ...DEFAULTS, ...partial };
  const venue = executionVenueOf(cfg);
  const sources = signalSourcesOf(cfg);
  // Every edge resolves to the REAL function unless a caller replaced it. The
  // production path therefore calls exactly what it called before.
  const io: LoopIo = {
    fetchPortfolio,
    fetchRealisedPnl,
    fetchShardBalances,
    placeOrder,
    scanCandidates,
    loadState,
    saveState,
    ...(cfg.io ?? {}),
  };
  const state = await io.loadState();
  /**
   * `${utcDay()}|${ticker}` keys this pass may not take again.
   *
   * ★ IT APPLIES ON BOTH LANES. It is seeded from the persisted `state.acted`
   *   and added to as the pass runs, so one ticker is taken ONCE per UTC day
   *   whichever venue is armed. Until 2026-10-04 only the two kalshi-direct
   *   branches consulted and wrote `state.acted`: the dragon branch wrote only
   *   `state.actedIntents` (venue|trader|ticker|side|action), so two different
   *   traders signalling the same ticker on the same day both fired.
   *
   *   The in-memory set, not `state.acted` itself, is what the dragon lane
   *   claims against at QUEUE time — queueing is not placing, and a ticker that
   *   `planCopyBatch` then rejects must not be burned for the rest of the day in
   *   the persisted file.
   */
  const claimedToday = new Set<string>(state.acted);
  const result: LoopResult = {
    scanned: 0,
    eligible: 0,
    placed: [],
    skipped: [],
    venue,
    sources,
  };

  // ── the floor, checked BEFORE anything is placed ────────────────────────
  const port = await io.fetchPortfolio();
  const openNow = port.positions?.length ?? 0;

  // ★ Kalshi exposes no "P&L since T", so the day's figure is lifetime realised
  //   P&L minus a snapshot taken on the first pass of the UTC day. Reading 0
  //   here (as an earlier draft did) makes the floor compare 0 against -10 and
  //   NEVER fire — a stop that cannot trip is worse than no stop at all.
  const realised = await io.fetchRealisedPnl();
  if (!realised) {
    result.halted = "cannot read realised P&L — refusing to trade without a working loss floor";
    return result;
  }
  const pnlNow = realised.pnl - realised.fees;
  if (!state.snapshotTaken) {
    state.startPnl = pnlNow;
    state.snapshotTaken = true;
    await io.saveState(state);
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

  // ── the double-arm guard, BEFORE any signal is read ──────────────────────
  // Only on the dragon lane, and only when this pass can actually spend. A dry
  // run touches dragontradar.com ZERO times: one bad token there answers 429 and
  // locks him out of his own bot, so a report-only pass has no business asking.
  let dragonBalanceCents: number | undefined;
  let dragonOpenCopies = openNow;
  if (venue === "dragon-tradar" && cfg.live) {
    const guard = await guardDragonLane(cfg.deps ?? {}, cfg.requireDragonIdle !== false);
    if (!guard.ok) {
      result.halted = guard.detail;
      return result;
    }
    dragonBalanceCents = guard.balanceCents;
    dragonOpenCopies = guard.openCopies;
  }

  const candidates = sources.includes("polymarket-edge") ? await io.scanCandidates(cfg) : [];
  result.scanned = candidates.length;

  // Shard collateral is a KALSHI-DIRECT fact: it is the money his RSA key spends.
  // The dragon lane spends what Dragon Tradar reports, so it is sized by
  // `dragon-copy`'s caps against `balanceCents` instead, and this read is not
  // made — a failed read of an account we are not spending from must not be able
  // to block a lane that is otherwise fine.
  const shards = venue === "kalshi-direct" ? await io.fetchShardBalances() : null;

  /** Collateral THIS PASS has already committed, per shard, in dollars. */
  const committedOnShard = new Map<number, number>();
  /**
   * ★ FREE, NOT SNAPSHOT. `shards` is fetched ONCE per pass; before 2026-10-04
   *   this was a pure read of that snapshot and nothing ever reduced it, so a
   *   pass could place N orders each individually affordable and commit N times
   *   the same money. Every accepted order now subtracts from the shard it
   *   settles on. It can go negative, and a negative free balance blocks the
   *   next order exactly as a small one does.
   */
  const freeOn = (i: number) =>
    (shards?.find((s) => s.exchangeIndex === i)?.dollars ?? 0) - (committedOnShard.get(i) ?? 0);
  const commitShard = (i: number, dollars: number) =>
    committedOnShard.set(i, (committedOnShard.get(i) ?? 0) + dollars);

  /**
   * The kalshi-direct lane's ceilings and the running total measured against
   * them. `dragon-copy` enforces its own pair on the other lane
   * (`CopyCaps.perOrderCents` / `perScanCents`); these are this lane's.
   */
  const directCaps = resolveDirectCaps(cfg);
  let directCommittedCents = 0;

  /** Intents bound for the dragon lane, collected and sent as ONE batch. */
  const queued: CopyIntent[] = [];

  for (const c of candidates) {
    const key = `${utcDay()}|${c.match.ticker}`;
    const price = c.match.askDollars;
    const notional = price * cfg.count;
    // Kalshi prices in whole cents, so the notional a cap is compared against is
    // integer cents — never a float dollar product that can land on 17.999999.
    const orderCents = Math.round(price * 100) * cfg.count;

    if (claimedToday.has(key)) {
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
    // ★ A SINGLE ORDER'S CEILING. Direct lane only — the dragon lane is sized by
    //   `dragon-copy`'s own `perOrderCents` and must not be double-capped here.
    if (venue === "kalshi-direct" && orderCents > directCaps.perOrderCents) {
      result.skipped.push({
        ticker: c.match.ticker,
        why: `order ${orderCents}c is over the ${directCaps.perOrderCents}c per-order cap`,
      });
      continue;
    }
    // ★ Collateral lives on the shard the MARKET settles on, not shard 0.
    //   Kalshi-direct only — see the note on the `shards` read above.
    if (venue === "kalshi-direct" && freeOn(c.match.shard) < notional) {
      result.skipped.push({
        ticker: c.match.ticker,
        why: `shard ${c.match.shard} has $${freeOn(c.match.shard).toFixed(2)}, needs $${notional.toFixed(2)}`,
      });
      continue;
    }
    // ★ THE PASS TOTAL. This is the cap that actually protects $42.40: four
    //   individually-legal $10 orders is the whole account. It does NOT `break`
    //   — a cheaper candidate behind an expensive one is still affordable and
    //   still legal, same choice `dragon-copy.planCopyBatch` makes.
    if (venue === "kalshi-direct" && directCommittedCents + orderCents > directCaps.perScanCents) {
      result.skipped.push({
        ticker: c.match.ticker,
        why:
          `order ${orderCents}c would put this pass past its ${directCaps.perScanCents}c budget ` +
          `(${directCommittedCents}c already committed)`,
      });
      continue;
    }

    result.eligible++;

    // Committed at PLAN time, dry or live, so a dry pass is a faithful preview
    // of what a live pass would spend rather than a longer list he cannot have.
    if (venue === "kalshi-direct") {
      commitShard(c.match.shard, notional);
      directCommittedCents += orderCents;
    }

    // ── THE VENUE SWITCH. Exactly one of these two branches runs per pass. ──
    if (venue === "dragon-tradar") {
      // Queued, not sent: `dragon-copy` enforces a PER-SCAN notional ceiling,
      // which only means anything if the whole scan is planned at once. The
      // dry/live decision is made there, once, for the whole batch.
      // The day|ticker guard applies here too — claimed in memory only, since
      // queueing is not placing (see `claimedToday`).
      claimedToday.add(key);
      queued.push(candidateToIntent(c, cfg));
      continue;
    }

    if (!cfg.live) {
      result.skipped.push({ ticker: c.match.ticker, why: "dry run" });
      continue;
    }

    await io.placeOrder({ ticker: c.match.ticker, side: "bid", count: cfg.count, priceDollars: price });
    state.acted.push(key);
    claimedToday.add(key);
    await io.saveState(state);
    result.placed.push({ ticker: c.match.ticker, price, count: cfg.count });
  }

  /* ── the kalshi-leaderboard source ──────────────────────────────────────── */
  if (sources.includes("kalshi-leaderboard")) {
    const scan = await scanKalshiLeaderboardIntents(cfg, cfg.kalshiSocialDeps);
    result.leaderboard = {
      intents: scan.intents.length,
      rejected: scan.rejected,
      checked: scan.checked,
    };
    result.scanned += scan.intents.length;

    for (const intent of scan.intents) {
      if (venue === "dragon-tradar") {
        // ★ THE day|ticker GUARD APPLIES ON THIS LANE TOO. Until 2026-10-04 it
        //   did not: the direct branch below has always consulted `state.acted`,
        //   this branch consulted nothing, so two different leaderboard traders
        //   signalling the SAME ticker on the same day both queued and both
        //   fired — `intentKey` does not dedupe them because the trader name is
        //   part of it. An unmatched intent (ticker null) is still queued so
        //   `planCopyBatch` can report it as `no_ticker` rather than vanish.
        const dayKey = intent.ticker ? `${utcDay()}|${intent.ticker}` : null;
        if (dayKey && claimedToday.has(dayKey)) {
          result.skipped.push({ ticker: intent.ticker ?? "-", why: "already acted today" });
          continue;
        }
        if (dayKey) claimedToday.add(dayKey);
        result.eligible++;
        queued.push(intent);
        continue;
      }

      // kalshi-direct. Most leaderboard intents are NOT expressible here — see
      // intentToDirectKalshiOrder. Named refusal, never a coerced side.
      const built = intentToDirectKalshiOrder(intent);
      if (!built.ok) {
        result.skipped.push({ ticker: intent.ticker ?? "-", why: built.why });
        continue;
      }
      const key = `${utcDay()}|${built.ticker}`;
      if (claimedToday.has(key)) {
        result.skipped.push({ ticker: built.ticker, why: "already acted today" });
        continue;
      }
      const orderCents = Math.round(built.priceDollars * 100) * built.count;
      if (orderCents > directCaps.perOrderCents) {
        result.skipped.push({
          ticker: built.ticker,
          why: `order ${orderCents}c is over the ${directCaps.perOrderCents}c per-order cap`,
        });
        continue;
      }
      // The leaderboard lane has no `Match`, so no shard index — shard 0 is the
      // only balance we can name. `freeOn` treats a FAILED shard read as 0 (and
      // then subtracts whatever this pass already committed, so it can only go
      // further negative), which blocks here exactly as in the candidate loop. An earlier draft of this guarded with `&& shards !== null`,
      // which inverted it: a failed read would have let the order through with
      // no collateral check at all. Unknown money is not available money.
      const need = built.priceDollars * built.count;
      if (freeOn(0) < need) {
        result.skipped.push({
          ticker: built.ticker,
          why:
            shards === null
              ? `cannot read shard balances — refusing to send without a collateral check (needs $${need.toFixed(2)})`
              : `default shard has $${freeOn(0).toFixed(2)}, needs $${need.toFixed(2)}`,
        });
        continue;
      }
      // ★ The SAME pass-total budget the candidate loop above spends from. One
      //   accumulator for the whole pass, so two sources cannot each spend it.
      if (directCommittedCents + orderCents > directCaps.perScanCents) {
        result.skipped.push({
          ticker: built.ticker,
          why:
            `order ${orderCents}c would put this pass past its ${directCaps.perScanCents}c budget ` +
            `(${directCommittedCents}c already committed)`,
        });
        continue;
      }
      result.eligible++;
      commitShard(0, need);
      directCommittedCents += orderCents;
      if (!cfg.live) {
        result.skipped.push({ ticker: built.ticker, why: "dry run" });
        continue;
      }
      await io.placeOrder({
        ticker: built.ticker,
        side: built.side,
        count: built.count,
        priceDollars: built.priceDollars,
      });
      state.acted.push(key);
      claimedToday.add(key);
      await io.saveState(state);
      result.placed.push({ ticker: built.ticker, price: built.priceDollars, count: built.count });
    }
  }

  /* ── the dragon lane, as ONE batch under one set of caps ─────────────────── */
  if (venue === "dragon-tradar") {
    const run = await runCopyLane({
      intents: queued,
      state: {
        openCopies: dragonOpenCopies,
        nowMs: Date.now(),
        alreadyActed: state.actedIntents ?? [],
      },
      caller: cfg.copyCaps,
      balanceCents: dragonBalanceCents,
      deps: cfg.deps,
      live: cfg.live === true,
    });
    result.copy = run;

    /**
     * Mark an intent as acted on — BOTH key spaces, which is the fix for the two
     * gaps this lane had.
     *
     * `actedIntents` is venue|trader|ticker|side|action, what `planCopyBatch`
     * dedupes on across scans. `acted` is `${utcDay()}|${ticker}`, the
     * per-ticker-per-day guard the two kalshi-direct branches have always
     * written and this lane never did — without it two different traders
     * signalling the same ticker on the same day both fire.
     */
    let stateDirty = false;
    const recordActed = (clientOrderId: string, ticker: string) => {
      const prov = run.plan.provenance[clientOrderId];
      const intents = (state.actedIntents ??= []);
      if (prov && !intents.includes(prov.intentKey)) intents.push(prov.intentKey);
      const dayKey = `${utcDay()}|${ticker}`;
      if (!state.acted.includes(dayKey)) state.acted.push(dayKey);
      claimedToday.add(dayKey);
      stateDirty = true;
    };

    for (const o of run.submission.outcomes) {
      const price = o.body.priceCents / 100;
      if (o.disposition === "sent" && o.result.state === "ok") {
        result.placed.push({ ticker: o.body.ticker, price, count: o.body.count });
        recordActed(o.clientOrderId, o.body.ticker);
      } else if (o.disposition === "sent" && o.result.state === "error") {
        // ★★★ AMBIGUOUS vs DETERMINISTIC — and ONLY the ambiguous half is burned.
        //
        //   AMBIGUOUS: `status: 0` is a timeout or dropped connection
        //   (src/lib/dragon-tradar.ts:153-156) and an order that timed out MAY
        //   ALREADY HAVE LANDED; a 5xx is the same kind of unknown. Recording
        //   only successes meant the next pass re-fired that intent under a NEW
        //   clientOrderId, walking straight past his app's idempotency store and
        //   turning one signal into two positions. So an unknown IS recorded as
        //   acted: the safe failure is a missed copy, never a double position.
        //
        //   DETERMINISTIC: a 4xx business refusal is his app saying it did NOT
        //   place the order — 409 agent/live trading disabled, 422 too large or
        //   insufficient balance, 423 daily loss floor, 400 malformed (the status
        //   map is in docs/handoff/dragon-tradar-agent-router/README.md). Burning
        //   those would kill the intent for the rest of the UTC day over a
        //   condition that may clear in a minute — a toggle he flips back on, a
        //   balance that tops up. That is a silent lane-killer, not safety.
        //   NOTE 401/403 are the TOKEN, never a business refusal, and they halt
        //   the batch upstream in dragon-copy rather than reaching here.
        const status = o.result.status;
        const deterministic = status >= 400 && status < 500;
        if (deterministic) {
          result.skipped.push({
            ticker: o.body.ticker,
            why:
              `dragon-tradar REFUSED status=${status}${o.result.code ? ` code=${o.result.code}` : ""} — ` +
              `his app says it did NOT place this order, so the intent is left OPEN and may retry ` +
              `once the condition clears. Nothing to check on the position.`,
          });
        } else {
          recordActed(o.clientOrderId, o.body.ticker);
          result.skipped.push({
            ticker: o.body.ticker,
            why:
              `dragon-tradar error status=${status}${o.result.code ? ` code=${o.result.code}` : ""} — ` +
              `UNKNOWN whether it landed, so it is recorded as acted and will NOT be re-sent. Check the position.`,
          });
        }
      } else if (o.disposition === "sent") {
        // `blocked` (429), `rejected` (401/403) and `off` (no token, no request
        // made) are NOT unknown: his app refused before any order existed, so
        // nothing can have landed and the intent stays eligible next pass.
        result.skipped.push({ ticker: o.body.ticker, why: `dragon-tradar ${o.result.state}` });
      } else if (o.disposition === "unsent") {
        result.skipped.push({ ticker: o.body.ticker, why: `unsent — ${o.reason}` });
      } else {
        result.skipped.push({ ticker: o.body.ticker, why: "dry run (dragon-tradar plan)" });
      }
    }
    for (const r of run.plan.rejected) {
      result.skipped.push({ ticker: "-", why: `${r.reason}: ${r.detail}` });
    }
    if (run.clearance && !run.clearance.ok) {
      result.halted = `dragon-tradar refused the lane — ${run.clearance.detail}`;
    }
    // ★ Saved when ANYTHING was recorded, not only on a success. Gating this on
    //   `placed.length` meant a pass whose only outcome was a timeout recorded
    //   the intent in memory and then threw the record away, which is exactly
    //   the case the record exists for.
    if (stateDirty) await io.saveState(state);
  }

  return result;
}
