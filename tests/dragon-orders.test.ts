/**
 * DRAGON ORDERS — the tests that stand between a wrong tool call and a real
 * position in Classic's Kalshi account.
 *
 * Two properties are load-bearing and each fails loudly here:
 *   1. the same intent inside the same second produces the SAME clientOrderId,
 *      so a retry is answered with the original order instead of becoming a
 *      second position;
 *   2. an invalid order never reaches the network at all — the call count is
 *      asserted, not just the return value.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  newClientOrderId,
  buildOrder,
  placeOrder,
  cancelOrder,
  notionalCents,
  type OrderRequest,
} from "../src/lib/dragon-orders";
import { DRAGON_TRADAR_AGENT_BASE } from "../src/lib/dragon-tradar";

function stub(status: number, body: unknown = {}) {
  let calls = 0;
  const urls: string[] = [];
  const inits: RequestInit[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls++;
    urls.push(String(url));
    inits.push(init ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls, urls, inits };
}

const OK: OrderRequest = {
  ticker: "KXBTC15M-X",
  side: "yes",
  action: "buy",
  count: 3,
  priceCents: 41,
  maxNotionalCents: 10_000,
};

describe("newClientOrderId — the retry guard", () => {
  it("the same intent in the same second yields the same clientOrderId", () => {
    const a = newClientOrderId(
      { ticker: "KXBTC15M-X", side: "yes", action: "buy", count: 3, priceCents: 41 },
      1_700_000_000_000,
    );
    const b = newClientOrderId(
      { ticker: "KXBTC15M-X", side: "yes", action: "buy", count: 3, priceCents: 41 },
      1_700_000_000_400,
    );
    assert.equal(a, b, "a retry inside the same second must not become a second position");
  });

  it("a different second, ticker, side, action, count or price is a different order", () => {
    const base = { ticker: "T", side: "yes", action: "buy", count: 1, priceCents: 50 } as const;
    const id = newClientOrderId(base, 1_700_000_000_000);
    const others = [
      newClientOrderId(base, 1_700_000_001_000),
      newClientOrderId({ ...base, ticker: "U" }, 1_700_000_000_000),
      newClientOrderId({ ...base, side: "no" }, 1_700_000_000_000),
      newClientOrderId({ ...base, action: "sell" }, 1_700_000_000_000),
      newClientOrderId({ ...base, count: 2 }, 1_700_000_000_000),
      newClientOrderId({ ...base, priceCents: 51 }, 1_700_000_000_000),
    ];
    for (const other of others) assert.notEqual(other, id);
  });

  it("the id is stable across runs — it is a hash, not a random or a counter", () => {
    const intent = { ticker: "T", side: "no", action: "sell", count: 4, priceCents: 12 } as const;
    assert.equal(
      newClientOrderId(intent, 1_700_000_000_000),
      newClientOrderId(intent, 1_700_000_000_000),
    );
    assert.match(newClientOrderId(intent, 1_700_000_000_000), /^starra-[0-9a-f]{32}$/);
  });

  it("the ceiling is not part of the identity — same trade, same id", () => {
    const intent = { ticker: "T", side: "yes", action: "buy", count: 2, priceCents: 30 } as const;
    const a = buildOrder({ ...intent, maxNotionalCents: 10_000 }, 1_700_000_000_000);
    const b = buildOrder({ ...intent, maxNotionalCents: 50_000 }, 1_700_000_000_000);
    assert.equal(a.ok && b.ok && a.order.clientOrderId === b.order.clientOrderId, true);
  });
});

describe("buildOrder — the local safety gate", () => {
  it("rejects an order whose notional exceeds the local ceiling", () => {
    const r = buildOrder({
      ticker: "T",
      side: "yes",
      action: "buy",
      count: 100,
      priceCents: 90,
      maxNotionalCents: 5_000,
    });
    assert.deepEqual(r, { ok: false, reason: "exceeds_local_max_notional" });
  });

  it("allows an order exactly AT the ceiling", () => {
    const r = buildOrder({
      ticker: "T",
      side: "yes",
      action: "buy",
      count: 10,
      priceCents: 50,
      maxNotionalCents: 500,
    });
    assert.equal(r.ok, true);
  });

  it("rejects a non-integer or non-positive count before it can reach Kalshi", () => {
    assert.equal(
      buildOrder({
        ticker: "T",
        side: "yes",
        action: "buy",
        count: 0,
        priceCents: 50,
        maxNotionalCents: 10_000,
      }).ok,
      false,
    );
    assert.equal(
      buildOrder({
        ticker: "T",
        side: "yes",
        action: "buy",
        count: 1.5,
        priceCents: 50,
        maxNotionalCents: 10_000,
      }).ok,
      false,
    );
  });

  it("rejects a price outside 1..99 cents", () => {
    for (const p of [0, 100, -1]) {
      assert.equal(
        buildOrder({
          ticker: "T",
          side: "yes",
          action: "buy",
          count: 1,
          priceCents: p,
          maxNotionalCents: 10_000,
        }).ok,
        false,
      );
    }
  });

  it("names WHICH field was wrong — a generic refusal costs him an hour of guessing", () => {
    const cases: [Partial<OrderRequest>, string][] = [
      [{ ticker: "" }, "bad_ticker"],
      [{ ticker: "   " }, "bad_ticker"],
      [{ side: "maybe" as never }, "bad_side"],
      [{ action: "hold" as never }, "bad_action"],
      [{ count: -2 }, "bad_count"],
      [{ count: Number.NaN }, "bad_count"],
      [{ priceCents: 50.5 }, "bad_price"],
      [{ maxNotionalCents: 0 }, "bad_max_notional"],
      [{ maxNotionalCents: Number.NaN }, "bad_max_notional"],
    ];
    for (const [patch, reason] of cases) {
      assert.deepEqual(buildOrder({ ...OK, ...patch }), { ok: false, reason }, JSON.stringify(patch));
    }
  });

  it("a missing ceiling is a refusal, never an unlimited order", () => {
    const r = buildOrder({ ...OK, maxNotionalCents: undefined as unknown as number });
    assert.deepEqual(r, { ok: false, reason: "bad_max_notional" });
  });

  it("builds exactly the body Task A1 takes — no extra fields, ceiling not sent", () => {
    const r = buildOrder(OK, 1_700_000_000_000);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(Object.keys(r.order).sort(), [
      "action",
      "clientOrderId",
      "count",
      "priceCents",
      "side",
      "ticker",
    ]);
  });

  it("notionalCents is count x price, in cents", () => {
    assert.equal(notionalCents({ count: 3, priceCents: 41 }), 123);
  });
});

describe("placeOrder — one attempt, never a second", () => {
  it("a 423 daily-loss-floor response is reported, never retried", async () => {
    const s = stub(423, { error: "daily_loss_floor_reached" });
    const r = await placeOrder(
      { ticker: "T", side: "yes", action: "buy", count: 1, priceCents: 50, maxNotionalCents: 10_000 },
      { token: "t", fetchImpl: s.fetchImpl },
    );
    assert.equal(r.state, "error");
    assert.equal(s.calls(), 1);
  });

  it("the floor's own code reaches him verbatim", async () => {
    const s = stub(423, { error: "daily_loss_floor_reached" });
    const r = await placeOrder(OK, { token: "t", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "error", status: 423, code: "daily_loss_floor_reached" });
  });

  it("a throttle is blocked, and fired exactly once", async () => {
    const s = stub(429, { error: "temporarily_blocked" });
    assert.deepEqual(await placeOrder(OK, { token: "t", fetchImpl: s.fetchImpl }), {
      state: "blocked",
    });
    assert.equal(s.calls(), 1);
  });

  it("a locally-refused order never touches the network", async () => {
    const s = stub(200, {});
    const r = await placeOrder(
      { ...OK, count: 1000 },
      { token: "t", fetchImpl: s.fetchImpl },
    );
    assert.deepEqual(r, { state: "error", status: 0, code: "exceeds_local_max_notional" });
    assert.equal(s.calls(), 0);
  });

  it("no token is OFF — an unconfigured deck never places a trade", async () => {
    const s = stub(200, {});
    assert.deepEqual(await placeOrder(OK, { token: null, fetchImpl: s.fetchImpl }), {
      state: "off",
    });
    assert.equal(s.calls(), 0);
  });

  it("POSTs the built order, clientOrderId included, to /order", async () => {
    const s = stub(200, { id: "abc" });
    const r = await placeOrder(OK, { token: "t", fetchImpl: s.fetchImpl }, 1_700_000_000_000);
    assert.equal(r.state, "ok");
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/order`);
    assert.equal(s.inits[0].method, "POST");
    const sent = JSON.parse(String(s.inits[0].body)) as Record<string, unknown>;
    assert.equal(sent.clientOrderId, newClientOrderId(OK, 1_700_000_000_000));
    assert.equal(sent.ticker, OK.ticker);
    assert.equal(sent.maxNotionalCents, undefined, "the local ceiling is ours, not his app's");
  });

  it("two placements in the same second send the SAME clientOrderId", async () => {
    const s1 = stub(200, {});
    const s2 = stub(200, {});
    await placeOrder(OK, { token: "t", fetchImpl: s1.fetchImpl }, 1_700_000_000_100);
    await placeOrder(OK, { token: "t", fetchImpl: s2.fetchImpl }, 1_700_000_000_900);
    const a = JSON.parse(String(s1.inits[0].body)) as { clientOrderId: string };
    const b = JSON.parse(String(s2.inits[0].body)) as { clientOrderId: string };
    assert.equal(a.clientOrderId, b.clientOrderId);
  });
});

describe("cancelOrder — only ever reduces exposure", () => {
  it("DELETEs the id, url-encoded", async () => {
    const s = stub(200, { cancelled: true });
    const r = await cancelOrder("ord/42", { token: "t", fetchImpl: s.fetchImpl });
    assert.equal(r.state, "ok");
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/order/ord%2F42`);
    assert.equal(s.inits[0].method, "DELETE");
    assert.equal(s.inits[0].body, undefined);
  });

  it("an empty id is refused before the network", async () => {
    const s = stub(200, {});
    assert.deepEqual(await cancelOrder("  ", { token: "t", fetchImpl: s.fetchImpl }), {
      state: "error",
      status: 0,
      code: "bad_order_id",
    });
    assert.equal(s.calls(), 0);
  });
});

/**
 * ORDER ROUTE GLUE — pulled out of `/api/dragon/order` so the rule that
 * matters most on this endpoint is pinned by a test: A CALLER CAN ONLY EVER
 * TIGHTEN THE CEILING. If a tool call could raise its own limit, the deck's
 * limit would not be one.
 */
