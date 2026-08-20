/**
 * DRAGON TRADAR AGENT CLIENT — the rule this file exists to defend:
 * a rejected token is NEVER retried.
 *
 * Measured against the live app 2026-08-20: one request with a bad token flips
 * the API to 429 {"error":"temporarily_blocked"}. So a retry loop here does not
 * degrade gracefully — it locks Classic out of his own trading bot. The test
 * counts calls, because "we only try once" is the whole safety property.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readAgent,
  balanceUsd,
  DRAGON_TRADAR_AGENT_BASE,
  agentGet,
  readPositions,
  readOrders,
  readBotState,
  readPerformance,
  engageBot,
  disengageBot,
  patchConfig,
  validateConfigPatch,
  isDragonCategory,
  DRAGON_CATEGORIES,
} from "../src/lib/dragon-tradar";

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
      // expose what the caller sent so auth can be asserted
      __init: init,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls, urls, inits };
}

/** Headers as a plain object — the client always sends a Record, never a Headers. */
function sentHeaders(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

describe("dragon tradar agent read", () => {
  it("no token is OFF, not an error — the deck ships without one", async () => {
    const s = stub(200);
    const r = await readAgent({ token: null, fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "off" });
    assert.equal(s.calls(), 0, "must not touch the network with no token");
  });

  it("empty string counts as unconfigured too", async () => {
    const s = stub(200);
    assert.deepEqual(await readAgent({ token: "", fetchImpl: s.fetchImpl }), { state: "off" });
    assert.equal(s.calls(), 0);
  });

  it("200 returns the live shape the app actually sends", async () => {
    const s = stub(200, { connected: true, balanceCents: 5475, positions: [] });
    const r = await readAgent({ token: "t", fetchImpl: s.fetchImpl });
    assert.equal(r.state, "ok");
    if (r.state !== "ok") return;
    assert.equal(r.stats.connected, true);
    assert.equal(r.stats.balanceCents, 5475);
    assert.deepEqual(r.stats.positions, []);
    assert.equal(balanceUsd(r.stats), 54.75);
  });

  it("hits /stats on the verified base URL", async () => {
    const s = stub(200, {});
    await readAgent({ token: "t", fetchImpl: s.fetchImpl });
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/stats`);
  });

  it("429 is BLOCKED and is asked exactly once — never retried", async () => {
    const s = stub(429, { error: "temporarily_blocked" });
    const r = await readAgent({ token: "bad", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "blocked" });
    assert.equal(s.calls(), 1, "a retry here locks him out of his own bot");
  });

  it("401 is REJECTED, keeps his app's reason, and is asked exactly once", async () => {
    const s = stub(401, { error: "invalid_agent_token" });
    const r = await readAgent({ token: "bad", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "rejected", code: "invalid_agent_token" });
    assert.equal(s.calls(), 1);
  });

  it("a garbage body cannot crash her — it coerces to a safe shape", async () => {
    const s = stub(200, { connected: "yes", balanceCents: null, positions: "none" });
    const r = await readAgent({ token: "t", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, {
      state: "ok",
      stats: { connected: false, balanceCents: 0, positions: [] },
    });
  });

  it("network failure reports status 0, which is not a rejection", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    assert.deepEqual(await readAgent({ token: "t", fetchImpl }), { state: "error", status: 0 });
  });

  it("other HTTP errors keep their status so the cause stays visible", async () => {
    const s = stub(503);
    assert.deepEqual(await readAgent({ token: "t", fetchImpl: s.fetchImpl }), {
      state: "error",
      status: 503,
    });
  });
});

describe("agentGet — the generic client the read wrappers share", () => {
  it("agentGet surfaces the app's error code verbatim", async () => {
    const s = stub(423, { error: "daily_loss_floor_reached" });
    const r = await agentGet<unknown>("/bot/state", { token: "t", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "error", status: 423, code: "daily_loss_floor_reached" });
    assert.equal(s.calls(), 1);
  });

  it("a non-OK body with no error field omits code entirely", async () => {
    const s = stub(503, {});
    const r = await agentGet<unknown>("/bot/state", { token: "t", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "error", status: 503 });
    assert.ok(!("code" in r));
  });

  it("429 stays BLOCKED with no code field, even with a JSON error body", async () => {
    const s = stub(429, { error: "temporarily_blocked" });
    const r = await agentGet<unknown>("/bot/state", { token: "bad", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "blocked" });
    assert.equal(s.calls(), 1);
  });

  it("401 stays REJECTED — the state is the decision, the code is the detail", async () => {
    const s = stub(401, { error: "invalid_agent_token" });
    const r = await agentGet<unknown>("/bot/state", { token: "bad", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "rejected", code: "invalid_agent_token" });
    assert.equal(r.state, "rejected", "still one named state, not a generic error");
  });

  it("200 wraps the raw body as-is, untyped", async () => {
    const s = stub(200, { running: true, category: "sports" });
    const r = await agentGet<{ running: boolean }>("/bot/state", { token: "t", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "ok", stats: { running: true, category: "sports" } });
  });

  it("a non-JSON error body degrades instead of throwing", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return {
        ok: false,
        status: 404,
        json: async () => { throw new SyntaxError("Unexpected token < in JSON"); },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await agentGet<unknown>("/bot/state", { token: "t", fetchImpl });
    assert.deepEqual(r, { state: "error", status: 404 });
    assert.ok(!("code" in r), "no code key when the body is not JSON");
    assert.equal(calls, 1);
  });
});

describe("thin read wrappers — one path each, same agentGet underneath", () => {
  it("readPositions hits /positions", async () => {
    const s = stub(200, []);
    const r = await readPositions({ token: "t", fetchImpl: s.fetchImpl });
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/positions`);
    assert.deepEqual(r, { state: "ok", stats: [] });
  });

  it("readOrders asks for RESTING orders by default, never the whole history", async () => {
    const s = stub(200, []);
    await readOrders({ token: "t", fetchImpl: s.fetchImpl });
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/orders?status=open`);
  });

  it("readOrders can ask for all of them when told to", async () => {
    const s = stub(200, []);
    await readOrders({ token: "t", fetchImpl: s.fetchImpl }, "all");
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/orders?status=all`);
  });

  it("readBotState hits /bot/state", async () => {
    const s = stub(200, {});
    await readBotState({ token: "t", fetchImpl: s.fetchImpl });
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/bot/state`);
  });

  it("readPerformance hits /performance", async () => {
    const s = stub(200, {});
    await readPerformance({ token: "t", fetchImpl: s.fetchImpl });
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/performance`);
  });

  it("readPositions is off with no token, same as every other read", async () => {
    const s = stub(200, []);
    assert.deepEqual(await readPositions({ token: null, fetchImpl: s.fetchImpl }), { state: "off" });
    assert.equal(s.calls(), 0);
  });
});

