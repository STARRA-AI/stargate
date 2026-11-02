/**
 * THE INTEGRATION SEAM — the tests that stand between a leaderboard scan and an
 * order actually leaving the house.
 *
 * Four properties are load-bearing here, and each one fails loudly below:
 *
 *   1. THE DEFAULT PASS DID NOT MOVE. With no overrides, `runOnce` still scans
 *      the Polymarket-edge lane and still sends through `kalshi.placeOrder`, at
 *      the same point, with the same body. Classic's running loop behaves
 *      exactly as it did before 2026-10-04.
 *   2. THE VENUE SWITCH ACTUALLY SWITCHES. `executionVenue: "dragon-tradar"`
 *      sends through `dragon-copy` and `kalshi.placeOrder` is called ZERO times.
 *      Counted, not read.
 *   3. THE TWO LANES CANNOT BOTH ARM. `armedExecutionLanes()` is never longer
 *      than one, for every combination of venue and live-ness. And going live on
 *      the dragon lane REFUSES while his own Dragon Tradar scanner is running,
 *      because that is two engines sizing against one bankroll.
 *   4. `copy_scan` IS READ-SCOPED. It is not in the voice route's WRITE_ACTIONS,
 *      and there is no copy-EXECUTE verb on that route at all.
 *
 * Four more, added 2026-10-04 after the review found them missing:
 *
 *   5. THE kalshi-direct LANE HAS A PASS BUDGET, AND ITS COLLATERAL DECREMENTS.
 *      Three orders that each pass alone do not all get sent when their TOTAL
 *      would overrun the budget or the shard. Counted, not read.
 *   6. AN UNKNOWN SEND IS RECORDED AS ACTED. A timeout on the dragon lane
 *      (`state: "error"`, `status: 0`) may already have landed, so the next pass
 *      must not re-fire it. A 429/401/403 is a DEFINITE refusal and stays
 *      eligible — both directions asserted.
 *   7. THE day|ticker GUARD APPLIES ON THE DRAGON LANE. Two different traders
 *      signalling the same ticker on the same day produce ONE order, and a
 *      ticker the dragon lane sent yesterday... today is refused tomorrow-proof:
 *      the key is persisted in `state.acted`, which that lane never wrote.
 *   8. THE DEFAULTS ARE STILL THE OLD BEHAVIOUR, AND NOTHING IN PRODUCTION ARMS
 *      THE NEW LANE. Asserted against the two caller files' own source, so an
 *      edit that silently arms it fails here.
 *
 * ZERO NETWORK. Every edge is injected: the Kalshi-direct transport through
 * `cfg.io`, the Kalshi-social fetchers through `cfg.kalshiSocialDeps`, and
 * Dragon Tradar through `cfg.deps.fetchImpl`. `globalThis.fetch` is replaced with
 * a thrower for the whole file, so an unstubbed call fails by name instead of
 * reaching api.elections.kalshi.com, lb-api.polymarket.com or dragontradar.com.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";

import {
  DEFAULTS,
  DIRECT_PER_ORDER_DEFAULT_CENTS,
  DIRECT_PER_SCAN_DEFAULT_CENTS,
  EXECUTION_VENUES,
  armedExecutionLanes,
  candidateToIntent,
  executionVenueOf,
  guardDragonLane,
  intentToDirectKalshiOrder,
  resolveDirectCaps,
  runOnce,
  scanKalshiLeaderboardIntents,
  signalSourcesOf,
  type Candidate,
  type LoopConfig,
  type LoopIo,
  type LoopState,
} from "../src/lib/copy-loop";
import { DRAGON_TRADAR_AGENT_BASE } from "../src/lib/dragon-tradar";
import { normaliseTradeRow, resolveFill, type KalshiPublicTrade } from "../src/lib/kalshi-social";
import type { CopyIntent } from "../src/lib/copy-contracts";

/* ─────────────────────────── no network, asserted ───────────────────────── */

const realFetch = globalThis.fetch;
before(() => {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    throw new Error(`unstubbed network call to ${String(input)}`);
  }) as unknown as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

/* ───────────────────────────────── fixtures ─────────────────────────────── */

const NICK = "BitcoinTradingChallenge";

/** VERBATIM from the live tape, 2026-10-04. The maker row — the inversion case. */
const MAKER_ROW_RAW = {
  count: 3,
  count_fp: "3.00",
  create_date: "2026-10-04T18:47:36.806999Z",
  maker_nickname: NICK,
  market_id: "01a10689-7d45-7a38-9207-e93502d43245",
  price: 40,
  price_dollars: "0.4000",
  taker_action: "sell",
  taker_nickname: "",
  taker_side: "no",
  ticker: "KXWNBA1QWINNER-26OCT04NYATL-NY",
  trade_id: "072528c9-5f99-b3d5-dea1-0eefa2fdc4be",
};

/** VERBATIM taker row — side/action pass through unchanged. */
const TAKER_ROW_RAW = {
  count: 2,
  count_fp: "2.00",
  create_date: "2026-10-04T18:41:59.127169Z",
  maker_nickname: "Unitdor",
  market_id: "01a0fdfe-edbe-764a-9cd1-f09b3770ff3c",
  price: 35,
  price_dollars: "0.3500",
  taker_action: "buy",
  taker_nickname: NICK,
  taker_side: "yes",
  ticker: "KXNHL2P-26OCT04WPGDET-TIE",
  trade_id: "072528dc-b359-9304-fc27-84d536cb0e86",
};

function row(raw: unknown): KalshiPublicTrade {
  const mapped = normaliseTradeRow(raw);
  assert.ok(mapped, "fixture must map");
  return mapped;
}

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    match: {
      ticker: "KXMLBGAME-26OCT04ATLNYM-ATL",
      team: "ATL",
      askDollars: 0.4,
      shard: 0,
      subTitle: "Atlanta Braves",
    } as unknown as Candidate["match"],
    signal: {
      wallet: "0xWALLET",
      side: "BUY",
      outcome: "Atlanta Braves",
      title: "Braves vs Mets",
      price: 0.47,
      size: 120,
      // Relative to the REAL clock: `runOnce`'s staleness gate reads Date.now(),
      // and it is not injectable, so a fixed fixture timestamp would age out and
      // make this suite pass or fail depending on the day it runs.
      timestamp: Math.floor(Date.now() / 1000) - 60,
      conditionId: "0xCOND",
    },
    sport: "MLB",
    edgeDollars: 0.07,
    trader: "SlimChance",
    ...over,
  };
}

