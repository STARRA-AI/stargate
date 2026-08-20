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
} from "../src/lib/dragon-tradar";

function stub(status: number, body: unknown = {}) {
  let calls = 0;
  const urls: string[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls++;
    urls.push(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      // expose what the caller sent so auth can be asserted
      __init: init,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls, urls };
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

  it("401 is REJECTED and also asked exactly once", async () => {
    const s = stub(401, { error: "invalid_agent_token" });
    const r = await readAgent({ token: "bad", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "rejected" });
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

  it("401 stays REJECTED with no code field", async () => {
    const s = stub(401, { error: "invalid_agent_token" });
    const r = await agentGet<unknown>("/bot/state", { token: "bad", fetchImpl: s.fetchImpl });
    assert.deepEqual(r, { state: "rejected" });
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

  it("readOrders hits /orders", async () => {
    const s = stub(200, []);
    await readOrders({ token: "t", fetchImpl: s.fetchImpl });
    assert.equal(s.urls[0], `${DRAGON_TRADAR_AGENT_BASE}/orders`);
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
