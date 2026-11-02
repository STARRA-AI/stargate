/**
 * DRAGON COPY — the tests that stand between a leaderboard scan and Classic's
 * $42.40.
 *
 * Four properties are load-bearing, and each one fails loudly here:
 *   1. A cap can only ever get TIGHTER. No caller, env value or balance can
 *      make an order bigger.
 *   2. The SCAN budget blocks order N+1 even when every order is individually
 *      legal — the cap that actually matters when the bankroll is four
 *      minimum-size bets wide.
 *   3. A dry run makes EXACTLY ZERO network calls. Asserted by call count, not
 *      by reading the code.
 *   4. A 429 stops the WHOLE batch, and the orders behind it are reported
 *      `unsent` — a different word from `failed`, because nothing was attempted
 *      and nothing can have landed.
 *
 * Every fetch here is a stub. Nothing in this file touches dragontradar.com,
 * api.elections.kalshi.com or polymarket.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COPY_LANE_DEFAULT_CENTS,
  COPY_MAX_OPEN_DEFAULT,
  assertCopyModeAllowed,
  copyFeedLines,
  intentKey,
  intentToOrderRequest,
  planCopyBatch,
  resolveCaps,
  runCopyLane,
  submitCopyBatch,
  type CopyCaps,
  type CopyPlanState,
  type RouteRejected,
} from "../src/lib/dragon-copy";
import { DEFAULT_SIGNAL_CONFIG } from "../src/lib/copy-signals";
import { DRAGON_TRADAR_AGENT_BASE } from "../src/lib/dragon-tradar";
import type { CopyIntent, Rejected } from "../src/lib/copy-contracts";

/** A fixed clock, so every clientOrderId in this file is reproducible. */
const NOW = 1_770_000_000_000;

/** No env at all — exercises the documented defaults, never the real shell. */
const NO_ENV: Record<string, string | undefined> = {};

function intent(over: Partial<CopyIntent> = {}): CopyIntent {
  return {
    venue: "kalshi",
    sourceTrader: "BitcoinTradingChallenge",
    ticker: "KXBTCD-26OCT04-T120000",
    side: "yes",
    action: "buy",
    priceCents: 10,
    count: 2,
    role: "taker",
    observedAt: "2026-10-04T12:00:00Z",
    confidence: 0.8,
    why: "rank 67 by volume, trades visible",
    ...over,
  };
}

function freshState(over: Partial<CopyPlanState> = {}): CopyPlanState {
  return { openCopies: 0, nowMs: NOW, ...over };
}

/**
 * A fetch that answers from a script and counts itself. Fewer responses than
 * calls repeats the last one, so a test can never pass by running out of stubs.
 */
function stub(responses: Array<{ status: number; body?: unknown }>) {
  let calls = 0;
  const urls: string[] = [];
  const methods: string[] = [];
  const bodies: Array<Record<string, unknown> | undefined> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const r = responses[Math.min(calls, responses.length - 1)];
    calls += 1;
    urls.push(String(url));
    methods.push(String(init?.method ?? "GET"));
    bodies.push(
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined,
    );
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls, urls, methods, bodies };
}

const PAPER = { running: false, category: "sports", mode: "paper", lastScanAt: null, config: {} };
const LIVE = { ...PAPER, mode: "live" };

/* ── 1. CAPS TIGHTEN, NEVER WIDEN ───────────────────────────────────────── */