import {
  readOrderCeilingCents,
  effectiveCeilingCents,
  toOrderRequest,
  orderFeedLine,
  cancelOutcome,
  ORDER_CEILING_DEFAULT_CENTS,
} from "../src/app/api/dragon/order/route";

describe("order ceiling", () => {
  it("defaults to $100 when unset or nonsense", () => {
    assert.equal(readOrderCeilingCents({}), ORDER_CEILING_DEFAULT_CENTS);
    assert.equal(readOrderCeilingCents({ DRAGON_MAX_ORDER_NOTIONAL_CENTS: "abc" }), 10_000);
    assert.equal(readOrderCeilingCents({ DRAGON_MAX_ORDER_NOTIONAL_CENTS: "0" }), 10_000);
    assert.equal(readOrderCeilingCents({ DRAGON_MAX_ORDER_NOTIONAL_CENTS: "-5" }), 10_000);
  });

  it("reads a real env override", () => {
    assert.equal(readOrderCeilingCents({ DRAGON_MAX_ORDER_NOTIONAL_CENTS: "2500" }), 2_500);
  });

  it("a caller may tighten the ceiling", () => {
    assert.equal(effectiveCeilingCents(2_000, 10_000), 2_000);
  });

  it("a caller may NOT loosen it", () => {
    assert.equal(effectiveCeilingCents(1_000_000, 10_000), 10_000);
  });

  it("a missing or garbage request ceiling falls back to the deck's", () => {
    for (const v of [undefined, null, "5000", 0, -1, Number.NaN]) {
      assert.equal(effectiveCeilingCents(v, 10_000), 10_000);
    }
  });

  it("toOrderRequest carries the clamped ceiling, not the requested one", () => {
    const r = toOrderRequest(
      { ticker: "T", side: "yes", action: "buy", count: 1, priceCents: 50, maxNotionalCents: 9e9 },
      10_000,
    );
    assert.equal(r.maxNotionalCents, 10_000);
  });

  it("a non-object body becomes a request buildOrder refuses by field", () => {
    const r = toOrderRequest("buy everything", 10_000);
    assert.deepEqual(buildOrder(r), { ok: false, reason: "bad_ticker" });
  });
});