function freshState(): LoopState {
  return {
    acted: [],
    actedIntents: [],
    dayKey: new Date().toISOString().slice(0, 10),
    startPnl: 0,
    snapshotTaken: true,
  };
}

/** Injected Kalshi-direct transport. Counts every send, reaches nothing. */
function spyIo(over: Partial<LoopIo> = {}): {
  io: Partial<LoopIo>;
  placed: { ticker: string; side: string; count: number; priceDollars: number }[];
  saved: LoopState[];
} {
  const placed: { ticker: string; side: string; count: number; priceDollars: number }[] = [];
  const saved: LoopState[] = [];
  const io: Partial<LoopIo> = {
    fetchPortfolio: async () => ({ linked: true, balanceDollars: 42.4, positions: [] }),
    fetchRealisedPnl: async () => ({ pnl: 0, fees: 0 }),
    fetchShardBalances: async () => [{ exchangeIndex: 0, label: "Default", dollars: 42.4 }],
    placeOrder: (async (o: {
      ticker: string;
      side: string;
      count: number;
      priceDollars: number;
    }) => {
      placed.push(o);
      return { order: { order_id: "fake" } };
    }) as unknown as LoopIo["placeOrder"],
    scanCandidates: async () => [candidate()],
    loadState: async () => freshState(),
    saveState: async (s: LoopState) => {
      saved.push(JSON.parse(JSON.stringify(s)) as LoopState);
    },
    ...over,
  };
  return { io, placed, saved };
}

/** A Dragon Tradar transport. Records every URL+method; answers from a table. */
function dragonStub(
  opts: { running?: boolean; mode?: string; orderStatus?: number; orderNetworkFail?: boolean } = {},
) {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method });
    const json = (status: number, body: unknown) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    if (url.endsWith("/bot/state")) {
      return json(200, {
        running: opts.running ?? false,
        category: "sports",
        mode: opts.mode ?? "paper",
        lastScanAt: null,
        config: { minBetCents: 1000, autoFire: true, scanIntervalMin: 15, dailyLossFloorCents: 0 },
      });
    }
    if (url.endsWith("/stats")) {
      return json(200, { connected: true, balanceCents: 4240, positions: [] });
    }
    if (url.endsWith("/order")) {
      // ★ A DROPPED CONNECTION, not an HTTP status. `agentRequest` catches this
      //   and returns `{ state: "error", status: 0 }` — the ambiguous case: the
      //   order may well have landed (src/lib/dragon-tradar.ts:153-156).
      if (opts.orderNetworkFail) throw new TypeError("fetch failed");
      return json(opts.orderStatus ?? 200, { accepted: true });
    }
    throw new Error(`dragonStub got an unexpected ${method} ${url}`);
  }) as unknown as typeof fetch;
  return {
    deps: { token: "t".repeat(64), fetchImpl, base: DRAGON_TRADAR_AGENT_BASE },
    calls,
    posts: () => calls.filter((c) => c.method === "POST"),
    orderPosts: () => calls.filter((c) => c.method === "POST" && c.url.endsWith("/order")),
  };
}

/* ══════════════════════ 1. THE DEFAULT PASS DID NOT MOVE ════════════════════ */

describe("the default pass is the old pass", () => {
  it("DEFAULTS still name the original lane and the original venue", () => {
    assert.deepEqual(DEFAULTS.sources, ["polymarket-edge"]);
    assert.equal(DEFAULTS.executionVenue, "kalshi-direct");
    assert.equal(DEFAULTS.live, false);
    // The pre-existing knobs are untouched — a changed default here would move
    // his running loop without him asking.
    assert.equal(DEFAULTS.traders, 5);
    assert.equal(DEFAULTS.count, 1);
    assert.equal(DEFAULTS.maxPriceDollars, 0.9);
    assert.equal(DEFAULTS.minEdgeDollars, 0.02);
    assert.equal(DEFAULTS.maxEdgeDollars, 0.15);
    assert.equal(DEFAULTS.minPriceDollars, 0.05);
    assert.equal(DEFAULTS.maxSignalAgeMinutes, 30);
    assert.equal(DEFAULTS.dailyLossFloorDollars, -10);
    assert.equal(DEFAULTS.maxOpenPositions, 10);
  });

  it("an empty config resolves to the kalshi-direct venue and the polymarket-edge source", () => {
    assert.equal(executionVenueOf({}), "kalshi-direct");
    assert.deepEqual(signalSourcesOf({}), ["polymarket-edge"]);
  });

  it("a garbage venue falls back to the OLD lane, never to the new one", () => {
    assert.equal(executionVenueOf({ executionVenue: "nonsense" as never }), "kalshi-direct");
    assert.deepEqual(signalSourcesOf({ sources: [] }), ["polymarket-edge"]);
    assert.deepEqual(signalSourcesOf({ sources: ["bogus" as never] }), ["polymarket-edge"]);
  });

  it("a LIVE default pass still sends through kalshi.placeOrder, bid on YES", async () => {
    const { io, placed, saved } = spyIo();
    const r = await runOnce({ live: true, io });
    assert.equal(placed.length, 1, "exactly one direct order");
    assert.deepEqual(placed[0], {
      ticker: "KXMLBGAME-26OCT04ATLNYM-ATL",
      side: "bid",
      count: 1,
      priceDollars: 0.4,
    });
    assert.equal(r.venue, "kalshi-direct");
    assert.equal(r.copy, undefined, "the dragon lane did not run");
    assert.equal(r.placed.length, 1);
    assert.ok(saved.length >= 1, "the dedupe key was persisted");
    assert.ok(saved.at(-1)!.acted.includes(`${new Date().toISOString().slice(0, 10)}|KXMLBGAME-26OCT04ATLNYM-ATL`));
  });

  it("a DRY default pass sends nothing and says 'dry run', exactly as before", async () => {
    const { io, placed } = spyIo();
    const r = await runOnce({ io });
    assert.equal(placed.length, 0);
    assert.equal(r.eligible, 1);
    assert.ok(r.skipped.some((s) => s.why === "dry run"));
    assert.equal(r.copy, undefined);
  });

  it("the loss floor still halts before anything is read, on either venue", async () => {
    for (const executionVenue of EXECUTION_VENUES) {
      const { io, placed } = spyIo({ fetchRealisedPnl: async () => null });
      const r = await runOnce({ live: true, executionVenue, io, deps: dragonStub().deps });
      assert.match(r.halted ?? "", /cannot read realised P&L/);
      assert.equal(placed.length, 0, `${executionVenue} must not place with a broken floor`);
    }
  });
});