describe("resolveCaps — a cap can only get tighter", () => {
  it("defaults to the copy lane's own $20, not the deck's $100", () => {
    const caps = resolveCaps({ env: NO_ENV });
    assert.equal(caps.perOrderCents, COPY_LANE_DEFAULT_CENTS);
    assert.equal(caps.perScanCents, COPY_LANE_DEFAULT_CENTS);
    assert.equal(caps.maxOpenCopies, COPY_MAX_OPEN_DEFAULT);
    // ★ THIS LINE USED TO ASSERT `true`, which is how the disagreement survived a
    //   green suite: the test encoded the permissive default as correct. A maker
    //   fill is refused unless a caller opts in — see the agreement test below.
    assert.equal(caps.allowMakerFills, false);
    assert.equal(caps.minConfidence, 0.25);
  });

  it("CLAMPS a caller trying to widen past the env ceiling", () => {
    const caps = resolveCaps({
      env: NO_ENV,
      caller: { perOrderCents: 1_000_000, perScanCents: 9_999_999, maxOpenCopies: 99 },
    });
    assert.equal(caps.perOrderCents, COPY_LANE_DEFAULT_CENTS, "a caller must not be able to raise the per-order cap");
    assert.equal(caps.perScanCents, COPY_LANE_DEFAULT_CENTS, "a caller must not be able to raise the scan budget");
    assert.equal(caps.maxOpenCopies, COPY_MAX_OPEN_DEFAULT, "a caller must not be able to raise the open-copy cap");
  });

  it("honours a caller that TIGHTENS", () => {
    const caps = resolveCaps({
      env: NO_ENV,
      caller: { perOrderCents: 500, perScanCents: 800, maxOpenCopies: 1 },
    });
    assert.equal(caps.perOrderCents, 500);
    assert.equal(caps.perScanCents, 800);
    assert.equal(caps.maxOpenCopies, 1);
  });

  it("maxOpenCopies: 0 is a legal tightening, not a missing value", () => {
    assert.equal(resolveCaps({ env: NO_ENV, caller: { maxOpenCopies: 0 } }).maxOpenCopies, 0);
  });

  it("DRAGON_COPY_MAX_NOTIONAL_CENTS tightens the lane", () => {
    const caps = resolveCaps({ env: { DRAGON_COPY_MAX_NOTIONAL_CENTS: "500" } });
    assert.equal(caps.perOrderCents, 500);
    assert.equal(caps.perScanCents, 500);
  });

  it("the DECK ceiling still wins when it is the tighter of the two", () => {
    const caps = resolveCaps({ env: { DRAGON_MAX_ORDER_NOTIONAL_CENTS: "300" } });
    assert.equal(caps.perOrderCents, 300);
  });

  it("a copy-lane env LARGER than the deck ceiling cannot raise it", () => {
    const caps = resolveCaps({
      env: { DRAGON_MAX_ORDER_NOTIONAL_CENTS: "700", DRAGON_COPY_MAX_NOTIONAL_CENTS: "50000" },
    });
    assert.equal(caps.perOrderCents, 700);
    assert.equal(caps.perScanCents, 700);
  });

  it("nonsense env values fall back to the default, never to no limit", () => {
    for (const raw of ["", "abc", "0", "-5"]) {
      const caps = resolveCaps({ env: { DRAGON_COPY_MAX_NOTIONAL_CENTS: raw } });
      assert.equal(caps.perOrderCents, COPY_LANE_DEFAULT_CENTS, `raw=${JSON.stringify(raw)}`);
    }
  });

  it("the measured balance tightens the SCAN budget", () => {
    // $42.40 measured 2026-10-04. Half is 2120c, which the $20 lane cap tightens.
    assert.equal(resolveCaps({ env: NO_ENV, balanceCents: 4240 }).perScanCents, 2_000);
    // A smaller balance bites: half of 1000c is 500c.
    const thin = resolveCaps({ env: NO_ENV, balanceCents: 1_000 });
    assert.equal(thin.perScanCents, 500);
    assert.equal(thin.perOrderCents, 500, "one order may never exceed what the whole scan may commit");
  });

  it("an empty account resolves to zero, and zero is a refusal downstream", () => {
    const caps = resolveCaps({ env: NO_ENV, balanceCents: 0 });
    assert.equal(caps.perScanCents, 0);
    assert.equal(caps.perOrderCents, 0);
    const plan = planCopyBatch([intent()], caps, freshState());
    assert.equal(plan.accepted.length, 0);
    assert.equal(plan.rejected[0].reason, "no_usable_cap");
  });

  it("an omitted balance is UNKNOWN, which is not zero", () => {
    assert.equal(resolveCaps({ env: NO_ENV }).perScanCents, COPY_LANE_DEFAULT_CENTS);
  });

  it("★ THE TWO MAKER SWITCHES AGREE, and they agree on REFUSE", () => {
    // These are one decision expressed in two layers. They used to disagree:
    // DEFAULT_SIGNAL_CONFIG.includeMakerFills was false while resolveCaps used
    // `caller?.allowMakerFills !== false`, i.e. TRUE by default — and the runnable
    // entry point passes no caller, so the lane Classic runs took the permissive
    // one. If either side flips again, this fails.
    assert.equal(DEFAULT_SIGNAL_CONFIG.includeMakerFills, false);
    assert.equal(resolveCaps({ env: NO_ENV }).allowMakerFills, false);
    assert.equal(
      resolveCaps({ env: NO_ENV }).allowMakerFills,
      DEFAULT_SIGNAL_CONFIG.includeMakerFills,
      "the routing default must BE the scan default, not a copy of it",
    );
  });

  it("allowMakerFills is an EXPLICIT opt-in — undefined and false both refuse", () => {
    assert.equal(resolveCaps({ env: NO_ENV, caller: {} }).allowMakerFills, false);
    assert.equal(resolveCaps({ env: NO_ENV, caller: { allowMakerFills: undefined } }).allowMakerFills, false);
    assert.equal(resolveCaps({ env: NO_ENV, caller: { allowMakerFills: false } }).allowMakerFills, false);
    assert.equal(resolveCaps({ env: NO_ENV, caller: { allowMakerFills: true } }).allowMakerFills, true);
  });

  it("minConfidence is the scan layer's floor, and a caller may only RAISE it", () => {
    assert.equal(resolveCaps({ env: NO_ENV }).minConfidence, DEFAULT_SIGNAL_CONFIG.minConfidence);
    assert.equal(resolveCaps({ env: NO_ENV, caller: { minConfidence: 0.6 } }).minConfidence, 0.6);
    // Lowering a floor is loosening a safety cap. Ignored, like every other cap.
    assert.equal(resolveCaps({ env: NO_ENV, caller: { minConfidence: 0 } }).minConfidence, 0.25);
    assert.equal(resolveCaps({ env: NO_ENV, caller: { minConfidence: -5 } }).minConfidence, 0.25);
    assert.equal(
      resolveCaps({ env: NO_ENV, caller: { minConfidence: Number.NaN } }).minConfidence,
      0.25,
    );
  });
});

