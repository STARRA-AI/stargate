/**
 * COPY SIGNALS — the tests that stand between "a top trader did something" and
 * an order that loses Classic money.
 *
 * ZERO network. Every fetcher is injected, so nothing here can reach
 * api.elections.kalshi.com, lb-api.polymarket.com or dragontradar.com. One
 * stray request to Dragon Tradar's agent API answers a bad token with a 429
 * that locks him out of his own bot, so a test that touches the network is a
 * defect even when it passes.
 *
 * The properties that are load-bearing, each failing loudly below:
 *   1. a maker fill is NOT copied by default — mirroring a spread-collecting
 *      fill with a market order inverts the economics (77-91% of the readable
 *      Kalshi fills are maker fills, so this one decides most of the tape);
 *   2. EVERY drop is a named reason — a zero-intent scan can always explain
 *      itself, and `checked` proves the fetchers ran;
 *   3. twelve same-second clips are ONE order, not twelve — on a $42.40
 *      balance twelve mirrors of one trader's order is the whole account;
 *   4. the ranking is a total order, so it cannot depend on the order the
 *      fetchers happened to return.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SIGNAL_CONFIG,
  KALSHI_LEADERBOARD_MAX,
  MARKET_GATE_REJECTIONS,
  POLY_LEADERBOARD_MAX,
  SIGNAL_REJECTIONS,
  classifyUnresolvedRow,
  dedupeIntents,
  gateMarketLiveness,
  gatherCopyScan,
  kalshiFillsToIntents,
  polyTradesToIntents,
  rankIntents,
  type CopyScanDeps,
  type CopySignalConfig,
  type KalshiLeaderLite,
  type KalshiPublicTradeLite,
  type PolyFill,
  type PolyTraderRef,
} from "../src/lib/copy-signals";
import type { CopyIntent, CopyRejection, TraderFill } from "../src/lib/copy-contracts";
// Type-only, so it is erased at runtime and this file still makes no network
// call. It is here so a field rename in Division 1's module breaks the gate
// instead of breaking the lane in front of Classic.
import type { KalshiPublicTrade } from "../src/lib/kalshi-social";

/** A fixed clock. Every age in this file is relative to it. */
const T0 = Date.parse("2026-10-04T18:00:00.000Z");
const ago = (ms: number) => new Date(T0 - ms).toISOString();
const MIN = 60_000;

const cfg = (over: Partial<CopySignalConfig> = {}): CopySignalConfig => ({
  ...DEFAULT_SIGNAL_CONFIG,
  ...over,
});

function fill(over: Partial<TraderFill> = {}): TraderFill {
  return {
    tradeId: "trade-1",
    marketKey: "KXBTCD-26OCT04-T62000",
    side: "yes",
    action: "buy",
    priceCents: 34,
    count: 10,
    role: "taker",
    observedAt: ago(30_000),
    ...over,
  };
}

function intent(over: Partial<CopyIntent> = {}): CopyIntent {
  return {
    venue: "kalshi",
    sourceTrader: "szg.szg",
    ticker: "KXBTCD-26OCT04-T62000",
    side: "yes",
    action: "buy",
    priceCents: 34,
    count: 5,
    role: "taker",
    observedAt: ago(30_000),
    confidence: 0.32,
    why: "fixture",
    ...over,
  };
}

function polyFill(over: Partial<PolyFill> = {}): PolyFill {
  return {
    side: "BUY",
    outcome: "Yes",
    title: "Will BTC close above $62,000 on Oct 4?",
    price: 0.47,
    size: 120,
    timestamp: Math.floor((T0 - 30_000) / 1000),
    conditionId: "0xcond1",
    ...over,
  };
}

function polyTrader(over: Partial<PolyTraderRef> = {}): PolyTraderRef {
  return {
    pseudonym: "Cold-Snack",
    proxyWallet: "0x1111111111111111111111111111111111111111",
    rank: 3,
    profit7d: 150_000,
    priorWeeks: 42_000,
    ...over,
  };
}

const reasonsOf = (r: { reason: CopyRejection }[]) => r.map((x) => x.reason);

/** The real maker/taker resolution rule, as src/lib/kalshi-social.ts owns it. */
function resolveFillStub(row: KalshiPublicTradeLite, nickname: string): TraderFill | null {
  const base = {
    tradeId: row.tradeId,
    marketKey: row.ticker,
    priceCents: row.priceCents,
    count: row.count,
    observedAt: row.createDate,
  };
  if (row.makerNickname === nickname) {
    // Maker keeps the side, flips the action: a taker selling NO moves NO
    // contracts to the maker, so the maker BOUGHT NO.
    return {
      ...base,
      side: row.takerSide,
      action: row.takerAction === "buy" ? "sell" : "buy",
      role: "maker",
    };
  }
  if (row.takerNickname === nickname) {
    return { ...base, side: row.takerSide, action: row.takerAction, role: "taker" };
  }
  return null;
}

function kalshiRow(over: Partial<KalshiPublicTradeLite> = {}): KalshiPublicTradeLite {
  return {
    tradeId: "k-1",
    marketId: "m-1",
    ticker: "KXBTCD-26OCT04-T62000",
    priceCents: 34,
    priceDollars: "0.34",
    count: 10,
    takerSide: "yes",
    takerAction: "buy",
    makerNickname: "",
    takerNickname: "szg.szg",
    createDate: ago(30_000),
    ...over,
  };
}

function leaderboard(n: number): KalshiLeaderLite[] {
  return Array.from({ length: n }, (_, i) => ({
    nickname: `trader${i + 1}`,
    socialId: `social-${i + 1}`,
    value: 2_000_000 - i * 10_000,
    rank: i + 1,
    isAnonymous: false,
  }));
}

/* ───────────────────────────── config sanity ───────────────────────────── */

