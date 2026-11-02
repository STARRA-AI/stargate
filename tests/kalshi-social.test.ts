/**
 * KALSHI SOCIAL — the tests that stand between a copied signal and an INVERTED
 * position in Classic's account.
 *
 * The load-bearing property is one line of accounting: Kalshi's public trade row
 * reports the TAKER's side and action even when the trader we are following was
 * the MAKER, and on the two traders whose tapes are readable at all they were the
 * maker on 80% and 91% of rows. Copying `taker_action` verbatim therefore takes
 * the OPPOSITE position on most trades. That is the bug these tests exist to
 * make impossible to reintroduce.
 *
 * EVERY raw row below is VERBATIM from a live, keyless GET on 2026-10-04:
 *   https://api.elections.kalshi.com/v1/social/trades
 *       ?nickname=BitcoinTradingChallenge&page_size=100
 *   → HTTP 200, 36,200 bytes, 100 rows, visibility_state "visible",
 *     maker 80 / taker 20 / neither 0.
 * Nothing here is hand-written trade data, and nothing here touches the network:
 * globalThis.fetch is replaced with a thrower for the whole file.
 */
import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import {
  clampLeaderboardLimit,
  clampPageSize,
  fetchKalshiLeaderboard,
  fetchKalshiPublicTrades,
  findVisibleTraders,
  isVisible,
  normaliseTradeRow,
  resolveFill,
  summariseTrader,
  volumeDollars,
  type KalshiLeader,
  type KalshiPublicTrade,
  sidePriceCents,
} from "../src/lib/kalshi-social";

/* ----------------------------------------------------- the network is closed */

const ORIGINAL_FETCH = globalThis.fetch;

/**
 * Default state for this file: ANY unstubbed request fails loudly. A test that
 * needs HTTP installs its own stub and restores this guard.
 */