/* ── 2. THE SCAN BUDGET ─────────────────────────────────────────────────── */

describe("planCopyBatch — the per-scan total ceiling", () => {
  const caps = resolveCaps({ env: NO_ENV, caller: { perScanCents: 45 } });

  it("blocks order N+1 even though every order is individually legal", () => {
    const intents = [
      intent({ ticker: "A" }),
      intent({ ticker: "B" }),
      intent({ ticker: "C" }),
    ];
    // Each is 2 x 10c = 20c, under the 45c per-order cap. Two fit; the third does not.
    const plan = planCopyBatch(intents, caps, freshState());
    assert.equal(plan.accepted.length, 2);
    assert.equal(plan.committedCents, 40);
    assert.equal(plan.rejected.length, 1);
    assert.equal(plan.rejected[0].reason, "exceeds_scan_budget");
    assert.match(plan.rejected[0].detail, /needs 20c, scan has committed 40c of 45c/);
  });

  it("does NOT break the loop — a cheaper candidate behind an expensive one still fits", () => {
    const intents = [
      intent({ ticker: "A" }),
      intent({ ticker: "B" }),
      intent({ ticker: "C" }),
      intent({ ticker: "D", count: 1, priceCents: 5 }),
    ];
    const plan = planCopyBatch(intents, caps, freshState());
    assert.deepEqual(
      plan.accepted.map((o) => o.ticker),
      ["A", "B", "D"],
    );
    assert.equal(plan.committedCents, 45);
    assert.equal(plan.rejected.length, 1);
    assert.equal(plan.rejected[0].reason, "exceeds_scan_budget");
  });

  it("the scan budget is never exceeded, whatever the order of candidates", () => {
    const plan = planCopyBatch(
      [intent({ ticker: "A", count: 4, priceCents: 10 }), intent({ ticker: "B" })],
      caps,
      freshState(),
    );
    assert.ok(plan.committedCents <= caps.perScanCents, `${plan.committedCents} <= ${caps.perScanCents}`);
  });
});

/* ── 3. EVERY DROP IS NAMED ─────────────────────────────────────────────── */