describe("DEFAULT_SIGNAL_CONFIG", () => {
  it("defaults includeMakerFills to FALSE — the maker-economics landmine", () => {
    assert.equal(DEFAULT_SIGNAL_CONFIG.includeMakerFills, false);
  });

  it("keeps a perishable signal window and a band that excludes 1c/99c", () => {
    assert.equal(DEFAULT_SIGNAL_CONFIG.maxSignalAgeMin, 10);
    assert.equal(DEFAULT_SIGNAL_CONFIG.priceBandCents.min, 2);
    assert.equal(DEFAULT_SIGNAL_CONFIG.priceBandCents.max, 98);
  });

  it("does not ask either venue for more rows than the measured server cap", () => {
    assert.equal(KALSHI_LEADERBOARD_MAX, 100);
    assert.equal(POLY_LEADERBOARD_MAX, 50);
    assert.ok(DEFAULT_SIGNAL_CONFIG.kalshiTraderLimit <= KALSHI_LEADERBOARD_MAX);
    assert.ok(DEFAULT_SIGNAL_CONFIG.polyTraderLimit <= POLY_LEADERBOARD_MAX);
  });
});

/* ──────────────────────────── the maker gate ──────────────────────────── */

describe("maker fills", () => {
  it("rejects a maker fill by default, naming maker_fill_unmirrorable", () => {
    const out = kalshiFillsToIntents("szg.szg", [fill({ role: "maker" })], cfg(), T0);
    assert.equal(out.intents.length, 0);
    assert.deepEqual(reasonsOf(out.rejected), ["maker_fill_unmirrorable"]);
    assert.match(out.rejected[0].detail, /COLLECTED the spread/);
  });

  it("admits the same fill when includeMakerFills is true, at a lower confidence", () => {
    const f = fill({ role: "maker" });
    // ★ minConfidence 0.2 here on purpose. szg.szg is volume rank 87, so a MAKER
    //   fill of theirs scores 0.221 and the shipped 0.25 floor refuses it — see
    //   the dedicated test for that interaction below. This test is about the
    //   maker gate and the relative confidence, so it lowers the floor out of the
    //   way rather than quietly passing for the wrong reason.
    const on = kalshiFillsToIntents(
      "szg.szg",
      [f],
      cfg({ includeMakerFills: true, minConfidence: 0.2 }),
      T0,
      { rank: 87, volumeDollars: 865_901 },
    );
    const taker = kalshiFillsToIntents("szg.szg", [fill()], cfg(), T0, {
      rank: 87,
      volumeDollars: 865_901,
    });
    assert.equal(on.rejected.length, 0);
    assert.equal(on.intents.length, 1);
    assert.equal(on.intents[0].role, "maker");
    assert.ok(
      on.intents[0].confidence < taker.intents[0].confidence,
      "a maker mirror must score below a taker mirror",
    );
    assert.match(on.intents[0].why, /MAKER FILL/);
  });

  it("never scores a Kalshi signal above 0.45 — volume rank is turnover, not skill", () => {
    const best = kalshiFillsToIntents("whoever", [fill()], cfg(), T0, {
      rank: 1,
      volumeDollars: 99_000_000,
    });
    assert.ok(best.intents[0].confidence <= 0.45, `got ${best.intents[0].confidence}`);
    assert.match(best.intents[0].why, /volume rank 1/);
    assert.match(best.intents[0].why, /turnover, not skill/);
    assert.match(best.intents[0].why, /taker/);
  });
});

/* ───────────────────────────── the age gate ───────────────────────────── */

describe("stale signals", () => {
  it("rejects a fill EXACTLY maxSignalAgeMin old (inclusive boundary)", () => {
    const out = kalshiFillsToIntents("szg.szg", [fill({ observedAt: ago(10 * MIN) })], cfg(), T0);
    assert.equal(out.intents.length, 0);
    assert.deepEqual(reasonsOf(out.rejected), ["stale_signal"]);
  });

  it("rejects one second past the boundary", () => {
    const out = kalshiFillsToIntents(
      "szg.szg",
      [fill({ observedAt: ago(10 * MIN + 1000) })],
      cfg(),
      T0,
    );
    assert.deepEqual(reasonsOf(out.rejected), ["stale_signal"]);
  });

  it("admits one second inside the boundary", () => {
    const out = kalshiFillsToIntents(
      "szg.szg",
      [fill({ observedAt: ago(10 * MIN - 1000) })],
      cfg(),
      T0,
    );
    assert.equal(out.rejected.length, 0);
    assert.equal(out.intents.length, 1);
  });

  it("rejects an unparseable and a future-dated timestamp instead of treating them as fresh", () => {
    const bad = kalshiFillsToIntents("szg.szg", [fill({ observedAt: "not a date" })], cfg(), T0);
    assert.deepEqual(reasonsOf(bad.rejected), ["stale_signal"]);
    const future = kalshiFillsToIntents("szg.szg", [fill({ observedAt: ago(-10 * MIN) })], cfg(), T0);
    assert.deepEqual(reasonsOf(future.rejected), ["stale_signal"]);
    assert.match(future.rejected[0].detail, /FUTURE/);
  });
});

/* ──────────────────────────── the price band ──────────────────────────── */

describe("price band", () => {
  it("rejects 1c and 99c — decided outcomes, no edge and no exit", () => {
    for (const priceCents of [1, 99]) {
      const out = kalshiFillsToIntents("szg.szg", [fill({ priceCents })], cfg(), T0);
      assert.equal(out.intents.length, 0, `${priceCents}c should be rejected`);
      assert.deepEqual(reasonsOf(out.rejected), ["price_out_of_band"]);
    }
  });

  it("admits 2c and 98c", () => {
    for (const priceCents of [2, 98]) {
      const out = kalshiFillsToIntents("szg.szg", [fill({ priceCents })], cfg(), T0);
      assert.equal(out.rejected.length, 0, `${priceCents}c should be admitted`);
      assert.equal(out.intents[0].priceCents, priceCents);
    }
  });

  it("rejects a sub-minimum or non-integer count as below_min_count", () => {
    const zero = kalshiFillsToIntents("szg.szg", [fill({ count: 0 })], cfg(), T0);
    assert.deepEqual(reasonsOf(zero.rejected), ["below_min_count"]);
    const frac = kalshiFillsToIntents("szg.szg", [fill({ count: 2.5 })], cfg(), T0);
    assert.deepEqual(reasonsOf(frac.rejected), ["below_min_count"]);
    const under = kalshiFillsToIntents("szg.szg", [fill({ count: 3 })], cfg({ minCount: 5 }), T0);
    assert.deepEqual(reasonsOf(under.rejected), ["below_min_count"]);
  });
});