/* ══════════════════ 2. THE VENUE SWITCH ACTUALLY SWITCHES ═══════════════════ */

describe("the execution-venue switch", () => {
  it("dragon-tradar routes through dragon-copy and calls kalshi.placeOrder ZERO times", async () => {
    const { io, placed } = spyIo();
    const dragon = dragonStub();
    const r = await runOnce({
      live: true,
      executionVenue: "dragon-tradar",
      io,
      deps: dragon.deps,
      copyCaps: { perOrderCents: 500, perScanCents: 500 },
    });

    assert.equal(placed.length, 0, "★ the direct lane was NOT used");
    assert.ok(r.copy, "the dragon lane produced a plan");
    assert.equal(r.venue, "dragon-tradar");
    assert.equal(r.copy!.submission.live, true);
    assert.equal(r.copy!.clearance?.ok, true);
    assert.equal(r.copy!.clearance?.ok === true ? r.copy!.clearance.mode : "", "paper");
    assert.equal(dragon.orderPosts().length, 1, "one POST /order, not more");
    assert.equal(r.placed.length, 1);
    assert.equal(r.placed[0].ticker, "KXMLBGAME-26OCT04ATLNYM-ATL");
  });

  it("the body POSTed carries the intent verbatim — yes/buy, 40c, with an idempotency key", async () => {
    const { io } = spyIo();
    const dragon = dragonStub();
    const r = await runOnce({ live: true, executionVenue: "dragon-tradar", io, deps: dragon.deps });
    const order = r.copy!.plan.accepted[0];
    assert.equal(order.side, "yes");
    assert.equal(order.action, "buy");
    assert.equal(order.priceCents, 40);
    assert.equal(order.count, 1);
    assert.match(order.clientOrderId, /.+/);
    const prov = r.copy!.plan.provenance[order.clientOrderId];
    assert.equal(prov.venue, "polymarket");
    assert.equal(prov.sourceTrader, "SlimChance");
    assert.equal(prov.role, "taker", "crossing the ask is a TAKER fill, and must not claim otherwise");
  });

  it("a LIVE dragon pass makes exactly these requests, in this order, one attempt each", async () => {
    const { io } = spyIo();
    const dragon = dragonStub();
    await runOnce({ live: true, executionVenue: "dragon-tradar", io, deps: dragon.deps });
    // ★ /bot/state is read TWICE and that is deliberate, not a bug: the first
    //   read is THIS file's double-arm guard (is his own scanner running, what is
    //   the balance), the second is dragon-copy's own mode clearance, which
    //   `submitCopyBatch` structurally requires before it will send anything.
    //   Two reads of one endpoint, one attempt each, no retry anywhere — the
    //   429 lockout comes from a BAD TOKEN, not from a second GET.
    assert.deepEqual(
      dragon.calls.map((c) => `${c.method} ${c.url.replace(DRAGON_TRADAR_AGENT_BASE, "")}`),
      ["GET /bot/state", "GET /stats", "GET /bot/state", "POST /order"],
    );
  });

  it("a DRY dragon pass touches dragontradar.com ZERO times — one bad token there locks him out", async () => {
    const { io, placed } = spyIo();
    const dragon = dragonStub();
    const r = await runOnce({ executionVenue: "dragon-tradar", io, deps: dragon.deps });
    assert.equal(dragon.calls.length, 0, "★ not one request, not even a GET");
    assert.equal(placed.length, 0);
    assert.equal(r.copy!.submission.live, false);
    assert.equal(r.copy!.submission.sentCount, 0);
    assert.equal(r.copy!.clearance, null);
    assert.ok(r.copy!.plan.accepted.length >= 1, "but it still shows what it WOULD send");
  });

  it("the direct lane never POSTs to dragontradar.com", async () => {
    const { io } = spyIo();
    const dragon = dragonStub();
    await runOnce({ live: true, executionVenue: "kalshi-direct", io, deps: dragon.deps });
    assert.equal(dragon.calls.length, 0);
  });
});

/* ════════════════ 3. THE TWO LANES CANNOT BOTH ARM ══════════════════════════ */