describe("planCopyBatch — no silent truncation", () => {
  const caps = resolveCaps({ env: NO_ENV });

  it("a Polymarket signal with no Kalshi ticker is no_ticker, not a crash", () => {
    const plan = planCopyBatch(
      [intent({ venue: "polymarket", sourceTrader: "FadeTheNoise", ticker: null })],
      caps,
      freshState(),
    );
    assert.equal(plan.accepted.length, 0);
    assert.equal(plan.rejected[0].reason, "no_ticker");
    assert.match(plan.rejected[0].detail, /Kalshi only/);
  });

  it("intentToOrderRequest refuses a null ticker on its own too", () => {
    const r = intentToOrderRequest(intent({ ticker: null }), caps);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, "no_ticker");
  });

  it("intentToOrderRequest passes side/action/count/price through VERBATIM", () => {
    const r = intentToOrderRequest(intent({ side: "no", action: "sell", count: 3, priceCents: 61 }), caps);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.request, {
        ticker: "KXBTCD-26OCT04-T120000",
        side: "no",
        action: "sell",
        count: 3,
        priceCents: 61,
        maxNotionalCents: caps.perOrderCents,
      });
    }
  });

  it("a price outside 1-99c is price_out_of_band", () => {
    for (const priceCents of [0, 100, 120, 10.5]) {
      const plan = planCopyBatch([intent({ priceCents })], caps, freshState());
      assert.equal(plan.rejected[0].reason, "price_out_of_band", `priceCents=${priceCents}`);
    }
  });

  it("a non-positive count is below_min_count", () => {
    const plan = planCopyBatch([intent({ count: 0 })], caps, freshState());
    assert.equal(plan.rejected[0].reason, "below_min_count");
  });

  it("an oversized BUY is exceeds_per_order_cap and says what count fits", () => {
    const plan = planCopyBatch([intent({ count: 300, priceCents: 10 })], caps, freshState());
    assert.equal(plan.rejected[0].reason, "exceeds_per_order_cap");
    assert.match(plan.rejected[0].detail, /200 contracts fit/);
  });

  it("an oversized SELL keeps its own name, so a blocked exit is never read as a blocked entry", () => {
    const plan = planCopyBatch([intent({ action: "sell", count: 300, priceCents: 10 })], caps, freshState());
    assert.equal(plan.rejected[0].reason, "exceeds_per_order_cap_exit");
  });

  it("already at the open-copy cap rejects max_open_copies", () => {
    const plan = planCopyBatch([intent()], caps, freshState({ openCopies: COPY_MAX_OPEN_DEFAULT }));
    assert.equal(plan.accepted.length, 0);
    assert.equal(plan.rejected[0].reason, "max_open_copies");
  });

  it("the open-copy cap counts positions opened EARLIER IN THIS SCAN", () => {
    const tight = resolveCaps({ env: NO_ENV, caller: { maxOpenCopies: 2 } });
    const plan = planCopyBatch(
      [intent({ ticker: "A" }), intent({ ticker: "B" }), intent({ ticker: "C" })],
      tight,
      freshState({ openCopies: 1 }),
    );
    assert.equal(plan.accepted.length, 1);
    assert.equal(plan.rejected.filter((r) => r.reason === "max_open_copies").length, 2);
  });

  it("★ a maker fill is refused BY DEFAULT, and only an explicit opt-in sends it", () => {
    const maker = intent({ role: "maker" });

    // Default caps — what `runCopyLane` and scripts/starra-copy-scan.ts actually
    // resolve, since neither passes a caller.
    const plan = planCopyBatch([maker], caps, freshState());
    assert.equal(plan.accepted.length, 0);
    assert.equal(plan.rejected[0].reason, "maker_fill_unmirrorable");
    assert.match(plan.rejected[0].detail, /DEFAULT REFUSE/);

    const optedIn = resolveCaps({ env: NO_ENV, caller: { allowMakerFills: true } });
    assert.equal(planCopyBatch([maker], optedIn, freshState()).accepted.length, 1);
  });

  it("★ an intent under the confidence floor is dropped by its own NAME", () => {
    const weak = intent({ confidence: 0.1 });
    const plan = planCopyBatch([weak], caps, freshState());
    assert.equal(plan.accepted.length, 0);
    assert.equal(plan.rejected[0].reason, "below_min_confidence");
    assert.match(plan.rejected[0].detail, /scored 0\.1, floor is 0\.25/);
  });

  it("the floor is enforced here too, so an intent that skipped copy-signals cannot dodge it", () => {
    // 0.25 exactly is ON the floor and allowed; the check is `>=`.
    assert.equal(planCopyBatch([intent({ confidence: 0.25 })], caps, freshState()).accepted.length, 1);
    assert.equal(planCopyBatch([intent({ confidence: 0.249 })], caps, freshState()).accepted.length, 0);
    // A NaN confidence is not a number above the floor, so it is refused.
    const nan = planCopyBatch([intent({ confidence: Number.NaN })], caps, freshState());
    assert.equal(nan.accepted.length, 0);
    assert.equal(nan.rejected[0].reason, "below_min_confidence");
  });

  it("every intent is accounted for — accepted + rejected never loses a row", () => {
    const intents = [
      intent({ ticker: "A" }),
      intent({ ticker: "B", priceCents: 0 }),
      intent({ ticker: null, venue: "polymarket" }),
      intent({ ticker: "D", count: 0 }),
      intent({ ticker: "E", count: 9_999 }),
    ];
    const plan = planCopyBatch(intents, caps, freshState());
    assert.equal(plan.accepted.length + plan.rejected.length, intents.length);
  });
});