describe("order feed lines", () => {
  const req: OrderRequest = {
    ticker: "KXBTC15M-X",
    side: "yes",
    action: "buy",
    count: 3,
    priceCents: 41,
    maxNotionalCents: 10_000,
  };

  it("a local refusal names the reason and says it never went out", () => {
    const line = orderFeedLine(req, { ok: false, reason: "exceeds_local_max_notional" }, null);
    assert.match(line, /refused locally \(exceeds_local_max_notional\)/);
  });

  it("a placed order reads as placed, with the size and price he can check", () => {
    const built = buildOrder(req, 1_700_000_000_000);
    const line = orderFeedLine(req, built, { state: "ok", stats: {} });
    assert.match(line, /ORDER buy 3x KXBTC15M-X yes @41c — placed/);
  });

  it("a throttle says out loud that it was NOT retried", () => {
    const built = buildOrder(req, 1_700_000_000_000);
    assert.match(orderFeedLine(req, built, { state: "blocked" }), /NOT retried/);
  });

  it("his server's own code reaches the feed verbatim", () => {
    const built = buildOrder(req, 1_700_000_000_000);
    const line = orderFeedLine(req, built, {
      state: "error",
      status: 423,
      code: "daily_loss_floor_reached",
    });
    assert.match(line, /423 daily_loss_floor_reached/);
  });

  it("cancelOutcome names every state", () => {
    assert.equal(cancelOutcome({ state: "ok", stats: {} }), "cancelled");
    assert.match(cancelOutcome({ state: "blocked" }), /NOT retried/);
    assert.match(cancelOutcome({ state: "rejected" }), /token rejected/);
    assert.match(cancelOutcome({ state: "off" }), /nothing sent/);
    assert.match(cancelOutcome({ state: "error", status: 0, code: "bad_order_id" }), /bad_order_id/);
  });
});