describe("mutual exclusion — two engines, one bankroll", () => {
  it("armedExecutionLanes is NEVER longer than one, for every combination", () => {
    const venues: (LoopConfig["executionVenue"] | undefined)[] = [
      undefined,
      "kalshi-direct",
      "dragon-tradar",
      "nonsense" as never,
    ];
    for (const executionVenue of venues) {
      for (const live of [true, false, undefined]) {
        const armed = armedExecutionLanes({ executionVenue, live } as LoopConfig);
        assert.ok(armed.length <= 1, `${String(executionVenue)}/${String(live)} armed ${armed.length} lanes`);
        assert.equal(armed.length, live === true ? 1 : 0);
        assert.deepEqual(new Set(armed).size, armed.length, "no lane appears twice");
      }
    }
  });

  it("a dry run arms NOTHING — it cannot spend at all", () => {
    assert.deepEqual(armedExecutionLanes({ live: false, executionVenue: "dragon-tradar" } as LoopConfig), []);
    assert.deepEqual(armedExecutionLanes({ executionVenue: "kalshi-direct" } as LoopConfig), []);
  });

  it("a live run arms EXACTLY the venue it names, and only that one", () => {
    assert.deepEqual(armedExecutionLanes({ live: true, executionVenue: "dragon-tradar" } as LoopConfig), [
      "dragon-tradar",
    ]);
    assert.deepEqual(armedExecutionLanes({ live: true, executionVenue: "kalshi-direct" } as LoopConfig), [
      "kalshi-direct",
    ]);
  });

  it("going live on the dragon lane REFUSES while his own scanner is running", async () => {
    const dragon = dragonStub({ running: true });
    const guard = await guardDragonLane(dragon.deps, true);
    assert.equal(guard.ok, false);
    assert.match(guard.ok === false ? guard.detail : "", /his own scanner is RUNNING/);
    assert.match(guard.ok === false ? guard.detail : "", /autoFire=true/);
    // And it stopped BEFORE reading the balance — nothing else was asked for.
    assert.equal(dragon.calls.length, 1);
    assert.ok(dragon.calls[0].url.endsWith("/bot/state"));
  });

  it("runOnce halts on that refusal and places nothing, on either lane's send path", async () => {
    const { io, placed } = spyIo();
    const dragon = dragonStub({ running: true });
    const r = await runOnce({ live: true, executionVenue: "dragon-tradar", io, deps: dragon.deps });
    assert.match(r.halted ?? "", /two engines sizing against one bankroll/);
    assert.equal(placed.length, 0);
    assert.equal(dragon.orderPosts().length, 0);
    assert.equal(r.copy, undefined, "it halted before a plan was even built");
  });

  it("requireDragonIdle:false is the ONLY way past it, and it is explicit", async () => {
    const dragon = dragonStub({ running: true });
    const guard = await guardDragonLane(dragon.deps, false);
    assert.equal(guard.ok, true);
    assert.equal(guard.ok === true ? guard.balanceCents : -1, 4240);
  });

  it("an unreadable /bot/state refuses — it never shrugs and trades anyway", async () => {
    const fetchImpl = (async () =>
      ({ ok: false, status: 429, json: async () => ({ error: "temporarily_blocked" }) }) as unknown as Response) as unknown as typeof fetch;
    const guard = await guardDragonLane({ token: "x".repeat(64), fetchImpl }, true);
    assert.equal(guard.ok, false);
    assert.match(guard.ok === false ? guard.detail : "", /refusing to route orders through a bot whose state I cannot read/);
  });

  it("no token configured is a refusal, not an unguarded send", async () => {
    const guard = await guardDragonLane({ token: null }, true);
    assert.equal(guard.ok, false);
    assert.match(guard.ok === false ? guard.detail : "", /\/bot\/state came back off/);
  });
});

/* ═════════════════ the kalshi-leaderboard source, offline ═══════════════════ */

describe("the kalshi-leaderboard signal source", () => {
  const leaderboard = async () => [
    { nickname: NICK, socialId: "s1", value: 111068410, rank: 67, isAnonymous: false },
    { nickname: "hidden.guy", socialId: "s2", value: 86590110, rank: 87, isAnonymous: false },
  ];
  const socialDeps = {
    leaderboard,
    trades: async (nickname: string) =>
      nickname === NICK
        ? { trades: [row(MAKER_ROW_RAW), row(TAKER_ROW_RAW)], visibility: "visible" }
        : { trades: [] as KalshiPublicTrade[], visibility: "hidden" },
    resolveFill,
  };

  it("resolves fills with the inversion applied, and names every hidden trader", async () => {
    const scan = await scanKalshiLeaderboardIntents(
      {
        ...DEFAULTS,
        signalConfig: { includeMakerFills: true, maxSignalAgeMin: 10_000_000 },
      } as LoopConfig,
      socialDeps,
    );
    assert.equal(scan.checked.kalshiTraders, 2);
    assert.equal(scan.checked.kalshiVisible, 1);
    const no = scan.intents.find((i) => i.side === "no");
    assert.ok(no, "the maker row produced an intent");
    assert.equal(no!.action, "buy", "★ taker SOLD no => our maker BOUGHT no. The flip survived.");
    assert.equal(no!.role, "maker");
    const yes = scan.intents.find((i) => i.side === "yes");
    assert.equal(yes!.action, "buy", "the taker row passes through verbatim");
    assert.equal(yes!.role, "taker");
    assert.ok(
      scan.rejected.some((r) => r.reason === "trades_hidden" && r.detail.includes("hidden.guy")),
      "the hidden trader is named, not silently dropped",
    );
  });

  it("maker fills are EXCLUDED by default — a maker collected the spread we would pay", async () => {
    const scan = await scanKalshiLeaderboardIntents(
      { ...DEFAULTS, signalConfig: { maxSignalAgeMin: 10_000_000 } } as LoopConfig,
      socialDeps,
    );
    assert.equal(scan.intents.length, 1);
    assert.equal(scan.intents[0].role, "taker");
    assert.ok(scan.rejected.some((r) => r.reason === "maker_fill_unmirrorable"));
  });

  it("routes leaderboard intents through the dragon lane when that venue is selected", async () => {
    const { io, placed } = spyIo({ scanCandidates: async () => [] });
    const dragon = dragonStub();
    const r = await runOnce({
      live: true,
      sources: ["kalshi-leaderboard"],
      executionVenue: "dragon-tradar",
      io,
      deps: dragon.deps,
      kalshiSocialDeps: socialDeps,
      signalConfig: { maxSignalAgeMin: 10_000_000 },
    });
    assert.equal(placed.length, 0);
    assert.ok(r.leaderboard, "the lane reported its own bookkeeping");
    assert.equal(r.leaderboard!.checked.kalshiVisible, 1);
    assert.equal(dragon.orderPosts().length, 1);
    assert.equal(r.copy!.plan.accepted[0].ticker, "KXNHL2P-26OCT04WPGDET-TIE");
  });

  it("BOTH sources can read at once — reading is not spending, so that is allowed", async () => {
    const { io } = spyIo();
    const dragon = dragonStub();
    const r = await runOnce({
      live: true,
      sources: ["polymarket-edge", "kalshi-leaderboard"],
      executionVenue: "dragon-tradar",
      io,
      deps: dragon.deps,
      kalshiSocialDeps: socialDeps,
      signalConfig: { maxSignalAgeMin: 10_000_000 },
    });
    assert.deepEqual(r.sources, ["polymarket-edge", "kalshi-leaderboard"]);
    // Two signals, ONE venue, one batch, one set of caps. That is the point:
    // two sources cannot double-commit because only one lane does the sending.
    assert.equal(armedExecutionLanes({ live: true, executionVenue: "dragon-tradar" } as LoopConfig).length, 1);
    assert.ok(r.copy, "exactly one plan governs the whole pass");
  });
});

/* ════════════ the direct lane refuses what it cannot express ════════════════ */