/* ── 4. IDEMPOTENCY ─────────────────────────────────────────────────────── */

describe("planCopyBatch — idempotency", () => {
  const caps = resolveCaps({ env: NO_ENV });

  it("the same intent twice in one scan is duplicate_intent", () => {
    const plan = planCopyBatch([intent(), intent()], caps, freshState());
    assert.equal(plan.accepted.length, 1);
    assert.equal(plan.rejected.length, 1);
    assert.equal(plan.rejected[0].reason, "duplicate_intent");
    assert.match(plan.rejected[0].detail, /more than once in this scan/);
  });

  it("an intentKey from an earlier scan is duplicate_intent", () => {
    const key = intentKey(intent());
    const plan = planCopyBatch([intent()], caps, freshState({ alreadyActed: [key] }));
    assert.equal(plan.accepted.length, 0);
    assert.equal(plan.rejected[0].reason, "duplicate_intent");
    assert.match(plan.rejected[0].detail, /earlier scan/);
  });

  it("TWO DIFFERENT TRADERS on the identical bet collapse to ONE order", () => {
    const plan = planCopyBatch(
      [intent({ sourceTrader: "BitcoinTradingChallenge" }), intent({ sourceTrader: "szg.szg" })],
      caps,
      freshState(),
    );
    assert.equal(plan.accepted.length, 1, "agreement is a stronger signal, not a second position");
    assert.equal(plan.rejected[0].reason, "duplicate_intent");
    assert.match(plan.rejected[0].detail, /byte-identical/);
  });

  it("provenance is keyed by clientOrderId and names who the bet came from", () => {
    const plan = planCopyBatch([intent()], caps, freshState());
    const id = plan.accepted[0].clientOrderId;
    assert.equal(plan.provenance[id].sourceTrader, "BitcoinTradingChallenge");
    assert.equal(plan.provenance[id].venue, "kalshi");
    assert.equal(plan.provenance[id].notionalCents, 20);
  });
});

/* ── 5. PURITY ──────────────────────────────────────────────────────────── */

describe("planCopyBatch — pure", () => {
  it("same inputs twice -> deep-equal outputs, and nothing passed in is mutated", () => {
    const caps: CopyCaps = resolveCaps({ env: NO_ENV, caller: { perScanCents: 60 } });
    const intents = [
      intent({ ticker: "A" }),
      intent({ ticker: "B" }),
      intent({ ticker: "C" }),
      intent({ ticker: "D", count: 400 }),
      intent({ ticker: null, venue: "polymarket" }),
    ];
    const state = freshState({ openCopies: 1, alreadyActed: ["kalshi|x|Z|yes|buy"] });

    const intentsBefore = structuredClone(intents);
    const stateBefore = structuredClone(state);
    const capsBefore = structuredClone(caps);

    const a = planCopyBatch(intents, caps, state);
    const b = planCopyBatch(intents, caps, state);

    assert.deepEqual(a, b, "planning is deterministic for a fixed nowMs");
    assert.deepEqual(intents, intentsBefore, "the intents array must not be touched");
    assert.deepEqual(state, stateBefore, "the state object must not be touched");
    assert.deepEqual(caps, capsBefore, "the caps object must not be touched");
    assert.ok(a.accepted.length > 0 && a.rejected.length > 0, "the fixture must exercise both paths");
  });
});

