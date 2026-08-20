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
import { readAgent, balanceUsd, DRAGON_TRADAR_AGENT_BASE } from "../src/lib/dragon-tradar";

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