describe("intentToDirectKalshiOrder — no coerced sides", () => {
  const base: CopyIntent = {
    venue: "kalshi",
    sourceTrader: NICK,
    ticker: "KXNHL2P-26OCT04WPGDET-TIE",
    side: "yes",
    action: "buy",
    priceCents: 35,
    count: 2,
    role: "taker",
    observedAt: "2026-10-04T18:41:59.127169Z",
    confidence: 0.4,
    why: "test",
  };

  it("passes a yes/buy through as a bid", () => {
    const got = intentToDirectKalshiOrder(base);
    assert.equal(got.ok, true);
    assert.deepEqual(got.ok === true ? got : null, {
      ok: true,
      ticker: base.ticker,
      side: "bid",
      count: 2,
      priceDollars: 0.35,
    });
  });

  it("REFUSES a NO-side intent by name instead of inverting it onto a bid", () => {
    const got = intentToDirectKalshiOrder({ ...base, side: "no" });
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.why : "", /not expressible on the kalshi-direct lane/);
    assert.match(got.ok === false ? got.why : "", /route it through dragon-tradar/);
  });

  it("REFUSES a sell — the pre-existing lane only ever bought", () => {
    const got = intentToDirectKalshiOrder({ ...base, action: "sell" });
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.why : "", /not expressible/);
  });

  it("refuses an unmatched Polymarket intent (no ticker to send)", () => {
    const got = intentToDirectKalshiOrder({ ...base, venue: "polymarket", ticker: null });
    assert.equal(got.ok, false);
    assert.match(got.ok === false ? got.why : "", /no kalshi ticker/);
  });

  it("refuses a decided price and a nonsense count", () => {
    assert.equal(intentToDirectKalshiOrder({ ...base, priceCents: 0 }).ok, false);
    assert.equal(intentToDirectKalshiOrder({ ...base, priceCents: 100 }).ok, false);
    assert.equal(intentToDirectKalshiOrder({ ...base, count: 0 }).ok, false);
    assert.equal(intentToDirectKalshiOrder({ ...base, count: 1.5 }).ok, false);
  });

  it("an UNREADABLE shard balance blocks the direct leaderboard send — unknown money is not available money", async () => {
    const { io, placed } = spyIo({
      scanCandidates: async () => [],
      // null = the read failed / the key is not linked.
      fetchShardBalances: async () => null,
    });
    const r = await runOnce({
      live: true,
      sources: ["kalshi-leaderboard"],
      executionVenue: "kalshi-direct",
      io,
      kalshiSocialDeps: {
        leaderboard: async () => [
          { nickname: NICK, socialId: "s1", value: 111068410, rank: 67, isAnonymous: false },
        ],
        trades: async () => ({ trades: [row(TAKER_ROW_RAW)], visibility: "visible" }),
        resolveFill,
      },
      signalConfig: { maxSignalAgeMin: 10_000_000 },
    });
    assert.equal(placed.length, 0, "★ nothing goes out without a collateral check");
    assert.ok(r.skipped.some((s) => /cannot read shard balances/.test(s.why)));
  });

  it("on the direct lane a NO-side leaderboard intent is reported, not placed", async () => {
    const { io, placed } = spyIo({ scanCandidates: async () => [] });
    const r = await runOnce({
      live: true,
      sources: ["kalshi-leaderboard"],
      executionVenue: "kalshi-direct",
      io,
      kalshiSocialDeps: {
        leaderboard: async () => [
          { nickname: NICK, socialId: "s1", value: 111068410, rank: 67, isAnonymous: false },
        ],
        trades: async () => ({ trades: [row(MAKER_ROW_RAW)], visibility: "visible" }),
        resolveFill,
      },
      signalConfig: { includeMakerFills: true, maxSignalAgeMin: 10_000_000 },
    });
    assert.equal(placed.length, 0, "★ nothing was sent on the wrong side");
    assert.ok(r.skipped.some((s) => /not expressible on the kalshi-direct lane/.test(s.why)));
  });
});

/* ═══════════════════ candidateToIntent — the edge-lane bridge ═══════════════ */

describe("candidateToIntent", () => {
  it("always yes/buy/taker, because that is all the old lane ever did", () => {
    const i = candidateToIntent(candidate(), DEFAULTS);
    assert.equal(i.venue, "polymarket");
    assert.equal(i.side, "yes");
    assert.equal(i.action, "buy");
    assert.equal(i.role, "taker");
    assert.equal(i.priceCents, 40);
    assert.equal(i.ticker, "KXMLBGAME-26OCT04ATLNYM-ATL");
    assert.equal(i.sourceTrader, "SlimChance");
    assert.match(i.why, /\$0\.07 cheaper/);
  });

  it("falls back to the public wallet address when no pseudonym was captured", () => {
    const i = candidateToIntent(candidate({ trader: undefined }), DEFAULTS);
    assert.equal(i.sourceTrader, "0xWALLET");
  });

  it("confidence is clamped to 0..1 across the whole edge range", () => {
    for (const edgeDollars of [-5, 0, 0.02, 0.07, 0.15, 5]) {
      const c = candidateToIntent(candidate({ edgeDollars }), DEFAULTS).confidence;
      assert.ok(c >= 0 && c <= 1, `edge ${edgeDollars} gave confidence ${c}`);
    }
    assert.equal(candidateToIntent(candidate({ edgeDollars: 0.02 }), DEFAULTS).confidence, 0);
    assert.equal(candidateToIntent(candidate({ edgeDollars: 0.15 }), DEFAULTS).confidence, 1);
  });
});

/* ═══════════════════ 4. copy_scan IS READ-SCOPED ════════════════════════════ */