/* ── 6. DRY RUN IS OFFLINE ──────────────────────────────────────────────── */

describe("submitCopyBatch — live:false makes ZERO network calls", () => {
  const caps = resolveCaps({ env: NO_ENV });

  it("exactly zero fetch calls, and it reports what it WOULD have sent", async () => {
    const plan = planCopyBatch([intent({ ticker: "A" }), intent({ ticker: "B" })], caps, freshState());
    const net = stub([{ status: 200 }]);

    const report = await submitCopyBatch(plan, { deps: { token: "t", fetchImpl: net.fetchImpl } });

    assert.equal(net.calls(), 0, "a dry run that touches the network is not a dry run");
    assert.equal(report.live, false);
    assert.equal(report.sentCount, 0);
    assert.equal(report.sentCents, 0);
    assert.equal(report.plannedCents, 40);
    assert.equal(report.outcomes.length, 2);
    for (const o of report.outcomes) assert.equal(o.disposition, "would_send");
    assert.deepEqual(report.outcomes[0].body, plan.accepted[0], "the body must be the exact JSON that would be POSTed");
  });

  it("runCopyLane is offline end to end in dry run — not even /bot/state", async () => {
    const net = stub([{ status: 200, body: PAPER }]);
    const run = await runCopyLane({
      intents: [intent()],
      state: freshState(),
      env: NO_ENV,
      balanceCents: 4_240,
      deps: { token: "t", fetchImpl: net.fetchImpl },
    });
    assert.equal(net.calls(), 0);
    assert.equal(run.clearance, null);
    assert.equal(run.submission.sentCount, 0);
    assert.equal(run.plan.accepted.length, 1);
  });
});

/* ── 7. THE HALT ────────────────────────────────────────────────────────── */