/**
 * THE CEILING BRAKES BOTH DIRECTIONS.
 *
 * [SUPERSEDED 2026-09-09, kept because the argument it made is a good one and
 * the next reader deserves to see why it lost: "The notional ceiling caps how
 * much NEW risk may be opened. An exit reduces exposure, so gating it on the
 * same number would mean refusing to let him out of a position." That is true
 * whenever the sell really is an exit — and buildOrder cannot tell, because it
 * never sees a position. See the block on the describe below.]
 */
describe("buildOrder — the ceiling brakes BOTH directions", () => {
  /**
   * REVERSED 2026-09-09, and the reversal is the point of this block.
   *
   * These specs used to assert that an exit was exempt from the ceiling, on the
   * argument that a blocked sell is a position he cannot escape. That argument
   * is good and it still loses, for a reason the tests themselves make plain:
   * `buildOrder` receives a ticker, a side, a count and a price and NOTHING
   * ELSE. It cannot see a position, so it cannot tell an exit from new exposure
   * pointing the other way — the exempt branch covered both.
   *
   * And the two failures are not equally recoverable: a blocked exit costs a
   * corrected retry — SLICE THE SELL, which is the only runtime remedy, since
   * effectiveCeilingCents can only tighten and the deck ceiling is an env var
   * behind a restart — while an oversized order that goes through costs money
   * that does not come back. The caller is a language model.
   */
  const exit = {
    ticker: "T",
    side: "yes",
    action: "sell",
    count: 100,
    priceCents: 90,
  } as const;

  it("refuses a sell over the ceiling, under its OWN reason", () => {
    const r = buildOrder({ ...exit, maxNotionalCents: 5_000 }, 1_700_000_000_000);
    assert.deepEqual(r, { ok: false, reason: "exceeds_local_max_notional_exit" });
    assert.equal(notionalCents(exit) > 5_000, true, "guard: this sell really does exceed it");
  });

  it("refuses a sell with no usable ceiling — never an unlimited order", () => {
    for (const ceiling of [0, Number.NaN, -1]) {
      const r = buildOrder({ ...exit, maxNotionalCents: ceiling }, 1_700_000_000_000);
      assert.deepEqual(
        r,
        { ok: false, reason: "bad_max_notional" },
        `a missing ceiling must refuse an exit too (got ${String(ceiling)})`,
      );
    }
  });

  it("a blocked EXIT is distinguishable from a blocked ENTRY", () => {
    const sell = buildOrder({ ...exit, maxNotionalCents: 5_000 }, 1_700_000_000_000);
    const buy = buildOrder({ ...exit, action: "buy", maxNotionalCents: 5_000 }, 1_700_000_000_000);
    assert.equal(sell.ok, false);
    assert.equal(buy.ok, false);
    assert.notEqual(
      (sell as { reason: string }).reason,
      (buy as { reason: string }).reason,
      "he must be able to tell which brake fired — the fix differs",
    );
  });

  it("an exit INSIDE the ceiling still goes through untouched", () => {
    const r = buildOrder({ ...exit, maxNotionalCents: 1_000_000 }, 1_700_000_000_000);
    assert.equal(r.ok, true, "the brake caps size; it does not forbid exiting");
  });

  it("still refuses a BUY over the ceiling — the brake is intact where it belongs", () => {
    const r = buildOrder(
      { ...exit, action: "buy", maxNotionalCents: 5_000 },
      1_700_000_000_000,
    );
    assert.deepEqual(r, { ok: false, reason: "exceeds_local_max_notional" });
  });

  it("still refuses a BUY with no usable ceiling", () => {
    const r = buildOrder({ ...exit, action: "buy", maxNotionalCents: 0 }, 1_700_000_000_000);
    assert.deepEqual(r, { ok: false, reason: "bad_max_notional" });
  });

  it("structural validation still applies to an exit — malformed is malformed either way", () => {
    const cases: [Partial<OrderRequest>, string][] = [
      [{ count: 0 }, "bad_count"],
      [{ count: 1.5 }, "bad_count"],
      [{ priceCents: 0 }, "bad_price"],
      [{ priceCents: 100 }, "bad_price"],
      [{ ticker: "" }, "bad_ticker"],
    ];
    for (const [patch, reason] of cases) {
      const r = buildOrder(
        { ...exit, maxNotionalCents: 10_000, ...patch } as OrderRequest,
        1_700_000_000_000,
      );
      assert.deepEqual(r, { ok: false, reason }, `an exit with ${JSON.stringify(patch)}`);
    }
  });
});