describe("the voice verb copy_scan", () => {
  // Read as SOURCE, not imported: a Next route file may only export the HTTP
  // verbs and the route-config names, so WRITE_ACTIONS cannot be exported for a
  // test to read. The literal in the file is the source of truth either way.
  const ROUTE = readFileSync(
    new URL("../src/app/api/voice-tools/[action]/route.ts", import.meta.url),
    "utf8",
  );

  /** Just the contents of the `WRITE_ACTIONS` Set literal. */
  const writeLiteral = (() => {
    const m = /const WRITE_ACTIONS = new Set\(\[([^\]]*)\]\)/.exec(ROUTE);
    assert.ok(m, "WRITE_ACTIONS literal must still be findable — the gate depends on it");
    return m[1];
  })();

  const writeActions = [...writeLiteral.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  it("the WRITE_ACTIONS set is exactly the four spenders/mutators it was", () => {
    assert.deepEqual(writeActions.sort(), ["funding_status", "note", "remember", "trade"].sort());
  });

  it("★ copy_scan is NOT in WRITE_ACTIONS, so it takes the READ token", () => {
    assert.ok(!writeActions.includes("copy_scan"));
    // And the scope is derived from exactly that set, which is why this matters.
    assert.match(ROUTE, /WRITE_ACTIONS\.has\(action\) \? "write" : "read"/);
  });

  it("copy_scan is actually wired as a case, so the verb exists at all", () => {
    assert.match(ROUTE, /case "copy_scan":/);
    assert.match(ROUTE, /return say\(await copyScan\(/);
  });

  it("there is NO copy-EXECUTE verb on this route", () => {
    for (const forbidden of ["copy_fire", "copy_execute", "copy_place", "copy_trade", "copy_live"]) {
      assert.ok(!ROUTE.includes(`case "${forbidden}"`), `${forbidden} must not exist here`);
    }
    // The only sender on this route is still `trade`, and it still takes the
    // write token AND an explicit ?live=true.
    assert.match(ROUTE, /case "trade":\s*\n\s*return say\(await spokenTrade\(url\.searchParams\.get\("live"\) === "true"\)\)/);
  });

  it("copy_scan's helper never writes and never POSTs", () => {
    const body = ROUTE.slice(ROUTE.indexOf("async function copyScan("), ROUTE.indexOf("type FundingLead"));
    assert.ok(body.length > 100, "found the helper");
    assert.ok(!/writeFile/.test(body), "copy_scan must not write a file");
    assert.ok(!/method:\s*"POST"/.test(body), "copy_scan must not POST");
    assert.ok(!/placeOrder|submitCopyBatch|runCopyLane/.test(body), "copy_scan must not reach an order path");
    assert.ok(!/readAgent|readBotState|dragontradar/.test(body), "copy_scan must not touch dragontradar.com from a call");
  });
});

/* ══════ 5. THE kalshi-direct LANE'S PASS BUDGET AND ITS COLLATERAL ══════════ */

describe("the kalshi-direct lane cannot commit the account N times", () => {
  /** Three distinct tickers, each a 40c order, each affordable on its own. */
  const three = (): Candidate[] =>
    ["KXA", "KXB", "KXC"].map((t) =>
      candidate({ match: { ...candidate().match, ticker: t } as Candidate["match"] }),
    );

  it("all three go out when the pass budget is wide — each one IS individually legal", async () => {
    const { io, placed } = spyIo({ scanCandidates: async () => three() });
    const r = await runOnce({ live: true, io });
    assert.equal(placed.length, 3, "the three orders are each affordable and each legal");
    assert.deepEqual(r.placed.map((p) => p.ticker), ["KXA", "KXB", "KXC"]);
  });

  it("★ the pass budget blocks order 3 even though order 3 passes alone", async () => {
    const { io, placed } = spyIo({ scanCandidates: async () => three() });
    // 100c of budget. Each order is 40c: two fit (80c), the third would make 120c.
    const r = await runOnce({ live: true, io, directPerScanCents: 100 });
    assert.equal(placed.length, 2, "★ exactly two sent — the running total stopped the third");
    assert.deepEqual(r.placed.map((p) => p.ticker), ["KXA", "KXB"]);
    const blocked = r.skipped.find((x) => x.ticker === "KXC");
    assert.ok(blocked, "the blocked one is named, never silently dropped");
    assert.match(blocked!.why, /past its 100c budget \(80c already committed\)/);
    // And it is not counted as eligible: eligible means it could have been sent.
    assert.equal(r.eligible, 2);
  });

  it("★ the shard snapshot DECREMENTS — it is free collateral, not a fixed read", async () => {
    const { io, placed } = spyIo({
      scanCandidates: async () => three(),
      // $1.00 on shard 0. Three 40c orders need $1.20.
      fetchShardBalances: async () => [{ exchangeIndex: 0, label: "Default", dollars: 1 }],
    });
    const r = await runOnce({ live: true, io });
    assert.equal(placed.length, 2, "★ two fit in a dollar; the old snapshot read would have sent three");
    assert.ok(
      r.skipped.some((x) => x.ticker === "KXC" && /shard 0 has \$0\.20, needs \$0\.40/.test(x.why)),
      `expected a decremented shard balance, got ${JSON.stringify(r.skipped)}`,
    );
  });

  it("a DRY pass consumes the same budget, so it previews the live pass honestly", async () => {
    const { io, placed } = spyIo({ scanCandidates: async () => three() });
    const r = await runOnce({ io, directPerScanCents: 100 });
    assert.equal(placed.length, 0, "dry sends nothing");
    assert.equal(r.eligible, 2, "and reports the two a live pass could actually have placed");
    assert.ok(r.skipped.some((x) => x.ticker === "KXC" && /budget/.test(x.why)));
  });

  it("the per-ORDER cap refuses one oversized order outright", async () => {
    const { io, placed } = spyIo();
    const r = await runOnce({ live: true, io, directPerOrderCents: 30 });
    assert.equal(placed.length, 0);
    assert.ok(r.skipped.some((x) => /over the 30c per-order cap/.test(x.why)));
  });

  it("the budget is shared with the leaderboard source — two sources, ONE wallet", async () => {
    const { io, placed } = spyIo({ scanCandidates: async () => three() });
    const r = await runOnce({
      live: true,
      sources: ["polymarket-edge", "kalshi-leaderboard"],
      executionVenue: "kalshi-direct",
      io,
      directPerScanCents: 80,
      kalshiSocialDeps: {
        leaderboard: async () => [
          { nickname: NICK, socialId: "s1", value: 111068410, rank: 67, isAnonymous: false },
        ],
        trades: async () => ({ trades: [row(TAKER_ROW_RAW)], visibility: "visible" }),
        resolveFill,
      },
      signalConfig: { maxSignalAgeMin: 10_000_000 },
    });
    // 80c of budget is spent by the first two candidates; the leaderboard
    // intent behind them (35c) finds nothing left. One accumulator, one wallet.
    assert.equal(placed.length, 2);
    assert.ok(
      r.skipped.some((x) => x.ticker === "KXNHL2P-26OCT04WPGDET-TIE" && /budget/.test(x.why)),
      `the leaderboard intent must hit the SAME budget, got ${JSON.stringify(r.skipped)}`,
    );
  });

  it("resolveDirectCaps only ever TIGHTENS, exactly like dragon-copy's resolveCaps", () => {
    assert.deepEqual(resolveDirectCaps(), {
      perOrderCents: DIRECT_PER_ORDER_DEFAULT_CENTS,
      perScanCents: DIRECT_PER_SCAN_DEFAULT_CENTS,
    });
    // A caller asking for the moon gets the ceiling.
    assert.deepEqual(resolveDirectCaps({ directPerOrderCents: 1e9, directPerScanCents: 1e9 }), {
      perOrderCents: DIRECT_PER_ORDER_DEFAULT_CENTS,
      perScanCents: DIRECT_PER_SCAN_DEFAULT_CENTS,
    });
    // Nonsense falls back to the ceiling, never to "no limit".
    for (const bad of [0, -1, Number.NaN, Infinity, "500" as never, null as never]) {
      assert.deepEqual(resolveDirectCaps({ directPerScanCents: bad }).perScanCents, DIRECT_PER_SCAN_DEFAULT_CENTS);
    }
    // One order can never be allowed to eat more than the whole pass may commit.
    const tight = resolveDirectCaps({ directPerScanCents: 50 });
    assert.equal(tight.perScanCents, 50);
    assert.equal(tight.perOrderCents, 50);
  });
});

/* ══════ 6. AN UNKNOWN SEND IS RECORDED AS ACTED ════════════════════════════ */

describe("a send whose outcome is UNKNOWN is never re-fired", () => {
  it("★ a dropped connection on POST /order is recorded as acted, in BOTH key spaces", async () => {
    const { io, placed, saved } = spyIo();
    const dragon = dragonStub({ orderNetworkFail: true });
    const r = await runOnce({ live: true, executionVenue: "dragon-tradar", io, deps: dragon.deps });

    assert.equal(placed.length, 0, "the direct lane was not used");
    assert.equal(r.placed.length, 0, "and nothing is claimed as placed — it is UNKNOWN, not done");
    const o = r.copy!.submission.outcomes[0];
    assert.equal(o.disposition, "sent");
    assert.equal(o.disposition === "sent" ? o.result.state : "", "error");
    assert.equal(o.disposition === "sent" && o.result.state === "error" ? o.result.status : -1, 0);
    assert.ok(
      r.skipped.some((x) => /UNKNOWN whether it landed/.test(x.why)),
      `the ambiguity must be stated, got ${JSON.stringify(r.skipped)}`,
    );

    // ★ THE STATE WAS SAVED, although nothing "succeeded".
    assert.equal(saved.length, 1, "★ a timeout-only pass still persists the record");
    const last = saved.at(-1)!;
    const key = r.copy!.plan.provenance[o.clientOrderId].intentKey;
    assert.equal(key, "polymarket|SlimChance|KXMLBGAME-26OCT04ATLNYM-ATL|yes|buy");
    assert.ok(last.actedIntents!.includes(key), "the intentKey was recorded");
    assert.ok(
      last.acted.includes(`${new Date().toISOString().slice(0, 10)}|KXMLBGAME-26OCT04ATLNYM-ATL`),
      "and so was the day|ticker key",
    );
  });

  it("★ the NEXT pass does not re-send it — that is the whole point", async () => {
    const { io, saved } = spyIo();
    await runOnce({
      live: true,
      executionVenue: "dragon-tradar",
      io,
      deps: dragonStub({ orderNetworkFail: true }).deps,
    });
    const carried = saved.at(-1)!;

    const second = spyIo({ loadState: async () => carried });
    const dragon2 = dragonStub();
    const r2 = await runOnce({
      live: true,
      executionVenue: "dragon-tradar",
      io: second.io,
      deps: dragon2.deps,
    });
    assert.equal(dragon2.orderPosts().length, 0, "★ ZERO re-sends of a possibly-filled order");
    assert.equal(r2.placed.length, 0);
    assert.ok(
      r2.skipped.some((x) => x.why === "already acted today"),
      `expected the day|ticker guard to catch it, got ${JSON.stringify(r2.skipped)}`,
    );
  });

  it("a 429 is NOT unknown — his app refused, so the intent stays eligible", async () => {
    const { io, saved } = spyIo();
    const dragon = dragonStub({ orderStatus: 429 });
    const r = await runOnce({ live: true, executionVenue: "dragon-tradar", io, deps: dragon.deps });
    const o = r.copy!.submission.outcomes[0];
    assert.equal(o.disposition === "sent" ? o.result.state : "", "blocked");
    assert.ok(r.skipped.some((x) => x.why === "dragon-tradar blocked"));
    assert.equal(saved.length, 0, "★ nothing recorded — a blocked request never became an order");
  });

  it("an order that is never attempted is not recorded either", async () => {
    // No token => `state: "off"`, zero network calls, nothing can have landed.
    const { io, saved } = spyIo();
    const r = await runOnce({
      live: true,
      executionVenue: "dragon-tradar",
      io,
      deps: { token: null },
      requireDragonIdle: false,
    });
    // It never even reaches the plan: the double-arm guard reads /bot/state first.
    assert.match(r.halted ?? "", /came back off/);
    assert.equal(saved.length, 0);
  });
});

/* ══════ 7. THE day|ticker GUARD APPLIES ON THE DRAGON LANE ═════════════════ */

describe("one ticker, one day, on BOTH lanes", () => {
  /** Two visible traders, both signalling the SAME ticker. Different intentKeys. */
  const twoOnOneTicker = {
    leaderboard: async () => [
      { nickname: NICK, socialId: "s1", value: 111068410, rank: 67, isAnonymous: false },
      { nickname: "Unitdor", socialId: "s2", value: 86590110, rank: 87, isAnonymous: false },
    ],
    trades: async (nickname: string) => ({
      trades: [
        row({
          ...TAKER_ROW_RAW,
          taker_nickname: nickname,
          maker_nickname: nickname === NICK ? "Unitdor" : NICK,
          trade_id: nickname === NICK ? TAKER_ROW_RAW.trade_id : "072528dd-0000-0000-0000-000000000001",
        }),
      ],
      visibility: "visible",
    }),
    resolveFill,
  };

  it("★ two traders on ONE ticker produce ONE order on the dragon lane", async () => {
    const { io } = spyIo({ scanCandidates: async () => [] });
    const dragon = dragonStub();
    const r = await runOnce({
      live: true,
      sources: ["kalshi-leaderboard"],
      executionVenue: "dragon-tradar",
      io,
      deps: dragon.deps,
      kalshiSocialDeps: twoOnOneTicker,
      signalConfig: { maxSignalAgeMin: 10_000_000 },
    });
    assert.equal(r.leaderboard!.intents, 2, "both signals were READ — the guard is not a scan filter");
    assert.equal(r.copy!.plan.accepted.length, 1, "★ but only ONE order was planned");
    assert.equal(dragon.orderPosts().length, 1, "★ and only one POST /order went out");
    assert.ok(
      r.skipped.some((x) => x.ticker === "KXNHL2P-26OCT04WPGDET-TIE" && x.why === "already acted today"),
      `the second trader's signal must be named, got ${JSON.stringify(r.skipped)}`,
    );
  });

  it("★ the dragon lane PERSISTS the day|ticker key, so the next pass is guarded", async () => {
    const { io, saved } = spyIo();
    const r = await runOnce({
      live: true,
      executionVenue: "dragon-tradar",
      io,
      deps: dragonStub().deps,
    });
    assert.equal(r.placed.length, 1);
    const day = new Date().toISOString().slice(0, 10);
    assert.ok(
      saved.at(-1)!.acted.includes(`${day}|KXMLBGAME-26OCT04ATLNYM-ATL`),
      "★ state.acted — the key this lane never used to write",
    );

    const second = spyIo({ loadState: async () => saved.at(-1)! });
    const dragon2 = dragonStub();
    const r2 = await runOnce({
      live: true,
      executionVenue: "dragon-tradar",
      io: second.io,
      deps: dragon2.deps,
    });
    assert.equal(dragon2.orderPosts().length, 0);
    assert.ok(r2.skipped.some((x) => x.why === "already acted today"));
  });

  it("a ticker the DIRECT lane took is also refused on the dragon lane", async () => {
    const { io, saved } = spyIo();
    await runOnce({ live: true, io });
    const carried = saved.at(-1)!;
    const second = spyIo({ loadState: async () => carried });
    const dragon = dragonStub();
    const r2 = await runOnce({
      live: true,
      executionVenue: "dragon-tradar",
      io: second.io,
      deps: dragon.deps,
    });
    assert.equal(dragon.orderPosts().length, 0, "★ one key space, honoured by both lanes");
    assert.ok(r2.skipped.some((x) => x.why === "already acted today"));
  });
});

/* ══════ 8. NOTHING IN PRODUCTION ARMS THE NEW LANE ═════════════════════════ */

describe("the new lane is unarmed in production, and provably so", () => {
  const src = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

  it("★ DEFAULTS are the pre-2026-10-04 behaviour, field by field", () => {
    assert.deepEqual(DEFAULTS.sources, ["polymarket-edge"]);
    assert.equal(DEFAULTS.executionVenue, "kalshi-direct");
    assert.equal(DEFAULTS.live, false);
    assert.equal(DEFAULTS.requireDragonIdle, true);
    // Arming is a three-part opt-in and none of the three is on by default.
    assert.deepEqual(armedExecutionLanes(DEFAULTS), [], "the defaults arm NOTHING");
    assert.deepEqual(signalSourcesOf(DEFAULTS), ["polymarket-edge"]);
    assert.equal(executionVenueOf(DEFAULTS), "kalshi-direct");
  });

  it("the direct lane's new ceilings are the documented constants", () => {
    assert.equal(DEFAULTS.directPerOrderCents, DIRECT_PER_ORDER_DEFAULT_CENTS);
    assert.equal(DEFAULTS.directPerScanCents, DIRECT_PER_SCAN_DEFAULT_CENTS);
    assert.equal(DIRECT_PER_ORDER_DEFAULT_CENTS, 2_000);
    assert.equal(DIRECT_PER_SCAN_DEFAULT_CENTS, 2_000);
  });

  it("★ NEITHER runOnce CALLER passes sources or executionVenue", () => {
    // Read as SOURCE on purpose: the claim is about what those files DO, and a
    // future edit that quietly arms the lane has to fail somewhere.
    for (const rel of ["../src/lib/tools/trade-voice.ts", "../scripts/starra-trade-loop.ts"]) {
      const text = src(rel);
      assert.match(text, /runOnce\(/, `${rel} must still be a runOnce caller for this test to mean anything`);
      assert.ok(!/executionVenue/.test(text), `${rel} must not set executionVenue`);
      assert.ok(!/\bsources\s*:/.test(text), `${rel} must not set sources`);
      // The enum VALUE in a config position. `@/lib/dragon-tradar` as an import
      // path is fine and expected — that module is how the file reads his bot.
      assert.ok(!/:\s*"dragon-tradar"/.test(text), `${rel} must not name the dragon venue`);
      assert.ok(!/"kalshi-leaderboard"/.test(text), `${rel} must not name the leaderboard source`);
    }
  });

  it("the arming instructions are written down at DEFAULTS, not left to be inferred", () => {
    const loop = src("../src/lib/copy-loop.ts");
    const doc = loop.slice(0, loop.indexOf("export const DEFAULTS"));
    for (const needed of [
      'sources: ["kalshi-leaderboard"]',
      'executionVenue: "dragon-tradar"',
      "live: true",
      "trade-voice.ts",
      "starra-trade-loop.ts",
    ]) {
      assert.ok(doc.includes(needed), `the DEFAULTS doc must name ${needed}`);
    }
  });

  it("and the two lanes still cannot both arm — ONE enum, not two booleans", () => {
    // Re-asserted here beside the defaults, because this is the invariant the
    // pass budget depends on: two engines sizing against one bankroll is how the
    // same $42.40 gets committed twice, and no config can produce that.
    for (const executionVenue of EXECUTION_VENUES) {
      assert.equal(armedExecutionLanes({ executionVenue, live: true } as LoopConfig).length, 1);
    }
    const loop = src("../src/lib/copy-loop.ts");
    assert.match(loop, /executionVenue\?: ExecutionVenue;/, "it must stay ONE value, never a set");
  });
});