describe("submitCopyBatch — a 429 stops the WHOLE batch", () => {
  const caps = resolveCaps({ env: NO_ENV });
  const CLEARED = { ok: true as const, mode: "paper" };

  function fourOrders() {
    return planCopyBatch(
      [intent({ ticker: "A" }), intent({ ticker: "B" }), intent({ ticker: "C" }), intent({ ticker: "D" })],
      caps,
      freshState(),
    );
  }

  it("429 on order 2 of 4: fetch called exactly twice, the last two UNSENT", async () => {
    const plan = fourOrders();
    assert.equal(plan.accepted.length, 4, "the fixture must actually produce four orders");

    const net = stub([{ status: 200, body: { orderId: "one" } }, { status: 429 }]);
    const report = await submitCopyBatch(plan, {
      live: true,
      deps: { token: "t", fetchImpl: net.fetchImpl },
      clearance: CLEARED,
    });

    assert.equal(net.calls(), 2, "never walk the rest of the list into the same lockout");
    assert.equal(report.sentCount, 2);
    assert.equal(report.outcomes[0].disposition, "sent");
    assert.equal(report.outcomes[1].disposition, "sent");

    const tail = report.outcomes.slice(2);
    for (const o of tail) {
      assert.equal(o.disposition, "unsent", "an order that was never attempted is unsent, not failed");
      if (o.disposition === "unsent") assert.equal(o.reason, "batch_halted");
    }
    assert.equal(report.haltedOn?.state, "blocked");
    assert.equal(report.haltedOn?.clientOrderId, plan.accepted[1].clientOrderId);
    assert.equal(report.sentCents, 20, "only the order that came back ok counts as committed");
  });

  it("401 on order 1 stops it just as hard, and nothing else is tried", async () => {
    const plan = fourOrders();
    const net = stub([{ status: 401, body: { error: "invalid_agent_token" } }]);
    const report = await submitCopyBatch(plan, {
      live: true,
      deps: { token: "t", fetchImpl: net.fetchImpl },
      clearance: CLEARED,
    });
    assert.equal(net.calls(), 1);
    assert.equal(report.haltedOn?.state, "rejected");
    assert.equal(report.haltedOn?.code, "invalid_agent_token");
    assert.equal(report.outcomes.filter((o) => o.disposition === "unsent").length, 3);
  });

  it("no token configured halts instead of looping four no-ops", async () => {
    const plan = fourOrders();
    const net = stub([{ status: 200 }]);
    const report = await submitCopyBatch(plan, {
      live: true,
      deps: { token: null, fetchImpl: net.fetchImpl },
      clearance: CLEARED,
    });
    assert.equal(net.calls(), 0);
    assert.equal(report.haltedOn?.state, "off");
    assert.equal(report.sentCount, 1, "the first call is what discovered there is no token");
  });

  it("a 500 on order 2 does NOT halt — that failure is about that order", async () => {
    const plan = fourOrders();
    const net = stub([
      { status: 200, body: { orderId: "one" } },
      { status: 500, body: { error: "agent_internal_error" } },
      { status: 200, body: { orderId: "three" } },
    ]);
    const report = await submitCopyBatch(plan, {
      live: true,
      deps: { token: "t", fetchImpl: net.fetchImpl },
      clearance: CLEARED,
    });
    assert.equal(net.calls(), 4);
    assert.equal(report.haltedOn, null);
    assert.equal(report.outcomes.filter((o) => o.disposition === "unsent").length, 0);
  });

  it("the clientOrderId minted at PLAN time is the one that reaches his app", async () => {
    const plan = fourOrders();
    const net = stub([{ status: 200, body: {} }]);
    await submitCopyBatch(plan, {
      live: true,
      deps: { token: "t", fetchImpl: net.fetchImpl },
      clearance: CLEARED,
    });
    assert.equal(net.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/order`);
    assert.equal(net.methods[0], "POST");
    assert.equal(net.bodies[0]?.clientOrderId, plan.accepted[0].clientOrderId);
    assert.equal(net.bodies[0]?.ticker, "A");
    assert.equal(
      Object.keys(net.bodies[0] ?? {}).includes("maxNotionalCents"),
      false,
      "the local ceiling is a local policy and is not part of the order body",
    );
  });
});

/* ── 8. THE MODE GUARD ──────────────────────────────────────────────────── */

describe("assertCopyModeAllowed — read the mode, never set it", () => {
  it("accepts paper by default", async () => {
    const net = stub([{ status: 200, body: PAPER }]);
    const g = await assertCopyModeAllowed({ token: "t", fetchImpl: net.fetchImpl });
    assert.equal(g.ok, true);
    if (g.ok) assert.equal(g.mode, "paper");
    assert.equal(net.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/bot/state`);
    assert.equal(net.methods[0], "GET");
  });

  it("REFUSES mode:'live' when it was not opted in", async () => {
    const net = stub([{ status: 200, body: LIVE }]);
    const g = await assertCopyModeAllowed({ token: "t", fetchImpl: net.fetchImpl });
    assert.equal(g.ok, false);
    if (!g.ok) {
      assert.equal(g.code, "mode_not_accepted");
      assert.equal(g.mode, "live");
    }
  });

  it("allows live only when the caller named it explicitly", async () => {
    const net = stub([{ status: 200, body: LIVE }]);
    const g = await assertCopyModeAllowed({ token: "t", fetchImpl: net.fetchImpl }, ["paper", "live"]);
    assert.equal(g.ok, true);
  });

  it("FAILS CLOSED when /bot/state cannot be read", async () => {
    for (const status of [500, 404]) {
      const net = stub([{ status }]);
      const g = await assertCopyModeAllowed({ token: "t", fetchImpl: net.fetchImpl });
      assert.equal(g.ok, false, `status=${status}`);
      if (!g.ok) assert.equal(g.code, "bot_state_unreadable");
    }
  });

  it("a 429 on /bot/state is also a closed door", async () => {
    const net = stub([{ status: 429 }]);
    const g = await assertCopyModeAllowed({ token: "t", fetchImpl: net.fetchImpl });
    assert.equal(g.ok, false);
    if (!g.ok) assert.match(g.detail, /blocked/);
  });

  it("a missing mode field is not silently treated as paper", async () => {
    const net = stub([{ status: 200, body: { running: false, category: "sports" } }]);
    const g = await assertCopyModeAllowed({ token: "t", fetchImpl: net.fetchImpl });
    assert.equal(g.ok, false);
  });
});