/* ───────────────────────── the per-trader cap ─────────────────────────── */

describe("maxIntentsPerTrader", () => {
  it("keeps the FRESHEST fills and names every overflow drop", () => {
    const fills = [50_000, 10_000, 30_000, 20_000, 40_000].map((age, i) =>
      fill({ tradeId: `t-${i}`, observedAt: ago(age) }),
    );
    const out = kalshiFillsToIntents("szg.szg", fills, cfg({ maxIntentsPerTrader: 2 }), T0);
    assert.equal(out.intents.length, 2);
    assert.deepEqual(
      out.intents.map((i) => i.observedAt),
      [ago(10_000), ago(20_000)],
    );
    assert.deepEqual(reasonsOf(out.rejected), [
      "duplicate_intent",
      "duplicate_intent",
      "duplicate_intent",
    ]);
    assert.match(out.rejected[0].detail, /PER-TRADER CAP/);
  });

  it("does not mutate the caller's fill array", () => {
    const fills = [fill({ tradeId: "a", observedAt: ago(40_000) }), fill({ tradeId: "b" })];
    const before = fills.map((f) => f.tradeId);
    kalshiFillsToIntents("szg.szg", fills, cfg(), T0);
    assert.deepEqual(
      fills.map((f) => f.tradeId),
      before,
    );
  });
});

/* ──────────────────────────── Polymarket lane ─────────────────────────── */

describe("polyTradesToIntents", () => {
  it("converts $0.47 to 47 cents and floors size to whole units", () => {
    const out = polyTradesToIntents(polyTrader(), [polyFill({ price: 0.47, size: 120.9 })], cfg(), T0);
    assert.equal(out.rejected.length, 0);
    assert.equal(out.intents.length, 1);
    assert.equal(out.intents[0].priceCents, 47);
    assert.equal(out.intents[0].count, 120);
    assert.equal(out.intents[0].venue, "polymarket");
    assert.equal(out.intents[0].side, "yes");
    assert.equal(out.intents[0].action, "buy");
  });

  it("puts 0.005 and 0.999 outside the band, and keeps 0.02 / 0.98 inside", () => {
    for (const price of [0.005, 0.999]) {
      const out = polyTradesToIntents(polyTrader(), [polyFill({ price })], cfg(), T0);
      assert.equal(out.intents.length, 0, `$${price} should be rejected`);
      assert.deepEqual(reasonsOf(out.rejected), ["price_out_of_band"]);
    }
    for (const price of [0.02, 0.98]) {
      const out = polyTradesToIntents(polyTrader(), [polyFill({ price })], cfg(), T0);
      assert.equal(out.rejected.length, 0, `$${price} should be admitted`);
      assert.equal(out.intents[0].priceCents, Math.round(price * 100));
    }
  });

  it("NEVER writes a conditionId into ticker, and carries the market identity in why", () => {
    const out = polyTradesToIntents(polyTrader(), [polyFill()], cfg(), T0);
    assert.equal(out.intents[0].ticker, null);
    assert.match(out.intents[0].why, /0xcond1/);
    assert.match(out.intents[0].why, /copy-match\.ts/);
  });

  it("maps a named outcome onto YES on that outcome, and SELL onto sell", () => {
    const named = polyTradesToIntents(
      polyTrader(),
      [polyFill({ outcome: "Chiefs", side: "SELL" })],
      cfg(),
      T0,
    );
    assert.equal(named.intents[0].side, "yes");
    assert.equal(named.intents[0].action, "sell");
    assert.match(named.intents[0].why, /YES on "Chiefs"/);
    const no = polyTradesToIntents(polyTrader(), [polyFill({ outcome: "No" })], cfg(), T0);
    assert.equal(no.intents[0].side, "no");
  });

  it("rejects an empty outcome as no_kalshi_match rather than guessing a side", () => {
    const out = polyTradesToIntents(polyTrader(), [polyFill({ outcome: "  " })], cfg(), T0);
    assert.equal(out.intents.length, 0);
    assert.deepEqual(reasonsOf(out.rejected), ["no_kalshi_match"]);
  });

  it("drops every unmatched intent as no_kalshi_match when the caller needs Kalshi-executable output", () => {
    const out = polyTradesToIntents(polyTrader(), [polyFill()], cfg(), T0, {
      kalshiExecutableOnly: true,
    });
    assert.equal(out.intents.length, 0);
    assert.deepEqual(reasonsOf(out.rejected), ["no_kalshi_match"]);
  });

  it("rejects a one-hot-week trader as trader_not_persistent, once, before reading fills", () => {
    const out = polyTradesToIntents(
      polyTrader({ priorWeeks: -8_000, profit7d: 240_000 }),
      [polyFill(), polyFill({ conditionId: "0xcond2" })],
      cfg(),
      T0,
    );
    assert.equal(out.intents.length, 0);
    assert.deepEqual(reasonsOf(out.rejected), ["trader_not_persistent"]);
    assert.match(out.rejected[0].detail, /not a track record/);
  });

  it("scores prior-week profit above a hot streak", () => {
    const persistent = polyTradesToIntents(polyTrader({ priorWeeks: 42_000 }), [polyFill()], cfg(), T0);
    const flat = polyTradesToIntents(polyTrader({ priorWeeks: 0 }), [polyFill()], cfg(), T0);
    assert.ok(persistent.intents[0].confidence > flat.intents[0].confidence);
  });

  it("treats a unix-SECONDS timestamp as seconds, not milliseconds", () => {
    const out = polyTradesToIntents(polyTrader(), [polyFill()], cfg(), T0);
    assert.equal(out.intents[0].observedAt, new Date(T0 - 30_000).toISOString());
    const stale = polyTradesToIntents(
      polyTrader(),
      [polyFill({ timestamp: Math.floor((T0 - 11 * MIN) / 1000) })],
      cfg(),
      T0,
    );
    assert.deepEqual(reasonsOf(stale.rejected), ["stale_signal"]);
  });
});

/* ──────────────────────────────── dedupe ─────────────────────────────── */