function closeTheNetwork() {
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`a test reached the real network: ${String(input)}`);
  }) as unknown as typeof fetch;
}
closeTheNetwork();
after(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function stubRoutes(handler: (url: string) => { status?: number; body?: unknown }) {
  const urls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    const { status = 200, body = {} } = handler(url);
    inFlight--;
    if (status >= 400) {
      return { ok: false, status, json: async () => body } as unknown as Response;
    }
    return { ok: true, status, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
  return { urls, maxInFlight: () => maxInFlight };
}

/* ------------------------------------------------------- the measured fixtures */

/**
 * VERBATIM maker row. BitcoinTradingChallenge is the MAKER; the counterparty
 * nickname is "" (anonymised). The taker SOLD NO, so those NO contracts landed
 * with the maker: our trader BOUGHT NO.
 */
const MAKER_ROW = {
  count: 301,
  count_fp: "301.52",
  create_date: "2026-10-04T18:47:36.806999Z",
  maker_nickname: "BitcoinTradingChallenge",
  market_id: "01a10689-7d45-7a38-9207-e93502d43245",
  price: 99,
  price_dollars: "0.9900",
  taker_action: "sell",
  taker_nickname: "",
  taker_side: "no",
  ticker: "KXWNBA1QWINNER-26OCT04NYATL-NY",
  trade_id: "072528c9-5f99-b3d5-dea1-0eefa2fdc4be",
};

/** VERBATIM taker row. Here our trader crossed the spread: verbatim side/action. */
const TAKER_ROW = {
  count: 1,
  count_fp: "1.99",
  create_date: "2026-10-04T18:41:59.127169Z",
  maker_nickname: "Unitdor",
  market_id: "01a0fdfe-edbe-764a-9cd1-f09b3770ff3c",
  price: 99,
  price_dollars: "0.9900",
  taker_action: "buy",
  taker_nickname: "BitcoinTradingChallenge",
  taker_side: "yes",
  ticker: "KXNHL2P-26OCT04WPGDET-TIE",
  trade_id: "072528dc-b359-9304-fc27-84d536cb0e86",
};

const NICK = "BitcoinTradingChallenge";

function row(raw: unknown): KalshiPublicTrade {
  const mapped = normaliseTradeRow(raw);
  assert.ok(mapped, "fixture must map");
  return mapped;
}

/* ----------------------------------------------------------------- the mapper */

describe("normaliseTradeRow — snake_case tape → camelCase, no interpretation", () => {
  it("maps every key of a verbatim row", () => {
    const m = row(MAKER_ROW);
    assert.equal(m.tradeId, "072528c9-5f99-b3d5-dea1-0eefa2fdc4be");
    assert.equal(m.marketId, "01a10689-7d45-7a38-9207-e93502d43245");
    assert.equal(m.ticker, "KXWNBA1QWINNER-26OCT04NYATL-NY");
    assert.equal(m.price, 99);
    assert.equal(m.priceDollars, "0.9900");
    assert.equal(m.count, 301);
    assert.equal(m.countFp, "301.52");
    assert.equal(m.takerSide, "no");
    assert.equal(m.takerAction, "sell");
    assert.equal(m.makerNickname, NICK);
    assert.equal(m.takerNickname, "");
    // The timestamp field is create_date. There is no created_time and no ts.
    assert.equal(m.createDate, "2026-10-04T18:47:36.806999Z");
  });

  it("returns null for a row that is not an object", () => {
    assert.equal(normaliseTradeRow(null), null);
    assert.equal(normaliseTradeRow(7), null);
    assert.equal(normaliseTradeRow("KXNHL"), null);
    assert.equal(normaliseTradeRow([MAKER_ROW]), null);
  });
});

/* ------------------------------------------------- THE MAKER/TAKER INVERSION */

describe("resolveFill — the maker/taker inversion", () => {
  it("MAKER row: side is preserved, action FLIPS (taker sold no ⇒ maker bought no)", () => {
    const fill = resolveFill(row(MAKER_ROW), NICK);
    assert.ok(fill, "a verbatim maker row must resolve");
    assert.equal(fill.side, "no");
    assert.equal(fill.action, "buy");
    assert.equal(fill.role, "maker");
    // ★ WAS `99` AND THAT ASSERTED THE BUG AS CORRECT. The social feed's price is
    //   the YES price whatever side anyone took (verified: 41 rows matched by
    //   trade_id against /trade-api/v2/markets/trades, social.price === yes_price
    //   on all 41). This row is a 99c YES print and the trader held NO, so their
    //   side cost 1c. See sidePriceCents().
    assert.equal(fill.priceCents, 1);
    assert.equal(fill.count, 301);
    assert.equal(fill.marketKey, "KXWNBA1QWINNER-26OCT04NYATL-NY");
    assert.equal(fill.tradeId, "072528c9-5f99-b3d5-dea1-0eefa2fdc4be");
    assert.equal(fill.observedAt, "2026-10-04T18:47:36.806999Z");
  });

  it("TAKER row: side and action are verbatim", () => {
    const fill = resolveFill(row(TAKER_ROW), NICK);
    assert.ok(fill, "a verbatim taker row must resolve");
    assert.equal(fill.side, "yes");
    assert.equal(fill.action, "buy");
    assert.equal(fill.role, "taker");
    assert.equal(fill.count, 1, "count floors count_fp 1.99 → 1, matching the server");
  });

  it("the SAME row resolves differently for the OTHER party — the role is per trader", () => {
    const asUnitdor = resolveFill(row(TAKER_ROW), "Unitdor");
    assert.ok(asUnitdor);
    assert.equal(asUnitdor.role, "maker");
    assert.equal(asUnitdor.side, "yes", "side is the contract type, same for both parties");
    assert.equal(asUnitdor.action, "sell", "the maker is the other side of the taker's buy");
  });

  it("a row where the nickname matches NEITHER party returns null", () => {
    assert.equal(resolveFill(row(TAKER_ROW), "szg.szg"), null);
    assert.equal(resolveFill(row(MAKER_ROW), "szg.szg"), null);
  });

  it("an anonymised counterparty ('') never matches, and an empty nickname never resolves", () => {
    assert.equal(resolveFill(row(MAKER_ROW), ""), null);
    assert.equal(resolveFill(row(MAKER_ROW), "   "), null);
  });

  it("a self-trade (both parties the same nickname) is undecidable → null", () => {
    const selfTrade = row({ ...MAKER_ROW, taker_nickname: NICK });
    assert.equal(resolveFill(selfTrade, NICK), null);
  });

  it("matching is EXACT — a case variant is not silently bound to the account", () => {
    assert.equal(resolveFill(row(MAKER_ROW), "bitcointradingchallenge"), null);
  });
});

/* ------------------------------------------------------- THE REGRESSION GUARD */

describe("REGRESSION — a maker fill must never be copied with the taker fields verbatim", () => {
  it("the resolved action is the OPPOSITE of taker_action on the measured maker row", () => {
    const fill = resolveFill(row(MAKER_ROW), NICK);
    assert.ok(fill);
    assert.notEqual(
      fill.action,
      MAKER_ROW.taker_action,
      "copying taker_action verbatim on a maker row SELLS what the trader BOUGHT — " +
        "an inverted position on ~80% of this trader's rows",
    );
    assert.equal(fill.action, "buy");
    assert.equal(
      fill.side,
      MAKER_ROW.taker_side,
      "side IS preserved — the flip is on action only; flipping side too is the mirror bug",
    );
  });

  it("the full flip table holds for all four maker combinations", () => {
    const cases = [
      { takerSide: "no", takerAction: "sell", side: "no", action: "buy" },
      { takerSide: "no", takerAction: "buy", side: "no", action: "sell" },
      { takerSide: "yes", takerAction: "buy", side: "yes", action: "sell" },
      { takerSide: "yes", takerAction: "sell", side: "yes", action: "buy" },
    ] as const;
    for (const c of cases) {
      const fill = resolveFill(
        row({ ...MAKER_ROW, taker_side: c.takerSide, taker_action: c.takerAction }),
        NICK,
      );
      assert.ok(fill, `${c.takerSide}/${c.takerAction} must resolve`);
      assert.equal(fill.role, "maker");
      assert.equal(fill.side, c.side);
      assert.equal(fill.action, c.action, `maker of taker ${c.takerAction} must ${c.action}`);
      assert.notEqual(fill.action, c.takerAction);
    }
  });

  it("a taker row is NOT flipped — the correction applies to makers only", () => {
    const cases = [
      { takerSide: "yes", takerAction: "buy" },
      { takerSide: "no", takerAction: "sell" },
    ] as const;
    for (const c of cases) {
      const fill = resolveFill(
        row({ ...TAKER_ROW, taker_side: c.takerSide, taker_action: c.takerAction }),
        NICK,
      );
      assert.ok(fill);
      assert.equal(fill.role, "taker");
      assert.equal(fill.side, c.takerSide);
      assert.equal(fill.action, c.takerAction);
    }
  });
});

/* ------------------------------------------------------- fail-closed on junk */

describe("resolveFill — anything it cannot prove returns null", () => {
  it("no trade_id (nothing to de-duplicate on)", () => {
    assert.equal(resolveFill(row({ ...MAKER_ROW, trade_id: "" }), NICK), null);
  });

  it("no ticker", () => {
    assert.equal(resolveFill(row({ ...MAKER_ROW, ticker: "   " }), NICK), null);
  });

  it("an unparseable or missing create_date", () => {
    assert.equal(resolveFill(row({ ...MAKER_ROW, create_date: "last tuesday" }), NICK), null);
    assert.equal(resolveFill(row({ ...MAKER_ROW, create_date: "" }), NICK), null);
  });

  it("a side or action outside the measured enum", () => {
    assert.equal(resolveFill(row({ ...MAKER_ROW, taker_side: "maybe" }), NICK), null);
    assert.equal(resolveFill(row({ ...MAKER_ROW, taker_action: "hold" }), NICK), null);
  });

  it("tolerates case and padding in the enum values the server sends", () => {
    const fill = resolveFill(row({ ...MAKER_ROW, taker_side: " NO ", taker_action: "Sell" }), NICK);
    assert.ok(fill);
    assert.equal(fill.side, "no");
    assert.equal(fill.action, "buy");
  });

  it("a price outside 1..99 is rejected, never clamped", () => {
    for (const bad of [0, 100, -5, Number.NaN]) {
      assert.equal(
        resolveFill(row({ ...MAKER_ROW, price: bad, price_dollars: "" }), NICK),
        null,
        `price ${bad} must not become a mirror order`,
      );
    }
  });

  it("falls back to price_dollars when price is garbage", () => {
    const fill = resolveFill(row({ ...MAKER_ROW, price: "n/a", price_dollars: "0.4200" }), NICK);
    assert.ok(fill);
    // MAKER_ROW is a NO-side row, and price_dollars is the YES price just as
    // `price` is, so the fallback is converted too: 100 - 42 = 58. Asserting 42
    // here would have let the side conversion be skipped on the fallback path.
    assert.equal(fill.side, "no");
    assert.equal(fill.priceCents, 58);
  });

  it("a count below one contract is rejected", () => {
    assert.equal(resolveFill(row({ ...MAKER_ROW, count: 0, count_fp: "0.4" }), NICK), null);
    assert.equal(resolveFill(row({ ...MAKER_ROW, count: "x", count_fp: "" }), NICK), null);
  });

  it("falls back to count_fp, floored, when count is garbage", () => {
    const fill = resolveFill(row({ ...MAKER_ROW, count: null, count_fp: "301.52" }), NICK);
    assert.ok(fill);
    assert.equal(fill.count, 301);
  });

  it("MEASURED: a real sub-contract fill (count 0, count_fp 0.10) is rejected", () => {
    // VERBATIM from the same live tape. Kalshi prints FRACTIONAL fills: count is
    // floor(count_fp) on all 100 measured rows, so a 0.10-contract fill arrives
    // as count 0. There is no whole-contract mirror of it — it is the one row of
    // the 100 that resolveFill refuses, and refusing is correct.
    const fractional = {
      count: 0,
      count_fp: "0.10",
      create_date: "2026-10-04T18:24:31.356179Z",
      maker_nickname: "",
      market_id: "01a10689-7e56-7aa4-9512-e210a8f86f2c",
      price: 3,
      price_dollars: "0.0300",
      taker_action: "buy",
      taker_nickname: "BitcoinTradingChallenge",
      taker_side: "no",
      ticker: "KXWNBA1QTOTAL-26OCT04NYATL-51",
      trade_id: "07252883-fa99-88fe-a1b7-e54b3a75ae8c",
    };
    assert.equal(resolveFill(row(fractional), NICK), null);
  });

  it("a wholly garbage row never throws", () => {
    const mapped = normaliseTradeRow({ nope: true, price: {}, count: [] });
    assert.ok(mapped);
    assert.equal(resolveFill(mapped, NICK), null);
  });
});

/* ---------------------------------------------------------------- leaderboard */

describe("fetchKalshiLeaderboard — volume only, limit capped at 100", () => {
  it("clamps the limit: 0 → 1, 500 → 100, NaN → 100", () => {
    assert.equal(clampLeaderboardLimit(0), 1);
    assert.equal(clampLeaderboardLimit(-9), 1);
    assert.equal(clampLeaderboardLimit(500), 100);
    assert.equal(clampLeaderboardLimit(100), 100);
    assert.equal(clampLeaderboardLimit(50), 50);
    assert.equal(clampLeaderboardLimit(Number.NaN), 100);
  });

  it("sends metric_name=volume and the clamped limit, and nothing the server ignores", async () => {
    const seen = stubRoutes(() => ({ body: { rank_list: [] } }));
    await fetchKalshiLeaderboard(0);
    await fetchKalshiLeaderboard(500);
    closeTheNetwork();

    assert.equal(seen.urls.length, 2);
    assert.match(seen.urls[0], /\/v1\/social\/leaderboard\?metric_name=volume&limit=1$/);
    assert.match(seen.urls[1], /\/v1\/social\/leaderboard\?metric_name=volume&limit=100$/);
    for (const url of seen.urls) {
      // period/window/timeframe/category/series_ticker are IGNORED server-side
      // (identical rank 1 for every value) — sending one would imply a window
      // that does not exist.
      assert.ok(!/period=|window=|timeframe=|category=|series_ticker=/.test(url), url);
      assert.ok(!/metric_name=(profit|pnl|roi)/.test(url), "no profit ranking exists on Kalshi");
    }
  });

  it("maps the measured rows and treats `value` as CENTS of volume", async () => {
    stubRoutes(() => ({
      body: {
        rank_list: [
          { nickname: "imawhale", social_id: "s1", value: 2302314200, rank: 1, is_anonymous: false },
          {
            nickname: "BitcoinTradingChallenge",
            social_id: "s67",
            value: 111068410,
            rank: 67,
            is_anonymous: false,
          },
          { nickname: "szg.szg", social_id: "s87", value: 86590110, rank: 87, is_anonymous: true },
        ],
      },
    }));
    const rows = await fetchKalshiLeaderboard(100);
    closeTheNetwork();

    assert.equal(rows.length, 3);
    assert.equal(rows[0].nickname, "imawhale");
    assert.equal(rows[0].value, 2302314200);
    assert.equal(rows[2].isAnonymous, true);

    // The unit proof: /100 reproduces the dollar volumes measured for these two
    // traders exactly ($1,110,684.10 and $865,901.10). No other divisor does.
    assert.ok(Math.abs(volumeDollars(rows[1]) - 1_110_684.1) < 1e-6);
    assert.ok(Math.abs(volumeDollars(rows[2]) - 865_901.1) < 1e-6);
    assert.ok(Math.abs(volumeDollars(2302314200) - 23_023_142) < 1e-6);
  });

  it("survives a malformed rank_list without throwing and never invents a rank", async () => {
    stubRoutes(() => ({
      body: {
        rank_list: [null, 42, { nickname: "a" }, { nickname: "b", value: "junk", rank: "junk" }],
      },
    }));
    const rows = await fetchKalshiLeaderboard(10);
    closeTheNetwork();

    assert.equal(rows.length, 2, "non-object rows are unreadable; the object rows survive");
    assert.equal(rows[0].nickname, "a");
    assert.equal(rows[0].value, 0);
    assert.equal(rows[0].rank, 3, "rank falls back to the row's POSITION in the returned list");
    assert.equal(rows[1].value, 0);
    assert.equal(rows[1].rank, 4);
  });

  it("a non-200 throws with the status, rather than returning an empty board", async () => {
    stubRoutes(() => ({ status: 400, body: { error: "invalid_parameters" } }));
    await assert.rejects(() => fetchKalshiLeaderboard(100), /400/);
    closeTheNetwork();
  });
});

/* --------------------------------------------------------------- public trades */

describe("fetchKalshiPublicTrades — page_size is the parameter that works", () => {
  it("clamps the page size: 0 → 1, 500 → 100, NaN → 100", () => {
    assert.equal(clampPageSize(0), 1);
    assert.equal(clampPageSize(5), 5);
    assert.equal(clampPageSize(500), 100);
    assert.equal(clampPageSize(Number.NaN), 100);
  });

  it("plumbs pageSize through as page_size and never sends the ignored `limit`", async () => {
    const seen = stubRoutes(() => ({ body: { trades: [], visibility_state: "hidden" } }));
    await fetchKalshiPublicTrades("szg.szg", 5);
    await fetchKalshiPublicTrades("a b/c", 500);
    closeTheNetwork();

    assert.match(seen.urls[0], /\/v1\/social\/trades\?nickname=szg\.szg&page_size=5$/);
    assert.match(seen.urls[1], /page_size=100$/);
    assert.ok(seen.urls[1].includes("nickname=a%20b%2Fc"), "the nickname is URL-encoded");
    for (const url of seen.urls) {
      assert.ok(!/[?&]limit=/.test(url), "`limit` is IGNORED here — sending it is a false signal");
      assert.ok(!/cursor=/.test(url), "`cursor` is IGNORED — there is no pagination");
    }
  });

  it("a hidden trader is a normal 200 answer: empty trades, no throw, not copyable", async () => {
    stubRoutes(() => ({ body: { trades: [], visibility_state: "hidden" } }));
    const res = await fetchKalshiPublicTrades("imawhale");
    closeTheNetwork();

    assert.deepEqual(res.trades, []);
    assert.equal(res.visibility, "hidden");
    assert.equal(res.malformed, 0);
    assert.equal(isVisible(res.visibility), false);
  });

  it("a missing visibility_state reads 'unknown' — never promoted to visible", async () => {
    stubRoutes(() => ({ body: { trades: [MAKER_ROW] } }));
    const res = await fetchKalshiPublicTrades(NICK);
    closeTheNetwork();

    assert.equal(res.visibility, "unknown");
    assert.equal(isVisible(res.visibility), false);
    assert.equal(res.trades.length, 1);
  });

  it("maps a visible tape and COUNTS malformed rows instead of dropping them silently", async () => {
    stubRoutes(() => ({
      body: { trades: [MAKER_ROW, null, TAKER_ROW, "garbage", 3], visibility_state: "visible" },
    }));
    const res = await fetchKalshiPublicTrades(NICK, 100);
    closeTheNetwork();

    assert.equal(isVisible(res.visibility), true);
    assert.equal(res.trades.length, 2);
    assert.equal(res.malformed, 3);
    assert.equal(res.trades[0].ticker, "KXWNBA1QWINNER-26OCT04NYATL-NY");
  });

  it("a non-array trades field does not throw", async () => {
    stubRoutes(() => ({ body: { trades: null, visibility_state: "visible" } }));
    const res = await fetchKalshiPublicTrades(NICK);
    closeTheNetwork();
    assert.deepEqual(res.trades, []);
  });
});

/* ------------------------------------------------------------ visibility walk */

describe("findVisibleTraders — the copyable universe, measured politely", () => {
  const board = (nicks: string[]) => ({
    rank_list: nicks.map((n, i) => ({
      nickname: n,
      social_id: `s${i}`,
      value: 1000 + i,
      rank: i + 1,
      is_anonymous: false,
    })),
  });

  it("separates visible, hidden, failed and unqueryable, and keeps the counts honest", async () => {
    const seen = stubRoutes((url) => {
      if (url.includes("/leaderboard")) {
        return { body: board(["imawhale", "", "BitcoinTradingChallenge", "boom", "szg.szg"]) };
      }
      if (url.includes("nickname=BitcoinTradingChallenge")) {
        return { body: { trades: [MAKER_ROW], visibility_state: "visible" } };
      }
      if (url.includes("nickname=szg.szg")) {
        return { body: { trades: [TAKER_ROW], visibility_state: "visible" } };
      }
      if (url.includes("nickname=boom")) return { status: 500, body: { error: "nope" } };
      return { body: { trades: [], visibility_state: "hidden" } };
    });

    const sleeps: number[] = [];
    const walk = await findVisibleTraders(100, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    closeTheNetwork();

    assert.deepEqual(
      walk.visible.map((l: KalshiLeader) => l.nickname),
      ["BitcoinTradingChallenge", "szg.szg"],
    );
    assert.equal(walk.checkedCount, 4, "the empty nickname was never probed");
    assert.equal(walk.hiddenCount, 1);
    assert.deepEqual(walk.skipped, [{ nickname: "", reason: "no_nickname" }]);
    assert.equal(walk.errors.length, 1);
    assert.equal(walk.errors[0].nickname, "boom");
    assert.match(walk.errors[0].message, /500/);

    // Every row is accounted for: nothing is silently truncated.
    assert.equal(
      walk.checkedCount,
      walk.visible.length + walk.hiddenCount + walk.errors.length,
      "checked = visible + hidden + failed",
    );
    assert.equal(walk.checkedCount + walk.skipped.length, 5, "every leaderboard row is accounted");

    // A failed probe is NOT counted as hidden — unknown and hidden are not the
    // same fact, and treating an outage as "no signal here" hides the outage.
    assert.ok(!walk.visible.some((l) => l.nickname === "boom"));

    assert.equal(seen.urls.length, 5, "1 leaderboard + 4 probes");
    assert.ok(seen.urls[0].includes("/leaderboard"));
  });

  it("is DELIBERATELY serial and waits ~120ms between calls by default", async () => {
    const seen = stubRoutes((url) =>
      url.includes("/leaderboard")
        ? { body: board(["a", "b", "c"]) }
        : { body: { trades: [], visibility_state: "hidden" } },
    );
    const sleeps: number[] = [];
    const walk = await findVisibleTraders(100, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    closeTheNetwork();

    assert.equal(walk.checkedCount, 3);
    assert.deepEqual(sleeps, [120, 120], "a gap before every probe but the first");
    assert.equal(seen.maxInFlight(), 1, "never a burst at somebody else's free endpoint");
  });

  it("uses page_size=5 for the probe — the smallest size MEASURED to work", async () => {
    const seen = stubRoutes((url) =>
      url.includes("/leaderboard")
        ? { body: board(["a"]) }
        : { body: { trades: [], visibility_state: "hidden" } },
    );
    await findVisibleTraders(1, { delayMs: 0 });
    closeTheNetwork();
    assert.match(seen.urls[1], /nickname=a&page_size=5$/);
  });

  it("honours the clamped leaderboard limit", async () => {
    const seen = stubRoutes((url) =>
      url.includes("/leaderboard") ? { body: board([]) } : { body: {} },
    );
    await findVisibleTraders(500, { delayMs: 0 });
    closeTheNetwork();
    assert.match(seen.urls[0], /limit=100$/);
  });
});

/* ----------------------------------------------------------------- summarising */

describe("summariseTrader — is this a market maker or a directional bettor?", () => {
  it("counts roles, tickers, both-sided churn and the time window", () => {
    const rows = [
      row(MAKER_ROW),
      row({ ...MAKER_ROW, trade_id: "m2", taker_side: "yes", taker_action: "buy" }),
      // Same side as the taker row below, so the NHL ticker stays one-sided and
      // only the WNBA ticker shows the two-sided churn.
      row({
        ...MAKER_ROW,
        trade_id: "m3",
        ticker: "KXNHL2P-26OCT04WPGDET-TIE",
        create_date: "2026-10-04T19:10:00Z",
        taker_side: "yes",
      }),
      row(TAKER_ROW),
      // Unresolvable: neither party is our trader. Counted, never hidden.
      row({ ...TAKER_ROW, trade_id: "x1", maker_nickname: "Unitdor", taker_nickname: "someone" }),
    ];
    const s = summariseTrader(NICK, rows);

    assert.equal(s.nickname, NICK);
    assert.equal(s.rows, 5);
    assert.equal(s.resolved, 4);
    assert.equal(s.unresolved, 1);
    assert.equal(s.makerFills, 3);
    assert.equal(s.takerFills, 1);
    assert.equal(s.makerShare, 0.75);
    assert.equal(s.profile, "maker_dominant");
    assert.equal(s.distinctTickers, 2);
    assert.deepEqual(s.tickers, [
      "KXNHL2P-26OCT04WPGDET-TIE",
      "KXWNBA1QWINNER-26OCT04NYATL-NY",
    ]);
    assert.equal(s.bothSidesTickers, 1, "the WNBA ticker was traded on both yes and no");
    assert.equal(s.contracts, 301 + 301 + 301 + 1);
    // ★ Side-correct notional. MAKER_ROW prints 99c YES; rows that resolve to the
    //   NO side therefore cost 1c, and the rows flipped to taker_side "yes" cost
    //   99c. Asserting a flat 99c across all four would re-assert the YES-price
    //   bug at the aggregate level, which is where an under-stated notional
    //   actually reaches a spend ceiling. m1 is NO (1c); m2 and m3 are YES (99c);
    //   TAKER_ROW is YES (99c, count 1).
    assert.equal(s.notionalCents, 1 * 301 + 99 * 301 + 99 * 301 + 99 * 1);
    assert.equal(s.newestObservedAt, "2026-10-04T19:10:00Z");
    assert.equal(s.oldestObservedAt, "2026-10-04T18:41:59.127169Z");
  });

  it("an empty or all-unresolvable tape reports 'unknown', not a fabricated profile", () => {
    const empty = summariseTrader(NICK, []);
    assert.equal(empty.resolved, 0);
    assert.equal(empty.profile, "unknown");
    assert.equal(empty.makerShare, 0);
    assert.equal(empty.newestObservedAt, null);
    assert.equal(empty.oldestObservedAt, null);

    const foreign = summariseTrader("nobody", [row(MAKER_ROW), row(TAKER_ROW)]);
    assert.equal(foreign.rows, 2);
    assert.equal(foreign.resolved, 0);
    assert.equal(foreign.unresolved, 2);
    assert.equal(foreign.profile, "unknown");
  });

  it("a taker-heavy tape reads taker_dominant", () => {
    const rows = [
      row(TAKER_ROW),
      row({ ...TAKER_ROW, trade_id: "t2" }),
      row({ ...TAKER_ROW, trade_id: "t3" }),
      row(MAKER_ROW),
    ];
    const s = summariseTrader(NICK, rows);
    assert.equal(s.takerFills, 3);
    assert.equal(s.makerFills, 1);
    assert.equal(s.profile, "taker_dominant");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * THE YES-PRICE DENOMINATION BUG (found by adversarial review, 2026-10-04)
 *
 * Kalshi's social trade feed reports ONLY the YES price, whatever side anyone
 * was on. Verified by matching 41 social rows to GET /trade-api/v2/markets/trades
 * by trade_id: social.price === v2.yes_price on all 41, including every
 * taker_side="no" row. 21 of 100 rows on the live tape resolve to side "no".
 *
 * What these tests protect, concretely: a NO fill reported at 2c truly cost 98c.
 * At 895 contracts that is $877.10, not $17.90 — so the $20 per-scan ceiling
 * built to protect a $42.40 balance would have waved through a commitment 49x
 * larger than the whole account. The error runs both ways: a NO fill reported at
 * 98c truly cost 2c, so a mirror limit lands 49x above the market.
 * ──────────────────────────────────────────────────────────────────────────── */

describe("resolveFill — the YES-price denomination bug", () => {
  it("sidePriceCents: YES side keeps the printed price", () => {
  assert.equal(sidePriceCents(99, "yes"), 99);
  assert.equal(sidePriceCents(4, "yes"), 4);
  });

  it("sidePriceCents: NO side is the complement, not the printed price", () => {
  // Real row 072529dc-5c51-8e7a-8f6d-0f39d2963f52, KXWNBA3QTOTAL-26OCT04NYATL-45:
  // social price=99, v2 yes_price=99 / no_price=1. The NO side cost 1c.
  assert.equal(sidePriceCents(99, "no"), 1);
  // Real shape: social price=4 => v2 no_price=96.
  assert.equal(sidePriceCents(4, "no"), 96);
  assert.equal(sidePriceCents(98, "no"), 2);
  });

  it("sidePriceCents: refuses degenerate and non-finite prices", () => {
  assert.equal(sidePriceCents(0, "yes"), null);
  assert.equal(sidePriceCents(100, "yes"), null);
  assert.equal(sidePriceCents(Number.NaN, "yes"), null);
  assert.equal(sidePriceCents(Number.POSITIVE_INFINITY, "no"), null);
  });

  it("resolveFill: a NO-side fill carries the NO price, not the YES print", () => {
  // Verbatim real row: the taker bought NO. social price=2 is the YES price,
  // so the taker's own cost was 98c. 895 contracts => $877.10, not $17.90.
  const row = normaliseTradeRow({
    trade_id: "0725299a-aaaa-bbbb-cccc-ddddeeeeffff",
    market_id: "01a10689-7d45-7a38-9207-e93502d43245",
    ticker: "KXNFLGAME-26OCT04NYJCHI-NYJ",
    price: 2,
    price_dollars: "0.0200",
    count: 895,
    count_fp: "895.00",
    taker_side: "no",
    taker_action: "buy",
    maker_nickname: "",
    taker_nickname: "BitcoinTradingChallenge",
    create_date: "2026-10-04T18:47:36.806999Z",
  });
  assert.ok(row);
  const fill = resolveFill(row, "BitcoinTradingChallenge");
  assert.ok(fill);
  assert.equal(fill.side, "no");
  assert.equal(fill.role, "taker");
  // THE ASSERTION THAT MATTERS: 98, not the printed 2.
  assert.equal(fill.priceCents, 98, "a NO fill must carry the NO price");
  assert.equal(fill.priceCents * fill.count, 87_710, "true notional is $877.10");
  });

  it("resolveFill: a YES-side fill is unaffected by the side conversion", () => {
  const row = normaliseTradeRow({
    trade_id: "0725299b-aaaa-bbbb-cccc-ddddeeeeffff",
    market_id: "01a10689-7d45-7a38-9207-e93502d43245",
    ticker: "KXNHL2P-26OCT04WPGDET-TIE",
    price: 4,
    price_dollars: "0.0400",
    count: 10,
    count_fp: "10.00",
    taker_side: "yes",
    taker_action: "buy",
    maker_nickname: "Unitdor",
    taker_nickname: "BitcoinTradingChallenge",
    create_date: "2026-10-04T18:47:36.806999Z",
  });
  assert.ok(row);
  const fill = resolveFill(row, "BitcoinTradingChallenge");
  assert.ok(fill);
  assert.equal(fill.side, "yes");
  assert.equal(fill.priceCents, 4);
  });

  it("resolveFill: the MAKER of a NO print also gets a side-correct price", () => {
  // Maker side is preserved and the action flips; the price must still be the
  // NO price. Both corrections have to hold at once or the fill is wrong twice.
  const row = normaliseTradeRow({
    trade_id: "0725299c-aaaa-bbbb-cccc-ddddeeeeffff",
    market_id: "01a10689-7d45-7a38-9207-e93502d43245",
    ticker: "KXWNBA1QWINNER-26OCT04NYATL-NY",
    price: 99,
    price_dollars: "0.9900",
    count: 301,
    count_fp: "301.52",
    taker_side: "no",
    taker_action: "sell",
    maker_nickname: "BitcoinTradingChallenge",
    taker_nickname: "",
    create_date: "2026-10-04T18:47:36.806999Z",
  });
  assert.ok(row);
  const fill = resolveFill(row, "BitcoinTradingChallenge");
  assert.ok(fill);
  assert.equal(fill.role, "maker");
  assert.equal(fill.side, "no");
  assert.equal(fill.action, "buy", "maker action flips off the taker's sell");
  assert.equal(fill.priceCents, 1, "NO price at a 99c YES print is 1c");
  });
});