describe("the live path cannot bypass the guard", () => {
  const caps = resolveCaps({ env: NO_ENV });

  it("live:true with no clearance sends NOTHING and makes no fetch", async () => {
    const plan = planCopyBatch([intent({ ticker: "A" }), intent({ ticker: "B" })], caps, freshState());
    const net = stub([{ status: 200 }]);
    const report = await submitCopyBatch(plan, { live: true, deps: { token: "t", fetchImpl: net.fetchImpl } });
    assert.equal(net.calls(), 0);
    assert.equal(report.sentCount, 0);
    for (const o of report.outcomes) {
      assert.equal(o.disposition, "unsent");
      if (o.disposition === "unsent") assert.equal(o.reason, "no_mode_clearance");
    }
  });

  it("runCopyLane live:true against mode:'live' reads /bot/state ONCE and sends nothing", async () => {
    const net = stub([{ status: 200, body: LIVE }]);
    const run = await runCopyLane({
      intents: [intent({ ticker: "A" }), intent({ ticker: "B" })],
      state: freshState(),
      env: NO_ENV,
      balanceCents: 4_240,
      deps: { token: "t", fetchImpl: net.fetchImpl },
      live: true,
    });
    assert.equal(net.calls(), 1, "one read of /bot/state, and no order");
    assert.equal(net.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/bot/state`);
    assert.equal(run.clearance?.ok, false);
    assert.equal(run.submission.sentCount, 0);
    assert.equal(run.plan.accepted.length, 2, "the plan is still returned, so he can see what it would have done");
  });

  it("runCopyLane live:true in paper mode sends the plan, reading state first", async () => {
    const net = stub([{ status: 200, body: PAPER }, { status: 200, body: { orderId: "x" } }]);
    const run = await runCopyLane({
      intents: [intent({ ticker: "A" })],
      state: freshState(),
      env: NO_ENV,
      balanceCents: 4_240,
      deps: { token: "t", fetchImpl: net.fetchImpl },
      live: true,
    });
    assert.equal(net.calls(), 2);
    assert.equal(net.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/bot/state`);
    assert.equal(net.urls[1], `${DRAGON_TRADAR_AGENT_BASE}/order`);
    assert.equal(run.submission.sentCount, 1);
    assert.equal(run.submission.outcomes[0].disposition, "sent");
  });
});

/* ── 9. THE SEAM WITH THE SCANNER ───────────────────────────────────────── */

describe("the scanner's rejections merge with this lane's without a cast", () => {
  it("a frozen CopyRejection is assignable to a RouteRejection", () => {
    // `copy-signals.ts` hands back `Rejected[]` built from the FROZEN
    // `CopyRejection` union. `RouteRejection` is a strict superset, so the two
    // lists concatenate with no cast and no widening. If the frozen file ever
    // gains a reason this will still compile; if `RouteRejection` ever stops
    // including it, typecheck fails here rather than in a caller.
    const fromScanner: Rejected[] = [
      { reason: "trades_hidden", detail: "98 of the top 100 are hidden" },
      { reason: "no_kalshi_match", detail: "no live market" },
    ];
    // 25c scan budget, two 20c orders: each one clears the per-order cap (which
    // resolveCaps clamped to 25c), so the SECOND is stopped by the scan budget.
    const caps = resolveCaps({ env: NO_ENV, caller: { perScanCents: 25 } });
    const plan = planCopyBatch([intent({ ticker: "A" }), intent({ ticker: "B" })], caps, freshState());
    const merged: RouteRejected[] = [...fromScanner, ...plan.rejected];
    assert.equal(merged.length, fromScanner.length + plan.rejected.length);
    assert.equal(merged[0].reason, "trades_hidden");
    // The fixture must actually produce a lane-side rejection, or this proves nothing.
    assert.equal(plan.accepted.length, 1);
    assert.equal(plan.rejected.length, 1);
    assert.equal(plan.rejected[0].reason, "exceeds_scan_budget");
  });
});

/* ── 10. THE FEED ───────────────────────────────────────────────────────── */

describe("copyFeedLines", () => {
  it("names the dry run, the provenance and every drop", async () => {
    const run = await runCopyLane({
      intents: [intent({ ticker: "A" }), intent({ ticker: "B", priceCents: 0 })],
      state: freshState(),
      env: NO_ENV,
    });
    const lines = copyFeedLines(run);
    assert.match(lines[0], /mode=dry/);
    assert.ok(lines.some((l) => l.includes("would send") && l.includes("kalshi:BitcoinTradingChallenge")));
    assert.ok(lines.some((l) => l.includes("dropped — price_out_of_band")));
  });
});