describe("dedupeIntents", () => {
  it("collapses 12 same-second clips into ONE intent with the summed count", () => {
    const clips = Array.from({ length: 12 }, (_, i) =>
      intent({ count: 5, why: `clip ${i}`, confidence: 0.32 }),
    );
    const out = dedupeIntents(clips);
    assert.equal(out.intents.length, 1);
    assert.equal(out.intents[0].count, 60);
    assert.equal(out.rejected.length, 11);
    assert.ok(out.rejected.every((r) => r.reason === "duplicate_intent"));
    assert.match(out.intents[0].why, /Merged 12 same-second clips/);
  });

  it("does NOT merge across different seconds or different tickers", () => {
    const out = dedupeIntents([
      intent({ observedAt: ago(30_000) }),
      intent({ observedAt: ago(30_000) }),
      intent({ observedAt: ago(31_000) }),
      intent({ ticker: "KXOTHER-26OCT04" }),
    ]);
    assert.equal(out.intents.length, 3);
    assert.deepEqual(
      out.intents.map((i) => i.count).sort((a, b) => a - b),
      [5, 5, 10],
    );
    assert.equal(out.rejected.length, 1);
  });

  it("does not merge two traders, two sides or two actions together", () => {
    const out = dedupeIntents([
      intent(),
      intent({ sourceTrader: "BitcoinTradingChallenge" }),
      intent({ side: "no" }),
      intent({ action: "sell" }),
    ]);
    assert.equal(out.intents.length, 4);
    assert.equal(out.rejected.length, 0);
  });

  it("keeps the WORST price when clips disagree: highest on a buy, lowest on a sell", () => {
    const buys = dedupeIntents([
      intent({ priceCents: 34 }),
      intent({ priceCents: 37 }),
      intent({ priceCents: 35 }),
    ]);
    assert.equal(buys.intents[0].priceCents, 37);
    assert.match(buys.intents[0].why, /kept the worst for us/);
    const sells = dedupeIntents([
      intent({ action: "sell", priceCents: 34 }),
      intent({ action: "sell", priceCents: 31 }),
    ]);
    assert.equal(sells.intents[0].priceCents, 31);
  });

  it("keeps the most conservative confidence and does not mutate the inputs", () => {
    const a = intent({ confidence: 0.44 });
    const b = intent({ confidence: 0.3 });
    const out = dedupeIntents([a, b]);
    assert.equal(out.intents[0].confidence, 0.3);
    assert.equal(a.count, 5, "input intent must not be mutated");
    assert.equal(a.confidence, 0.44);
  });
});

/* ──────────────────────────────── ranking ────────────────────────────── */

describe("rankIntents", () => {
  const pool: CopyIntent[] = [
    intent({ observedAt: ago(60_000), count: 9, why: "a" }),
    intent({ observedAt: ago(10_000), count: 4, why: "b" }),
    intent({ observedAt: ago(10_000), count: 40, why: "c" }),
    intent({ observedAt: ago(10_000), count: 4, why: "d" }),
    intent({ observedAt: ago(30_000), count: 7, why: "e" }),
    intent({ observedAt: ago(10_000), count: 4, ticker: null, venue: "polymarket", why: "f" }),
  ];

  it("orders freshest first, then larger count", () => {
    const out = rankIntents(pool);
    assert.deepEqual(
      out.map((i) => i.why),
      ["c", "b", "d", "f", "e", "a"],
    );
  });

  it("is identical for two different input orders — a total order, not input order", () => {
    const shuffleA = [pool[3], pool[0], pool[5], pool[2], pool[4], pool[1]];
    const shuffleB = [pool[5], pool[4], pool[1], pool[3], pool[2], pool[0]];
    const a = rankIntents(shuffleA);
    const b = rankIntents(shuffleB);
    assert.deepEqual(a, b);
    assert.deepEqual(a, rankIntents(pool));
  });

  it("does not mutate its input", () => {
    const copy = [...pool];
    rankIntents(pool);
    assert.deepEqual(pool, copy);
  });
});

/* ──────────────────────────── the orchestrator ────────────────────────── */