/**
 * BOT CONTROL — the half of this module that CHANGES something on his side.
 * Two properties are load-bearing here and each has a test that fails loudly:
 *   1. a bad category or a garbage config value never leaves this machine
 *      (fetch call count 0), so his live trading app is never asked a
 *      malformed question;
 *   2. a write is still ONE attempt — 429 is reported, never retried.
 */
describe("dragon tradar bot control", () => {
  it("refuses an unknown Dragon Mode category before any network call", async () => {
    const s = stub(200, {});
    const r = await engageBot("commodities" as never, { token: "t", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "error", status: 0, code: "unknown_category" });
    assert.equal(s.calls(), 0);
  });

  it("every category in the contract is accepted", async () => {
    for (const c of DRAGON_CATEGORIES) {
      const s = stub(200, { ok: true });
      const r = await engageBot(c, { token: "t", fetchImpl: s.fetchImpl });
      assert.equal(r.state, "ok", `${c} must be accepted`);
      assert.equal(s.calls(), 1);
    }
  });

  it("engage POSTs the category to /bot/engage with the bearer token", async () => {
    const s = stub(200, { running: true });
    await engageBot("sports", { token: "t", fetchImpl: s.fetchImpl });
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/bot/engage`);
    assert.equal(s.inits[0].method, "POST");
    assert.equal(sentHeaders(s.inits[0]).Authorization, "Bearer t");
    assert.equal(sentHeaders(s.inits[0])["Content-Type"], "application/json");
    assert.equal(s.inits[0].body, JSON.stringify({ category: "sports" }));
  });

  it("a throttled engage is reported once and NEVER retried", async () => {
    const s = stub(429, { error: "temporarily_blocked" });
    const r = await engageBot("crypto", { token: "t", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "blocked" });
    assert.equal(s.calls(), 1, "a retry here locks him out of his own bot");
  });

  it("a refused write surfaces his app's own error code verbatim", async () => {
    const s = stub(409, { error: "agent_trading_disabled" });
    const r = await engageBot("politics", { token: "t", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "error", status: 409, code: "agent_trading_disabled" });
  });

  it("disengage POSTs an empty body to /bot/disengage", async () => {
    const s = stub(200, { running: false });
    const r = await disengageBot({ token: "t", fetchImpl: s.fetchImpl });
    assert.equal(r.state, "ok");
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/bot/disengage`);
    assert.equal(s.inits[0].method, "POST");
    assert.equal(s.inits[0].body, "{}");
  });

  it("no token is OFF for writes too — control never guesses at an open door", async () => {
    const s = stub(200, {});
    assert.deepEqual(await engageBot("sports", { token: null, fetchImpl: s.fetchImpl }), {
      state: "off",
    });
    assert.deepEqual(await disengageBot({ token: null, fetchImpl: s.fetchImpl }), { state: "off" });
    assert.deepEqual(await patchConfig({ maxLegs: 2 }, { token: null, fetchImpl: s.fetchImpl }), {
      state: "off",
    });
    assert.equal(s.calls(), 0);
  });

  it("a GET still sends no Content-Type after the POST refactor", async () => {
    const s = stub(200, {});
    await readAgent({ token: "t", fetchImpl: s.fetchImpl });
    assert.equal(s.inits[0].method, "GET");
    assert.equal(sentHeaders(s.inits[0])["Content-Type"], undefined);
    assert.equal(s.inits[0].body, undefined);
  });

  it("isDragonCategory rejects non-strings and near-misses", () => {
    assert.equal(isDragonCategory("sports"), true);
    assert.equal(isDragonCategory("Sports"), false);
    assert.equal(isDragonCategory(""), false);
    assert.equal(isDragonCategory(null), false);
    assert.equal(isDragonCategory(2), false);
  });
});