describe("gatherCopyScan", () => {
  it("returns zero intents with a NON-ZERO checked count when every trader is hidden", async () => {
    const leaders = leaderboard(100);
    let tradeCalls = 0;
    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async () => leaders,
        trades: async () => {
          tradeCalls++;
          return { trades: [], visibility: "hidden" };
        },
        resolveFill: () => {
          throw new Error("resolveFill must not run on a hidden trader");
        },
      },
      now: () => T0,
    });

    assert.equal(scan.intents.length, 0);
    assert.equal(scan.checked.kalshiTraders, 100, "a zero must be explainable");
    assert.equal(scan.checked.kalshiVisible, 0);
    assert.equal(scan.checked.polyTraders, 0);
    assert.equal(tradeCalls, 100);
    assert.equal(scan.rejected.length, 100);
    assert.ok(scan.rejected.every((r) => r.reason === "trades_hidden"));
    assert.equal(scan.scannedAt, new Date(T0).toISOString());
  });

  it("reproduces the measured shape: 100 ranked, 2 visible, and only those two produce intents", async () => {
    const leaders = leaderboard(100);
    const visible = new Set(["trader67", "trader87"]);
    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async (limit) => leaders.slice(0, limit),
        trades: async (nickname) =>
          visible.has(nickname)
            ? {
                trades: [
                  kalshiRow({ tradeId: `${nickname}-taker`, takerNickname: nickname }),
                  kalshiRow({
                    tradeId: `${nickname}-maker`,
                    makerNickname: nickname,
                    takerNickname: "someone-else",
                  }),
                ],
                visibility: "visible",
              }
            : { trades: [], visibility: "hidden" },
        resolveFill: resolveFillStub,
      },
      now: () => T0,
    });

    assert.equal(scan.checked.kalshiTraders, 100);
    assert.equal(scan.checked.kalshiVisible, 2);
    assert.equal(scan.intents.length, 2, "one taker fill each; the maker fills are dropped");
    assert.deepEqual(
      scan.intents.map((i) => i.sourceTrader).sort(),
      ["trader67", "trader87"],
    );
    assert.ok(scan.intents.every((i) => i.role === "taker"));
    assert.equal(reasonsOf(scan.rejected).filter((r) => r === "maker_fill_unmirrorable").length, 2);
    assert.equal(reasonsOf(scan.rejected).filter((r) => r === "trades_hidden").length, 98);
  });

  it("names a wash print self_trade and an unresolvable row trades_hidden, without guessing a side", async () => {
    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async () => leaderboard(1),
        trades: async () => ({
          visibility: "visible",
          trades: [
            kalshiRow({ tradeId: "wash", makerNickname: "trader1", takerNickname: "trader1" }),
            kalshiRow({ tradeId: "anon", makerNickname: "", takerNickname: "" }),
            kalshiRow({ tradeId: "good", takerNickname: "trader1" }),
          ],
        }),
        resolveFill: resolveFillStub,
      },
      now: () => T0,
    });

    assert.equal(scan.checked.kalshiVisible, 1);
    assert.equal(scan.intents.length, 1);
    assert.equal(scan.intents[0].ticker, "KXBTCD-26OCT04-T62000");
    assert.deepEqual(reasonsOf(scan.rejected).sort(), ["self_trade", "trades_hidden"]);
  });

  it("survives a per-trader read failure instead of losing the whole scan", async () => {
    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async () => leaderboard(3),
        trades: async (nickname) => {
          if (nickname === "trader1") throw new Error("HTTP 500");
          return {
            visibility: "visible",
            trades: [kalshiRow({ tradeId: `${nickname}-1`, takerNickname: nickname })],
          };
        },
        resolveFill: resolveFillStub,
      },
      now: () => T0,
    });

    assert.equal(scan.checked.kalshiTraders, 3);
    assert.equal(scan.checked.kalshiVisible, 2);
    assert.equal(scan.intents.length, 2);
    const failure = scan.rejected.find((r) => r.detail.includes("HTTP 500"));
    assert.ok(failure, "the failure must be reported, not swallowed");
    assert.equal(failure?.reason, "trades_hidden");
  });

  it("skips an anonymised leaderboard row without spending a request on it", async () => {
    let tradeCalls = 0;
    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async () => [
          { nickname: "", socialId: "s1", value: 9_000_000, rank: 1, isAnonymous: true },
        ],
        trades: async () => {
          tradeCalls++;
          return { trades: [], visibility: "visible" };
        },
        resolveFill: resolveFillStub,
      },
      now: () => T0,
    });
    assert.equal(tradeCalls, 0);
    assert.equal(scan.checked.kalshiVisible, 0);
    assert.deepEqual(reasonsOf(scan.rejected), ["trades_hidden"]);
  });

  it("never asks either venue for more rows than the measured cap", async () => {
    const asked: number[] = [];
    await gatherCopyScan(cfg({ kalshiTraderLimit: 500, polyTraderLimit: 500 }), {
      kalshi: {
        leaderboard: async (limit) => {
          asked.push(limit);
          return [];
        },
        trades: async () => ({ trades: [], visibility: "hidden" }),
        resolveFill: resolveFillStub,
      },
      poly: {
        leaderboard: async (limit) => {
          asked.push(limit);
          return [];
        },
        trades: async () => [],
      },
      now: () => T0,
    });
    assert.deepEqual(asked, [KALSHI_LEADERBOARD_MAX, POLY_LEADERBOARD_MAX]);
  });

  it("dedupes and ranks across both venues in one pass", async () => {
    const deps: CopyScanDeps = {
      kalshi: {
        leaderboard: async () => leaderboard(1),
        trades: async () => ({
          visibility: "visible",
          trades: [
            kalshiRow({ tradeId: "c1", count: 5, takerNickname: "trader1" }),
            kalshiRow({ tradeId: "c2", count: 7, takerNickname: "trader1" }),
          ],
        }),
        resolveFill: resolveFillStub,
      },
      poly: {
        leaderboard: async () => [polyTrader()],
        trades: async () => [polyFill({ timestamp: Math.floor((T0 - 5_000) / 1000) })],
      },
      now: () => T0,
    };
    const scan = await gatherCopyScan(cfg(), deps);

    assert.equal(scan.checked.polyTraders, 1);
    // The two same-second Kalshi clips became one intent of 12.
    const kalshiIntents = scan.intents.filter((i) => i.venue === "kalshi");
    assert.equal(kalshiIntents.length, 1);
    assert.equal(kalshiIntents[0].count, 12);
    // Polymarket's fill is 5s old vs Kalshi's 30s, so it ranks first.
    assert.equal(scan.intents[0].venue, "polymarket");
    assert.equal(reasonsOf(scan.rejected).filter((r) => r === "duplicate_intent").length, 1);
  });
});

/* ───────────────────── every reason is reachable, by name ───────────────── */

describe("rejection coverage", () => {
  it("can emit every reason in SIGNAL_REJECTIONS and none that copy-match owns", async () => {
    const seen = new Set<CopyRejection>();
    const add = (rows: { reason: CopyRejection }[]) => rows.forEach((r) => seen.add(r.reason));

    add(kalshiFillsToIntents("x", [fill({ observedAt: ago(20 * MIN) })], cfg(), T0).rejected);
    add(kalshiFillsToIntents("x", [fill({ count: 0 })], cfg(), T0).rejected);
    add(kalshiFillsToIntents("x", [fill({ priceCents: 1 })], cfg(), T0).rejected);
    add(kalshiFillsToIntents("x", [fill({ role: "maker" })], cfg(), T0).rejected);
    add(
      kalshiFillsToIntents(
        "x",
        [fill({ tradeId: "a" }), fill({ tradeId: "b" })],
        cfg({ maxIntentsPerTrader: 1 }),
        T0,
      ).rejected,
    );
    add(polyTradesToIntents(polyTrader({ priorWeeks: -1 }), [polyFill()], cfg(), T0).rejected);
    add(polyTradesToIntents(polyTrader(), [polyFill({ outcome: "" })], cfg(), T0).rejected);
    add(dedupeIntents([intent(), intent()]).rejected);

    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async () => leaderboard(2),
        trades: async (nickname) =>
          nickname === "trader1"
            ? { visibility: "hidden", trades: [] }
            : {
                visibility: "visible",
                trades: [kalshiRow({ makerNickname: "trader2", takerNickname: "trader2" })],
              },
        resolveFill: resolveFillStub,
      },
      now: () => T0,
    });
    add(scan.rejected);

    // ★ Nothing above injected `kalshiMarket`, so the two market-gate reasons
    //   must be absent at this point. "Absent unless the caller hands in a
    //   lookup" is the gate's whole contract.
    for (const gated of MARKET_GATE_REJECTIONS) {
      assert.ok(!seen.has(gated), `${gated} must need an injected market lookup`);
    }

    // And with a lookup injected they are reachable, which is what keeps them in
    // SIGNAL_REJECTIONS honest.
    const dead = await gateMarketLiveness(
      [intent({ ticker: "CLOSED" }), intent({ ticker: "EMPTY-BOOK" })],
      (ticker) =>
        ticker === "CLOSED"
          ? { ticker, occurrence_datetime: new Date(T0 + 60 * MIN).toISOString(), yes_ask_dollars: "0.40" }
          : {
              ticker,
              occurrence_datetime: new Date(T0 - 60 * MIN).toISOString(),
              yes_ask_dollars: "0.00",
            },
      T0,
    );
    add(dead.rejected);

    const missing = SIGNAL_REJECTIONS.filter((r) => !seen.has(r));
    assert.deepEqual(missing, [], `unreachable rejection reasons: ${missing.join(", ")}`);
  });
});

/* ──────────────────── the confidence floor (ENFORCED, not printed) ───────── */

describe("minConfidence", () => {
  it("defaults to 0.25 and drops NOTHING the shipped defaults can produce", () => {
    assert.equal(DEFAULT_SIGNAL_CONFIG.minConfidence, 0.25);
    // Worst case either lane can hand the floor at the shipped defaults: a Kalshi
    // TAKER fill with no known rank (0.3) and a Polymarket fill with no rank and
    // nothing earned before this week (0.35). Both clear 0.25.
    const kalshiWorst = kalshiFillsToIntents("x", [fill()], cfg(), T0);
    assert.equal(kalshiWorst.intents.length, 1);
    assert.equal(kalshiWorst.intents[0].confidence, 0.3);
    const polyWorst = polyTradesToIntents(
      polyTrader({ rank: 0, priorWeeks: 0 }),
      [polyFill()],
      cfg(),
      T0,
    );
    assert.equal(polyWorst.intents.length, 1);
    assert.equal(polyWorst.intents[0].confidence, 0.35);
  });

  it("★ FILTERS — a Kalshi intent under the floor is dropped, not merely printed", () => {
    const out = kalshiFillsToIntents("x", [fill()], cfg({ minConfidence: 0.4 }), T0, {
      rank: 90,
      volumeDollars: 100_000,
    });
    assert.equal(out.intents.length, 0);
    assert.deepEqual(reasonsOf(out.rejected), ["trader_not_persistent"]);
    assert.match(out.rejected[0].detail, /CONFIDENCE FLOOR/);
    assert.match(out.rejected[0].detail, /0\.4/);
  });

  it("a floor above 0.45 mutes the WHOLE Kalshi lane — the silent kill we refuse to default to", () => {
    const best = kalshiFillsToIntents("x", [fill()], cfg({ minConfidence: 0.46 }), T0, {
      rank: 1,
      volumeDollars: 99_000_000,
    });
    assert.equal(best.intents.length, 0);
    assert.equal(best.rejected[0].reason, "trader_not_persistent");
    // Which is exactly why the DEFAULT is nowhere near it.
    assert.ok(DEFAULT_SIGNAL_CONFIG.minConfidence < 0.45);
  });

  it("the maker opt-in still answers to the floor: rank 87 maker scores 0.221 and is refused", () => {
    const out = kalshiFillsToIntents(
      "szg.szg",
      [fill({ role: "maker" })],
      cfg({ includeMakerFills: true }),
      T0,
      { rank: 87, volumeDollars: 865_901 },
    );
    assert.equal(out.intents.length, 0);
    assert.deepEqual(reasonsOf(out.rejected), ["trader_not_persistent"]);
    assert.match(out.rejected[0].detail, /CONFIDENCE FLOOR — 0\.221 < minConfidence 0\.25/);
    // Rank 67 — the other visible trader — clears it by 0.001. The floor bites
    // the bottom of the table, it does not mute the opt-in.
    const better = kalshiFillsToIntents(
      "BitcoinTradingChallenge",
      [fill({ role: "maker" })],
      cfg({ includeMakerFills: true }),
      T0,
      { rank: 67, volumeDollars: 1_110_684 },
    );
    assert.equal(better.intents.length, 1);
    assert.equal(better.intents[0].confidence, 0.251);
  });

  it("drops a Polymarket intent under the floor, and says it is not the persistence gate", () => {
    const out = polyTradesToIntents(
      polyTrader({ rank: 0, priorWeeks: 0 }),
      [polyFill()],
      cfg({ minConfidence: 0.4 }),
      T0,
    );
    assert.equal(out.intents.length, 0);
    assert.deepEqual(reasonsOf(out.rejected), ["trader_not_persistent"]);
    assert.match(out.rejected[0].detail, /CONFIDENCE FLOOR/);
    assert.match(out.rejected[0].detail, /persistence gate above passed/);
  });

  it("the floor is reported BEFORE the caller's Kalshi-executable preference", () => {
    const out = polyTradesToIntents(
      polyTrader({ rank: 0, priorWeeks: 0 }),
      [polyFill()],
      cfg({ minConfidence: 0.4 }),
      T0,
      { kalshiExecutableOnly: true },
    );
    assert.deepEqual(reasonsOf(out.rejected), ["trader_not_persistent"]);
  });
});

/* ─────────────── why a Kalshi row did not resolve, told truthfully ───────── */