describe("dragon tradar config patch", () => {
  it("an empty patch is refused — a silent no-op must not report success", async () => {
    const s = stub(200, {});
    const r = await patchConfig({}, { token: "t", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "error", status: 0, code: "empty_config" });
    assert.equal(s.calls(), 0);
  });

  it("an unknown key never reaches his app", async () => {
    const s = stub(200, {});
    const r = await patchConfig(
      { maxLegs: 2, maxBetEverything: true },
      { token: "t", fetchImpl: s.fetchImpl },
    );
    assert.deepEqual(r, { state: "error", status: 0, code: "unknown_config_key" });
    assert.equal(s.calls(), 0);
  });

  it("a garbage value for a known key is refused locally", async () => {
    const bad: Record<string, unknown>[] = [
      { minBetCents: "10" },
      { minBetCents: -1 },
      { minBetCents: 10.5 },
      { maxLegs: 0 },
      { scanIntervalMin: 0.5 },
      { minEdgePct: 101 },
      { minConfidencePct: -0.1 },
      { minEdgePct: Number.NaN },
      { autoFire: "yes" },
      { thinkTank: 1 },
    ];
    for (const patch of bad) {
      const s = stub(200, {});
      const r = await patchConfig(patch, { token: "t", fetchImpl: s.fetchImpl });
      assert.deepEqual(
        r,
        { state: "error", status: 0, code: "bad_config_value" },
        `${JSON.stringify(patch)} must be refused`,
      );
      assert.equal(s.calls(), 0);
    }
  });

  it("a valid patch PATCHes /config with exactly the fields given", async () => {
    const s = stub(200, { updated: true });
    const r = await patchConfig(
      { minBetCents: 100, maxLegs: 3, minEdgePct: 7.5, autoFire: false },
      { token: "t", fetchImpl: s.fetchImpl },
    );
    assert.equal(r.state, "ok");
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/config`);
    assert.equal(s.inits[0].method, "PATCH");
    assert.equal(
      s.inits[0].body,
      JSON.stringify({ minBetCents: 100, maxLegs: 3, minEdgePct: 7.5, autoFire: false }),
    );
  });

  it("validateConfigPatch accepts every field in the contract", () => {
    const full = {
      minBetCents: 0,
      maxLegs: 1,
      minEdgePct: 0,
      minConfidencePct: 100,
      autoFire: true,
      scanIntervalMin: 15,
      thinkTank: false,
    };
    assert.deepEqual(validateConfigPatch(full), { ok: true, patch: full });
  });
});

describe("a rejection carries its reason", () => {
  it("401 with a code keeps the code — 'invalid_agent_token' is not 'missing_agent_token'", async () => {
    const s = stub(401, { error: "invalid_agent_token" });
    assert.deepEqual(await readAgent({ token: "t", fetchImpl: s.fetchImpl }), {
      state: "rejected",
      code: "invalid_agent_token",
    });
  });

  it("401 with no parsable body is still just rejected", async () => {
    const s = stub(401, undefined);
    assert.deepEqual(await readAgent({ token: "t", fetchImpl: s.fetchImpl }), {
      state: "rejected",
    });
  });
});