describe("classifyUnresolvedRow", () => {
  const row = (over: Partial<KalshiPublicTradeLite> = {}) => kalshiRow(over);

  it("names a row where neither nickname matches — the only case that was ever true", () => {
    const r = classifyUnresolvedRow(row({ makerNickname: "a", takerNickname: "b" }), "szg.szg");
    assert.equal(r.reason, "trades_hidden");
    assert.match(r.detail, /neither nickname matches/);
  });

  it("names a wash print as self_trade, not as a nickname problem", () => {
    const r = classifyUnresolvedRow(row({ makerNickname: "szg.szg", takerNickname: "szg.szg" }), "szg.szg");
    assert.equal(r.reason, "self_trade");
    assert.match(r.detail, /BOTH maker and taker/);
  });

  it("names an empty tradeId as un-dedupable instead of blaming the nickname", () => {
    const r = classifyUnresolvedRow(row({ tradeId: "" }), "szg.szg");
    assert.equal(r.reason, "duplicate_intent");
    assert.match(r.detail, /NO TRADE ID/);
    assert.doesNotMatch(r.detail, /neither nickname/);
  });

  it("names an empty ticker as nothing-to-send-to", () => {
    const r = classifyUnresolvedRow(row({ ticker: "" }), "szg.szg");
    assert.equal(r.reason, "no_kalshi_match");
    assert.match(r.detail, /no ticker/);
  });

  it("★ calls the four causes it CANNOT see UNKNOWN, and lists them", () => {
    // A perfectly identifiable row: nickname matches, both ids present. Anything
    // resolveFill refused here failed on a field this lane does not carry.
    const r = classifyUnresolvedRow(row(), "szg.szg");
    assert.equal(r.reason, "trades_hidden");
    assert.match(r.detail, /UNKNOWN from here/);
    assert.match(r.detail, /taker_side/);
    assert.match(r.detail, /count < 1/);
    assert.match(r.detail, /kalshi-social\.ts/);
  });

  it("gatherCopyScan uses it — a null fill no longer claims a nickname mismatch", async () => {
    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async () => [
          { nickname: "szg.szg", socialId: "s1", value: 86_590_110, rank: 87, isAnonymous: false },
        ],
        trades: async () => ({
          visibility: "visible",
          // Resolvable identity, so the cause is one of the fields this lane
          // cannot see — exactly the case that used to lie.
          trades: [kalshiRow({ makerNickname: "", takerNickname: "szg.szg", tradeId: "k-9" })],
        }),
        resolveFill: () => null,
      },
      now: () => T0,
    });
    assert.equal(scan.intents.length, 0);
    assert.equal(scan.rejected.length, 1);
    assert.equal(scan.rejected[0].reason, "trades_hidden");
    assert.match(scan.rejected[0].detail, /UNKNOWN from here/);
    assert.doesNotMatch(scan.rejected[0].detail, /neither nickname matches/);
  });
});

/* ────────────────── the market liveness / tradeability gate ─────────────── */

describe("gateMarketLiveness", () => {
  const live = {
    ticker: "KXBTCD-26OCT04-T62000",
    occurrence_datetime: new Date(T0 - 30 * MIN).toISOString(),
    close_time: new Date(T0 + 6 * 60 * MIN).toISOString(),
    yes_ask_dollars: "0.36",
  };

  it("passes an intent whose market is open and quoted", async () => {
    const out = await gateMarketLiveness([intent()], () => live, T0);
    assert.equal(out.intents.length, 1);
    assert.deepEqual(out.rejected, []);
  });

  it("drops a market that has not started — occurrence_datetime, not close_time", async () => {
    const out = await gateMarketLiveness(
      [intent()],
      () => ({ ...live, occurrence_datetime: new Date(T0 + 2 * 60 * MIN).toISOString() }),
      T0,
    );
    assert.equal(out.intents.length, 0);
    assert.equal(out.rejected[0].reason, "market_not_live");
    assert.match(out.rejected[0].detail, /SETTLEMENT window/);
  });

  it("drops a market nobody is offering on", async () => {
    const out = await gateMarketLiveness([intent()], () => ({ ...live, yes_ask_dollars: "0.00" }), T0);
    assert.equal(out.intents.length, 0);
    assert.equal(out.rejected[0].reason, "market_not_tradeable");
    assert.match(out.rejected[0].detail, /empty book/);
  });

  it("an unknown market is a REFUSAL, never an assumption", async () => {
    const out = await gateMarketLiveness([intent()], () => null, T0);
    assert.equal(out.intents.length, 0);
    assert.equal(out.rejected[0].reason, "market_not_tradeable");
    assert.match(out.rejected[0].detail, /no such market/);
  });

  it("a lookup that THROWS costs the signal, not the money", async () => {
    const out = await gateMarketLiveness(
      [intent()],
      () => {
        throw new Error("ECONNRESET");
      },
      T0,
    );
    assert.equal(out.intents.length, 0);
    assert.equal(out.rejected[0].reason, "market_not_tradeable");
    assert.match(out.rejected[0].detail, /ECONNRESET/);
  });

  it("looks a ticker up ONCE however many intents share it", async () => {
    let calls = 0;
    const out = await gateMarketLiveness(
      [intent({ count: 7 }), intent(), intent()],
      () => {
        calls++;
        return live;
      },
      T0,
    );
    assert.equal(calls, 1);
    assert.equal(out.intents.length, 3);
  });

  it("leaves a ticker-less Polymarket intent alone — there is nothing to look up", async () => {
    let calls = 0;
    const out = await gateMarketLiveness(
      [intent({ venue: "polymarket", ticker: null })],
      () => {
        calls++;
        return live;
      },
      T0,
    );
    assert.equal(calls, 0);
    assert.equal(out.intents.length, 1);
  });

  it("★ gatherCopyScan runs NO gate when no lookup is injected", async () => {
    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async () => [
          { nickname: "szg.szg", socialId: "s1", value: 86_590_110, rank: 87, isAnonymous: false },
        ],
        trades: async () => ({ visibility: "visible", trades: [kalshiRow()] }),
        resolveFill: resolveFillStub,
      },
      now: () => T0,
    });
    assert.equal(scan.intents.length, 1);
    for (const gated of MARKET_GATE_REJECTIONS) {
      assert.ok(!reasonsOf(scan.rejected).includes(gated));
    }
  });

  it("★ gatherCopyScan gates the Kalshi lane once a lookup IS injected", async () => {
    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async () => [
          { nickname: "szg.szg", socialId: "s1", value: 86_590_110, rank: 87, isAnonymous: false },
        ],
        trades: async () => ({ visibility: "visible", trades: [kalshiRow()] }),
        resolveFill: resolveFillStub,
      },
      // The market closed before the scan — the case that used to become an order
      // into a closed market, because no Kalshi intent ever reaches copy-match.
      kalshiMarket: () => ({
        ticker: "KXBTCD-26OCT04-T62000",
        occurrence_datetime: new Date(T0 - 6 * 60 * MIN).toISOString(),
        close_time: new Date(T0 - 60 * MIN).toISOString(),
        yes_ask_dollars: "0.36",
      }),
      now: () => T0,
    });
    assert.equal(scan.intents.length, 0);
    assert.deepEqual(reasonsOf(scan.rejected), ["market_not_live"]);
  });
});

/* ────────── the Division 1 seam: THEIR real row shape, not ours ─────────── */

describe("kalshi-social seam", () => {
  it("takes Division 1's REAL row type with no adapter (price, countFp, widened strings)", async () => {
    const row: KalshiPublicTrade = {
      tradeId: "d1-1",
      marketId: "m-1",
      ticker: "KXNHL2P-26OCT04WPGDET-TIE",
      price: 34,
      priceDollars: "0.34",
      count: 10,
      countFp: "10.0",
      takerSide: "yes",
      takerAction: "buy",
      makerNickname: "",
      takerNickname: "trader1",
      createDate: ago(30_000),
    };

    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async () => leaderboard(1),
        trades: async () => ({ trades: [row], visibility: "visible" }),
        // takerSide/takerAction are plain `string` on their row, so they are
        // NARROWED here rather than trusted into a Side/Action.
        resolveFill: (r, nickname) =>
          r.takerNickname === nickname
            ? {
                tradeId: r.tradeId,
                marketKey: r.ticker,
                side: r.takerSide === "no" ? "no" : "yes",
                action: r.takerAction === "sell" ? "sell" : "buy",
                priceCents: r.price,
                count: r.count,
                role: "taker",
                observedAt: r.createDate,
              }
            : null,
      },
      now: () => T0,
    });

    assert.equal(scan.intents.length, 1);
    assert.equal(scan.intents[0].priceCents, 34);
    assert.equal(scan.intents[0].ticker, "KXNHL2P-26OCT04WPGDET-TIE");
  });

  it("prints leaderboard volume in DOLLARS — the raw value is CENTS", async () => {
    // Measured by Division 1: rank 67 came back as 111068410, which is
    // $1,110,684 of turnover. Printing the raw integer would be 100x wrong.
    const scan = await gatherCopyScan(cfg(), {
      kalshi: {
        leaderboard: async () => [
          {
            nickname: "BitcoinTradingChallenge",
            socialId: "s67",
            value: 111_068_410,
            rank: 67,
            isAnonymous: false,
          },
        ],
        trades: async () => ({
          visibility: "visible",
          trades: [kalshiRow({ takerNickname: "BitcoinTradingChallenge" })],
        }),
        resolveFill: resolveFillStub,
      },
      now: () => T0,
    });

    assert.equal(scan.intents.length, 1);
    assert.match(scan.intents[0].why, /\$1,110,684 turnover/);
    assert.ok(
      !scan.intents[0].why.includes("111,068,410"),
      "raw cents must never be printed as a dollar figure",
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * DEDUPE MUST NOT MERGE DIFFERENT MARKETS (adversarial review, 2026-10-04)
 *
 * The bucket key used `intent.ticker ?? "<unmatched>"`. Every Polymarket intent
 * carries ticker=null until resolvePolyTickers runs — which is AFTER dedupe — so
 * the market component was a CONSTANT across the entire Polymarket lane. One
 * trader's bets on unrelated markets, same side/action in the same second, were
 * merged into one intent with the counts SUMMED, and the survivor then resolved
 * to a single ticker and would have been sent at the combined size.
 *
 * The pre-existing guard test only distinguished markets by a NON-null ticker,
 * so it exercised the one branch no Polymarket intent ever takes.
 * ──────────────────────────────────────────────────────────────────────────── */
describe("dedupeIntents — different markets must never merge", () => {
  const base = {
    venue: "polymarket" as const,
    sourceTrader: "BreakTheBank",
    ticker: null,
    side: "yes" as const,
    action: "buy" as const,
    priceCents: 46,
    count: 10,
    role: "taker" as const,
    observedAt: "2026-10-04T18:47:36.000Z",
    confidence: 0.6,
    why: "test",
  };

  it("keeps two ticker-less intents on DIFFERENT markets separate", () => {
    const out = dedupeIntents([
      { ...base, source: { outcome: "Patriots", slug: "nfl-ne-buf-2026-10-04", title: "Patriots vs. Bills" } },
      { ...base, source: { outcome: "Lions", slug: "nfl-det-kc-2026-10-04", title: "Lions vs. Chiefs" } },
    ]);
    assert.equal(out.intents.length, 2, "two different markets are two intents, not one");
    assert.deepEqual(out.intents.map((i) => i.count).sort(), [10, 10], "counts must NOT be summed");
  });

  it("keeps OPPOSITE outcomes in the SAME market separate", () => {
    const slug = "nfl-ne-buf-2026-10-04";
    const out = dedupeIntents([
      { ...base, source: { outcome: "Patriots", slug, title: "Patriots vs. Bills" } },
      { ...base, source: { outcome: "Bills", slug, title: "Patriots vs. Bills" } },
    ]);
    assert.equal(out.intents.length, 2, "buy YES Patriots and buy YES Bills are opposite bets");
  });

  it("still merges genuine same-market same-second clips", () => {
    const src = { outcome: "Patriots", slug: "nfl-ne-buf-2026-10-04", title: "Patriots vs. Bills" };
    const out = dedupeIntents([
      { ...base, source: src, count: 5 },
      { ...base, source: src, count: 7 },
      { ...base, source: src, count: 3 },
    ]);
    assert.equal(out.intents.length, 1, "three clips of one order are one intent");
    assert.equal(out.intents[0].count, 15, "and their counts DO sum");
  });
});
