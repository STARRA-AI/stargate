/**
 * DRAGON TRADAR, SPOKEN — the verbs that let Classic OPERATE his bot instead of
 * only reading a number off a panel.
 *
 * Three properties are load-bearing here, and each one failed silently before
 * this file existed:
 *
 *   1. THE TRIGGER FIRES. `/api/dragon/control` and `/api/dragon/order` were
 *      complete, tested, and called by NOTHING — a green suite over a dead
 *      trigger. So every test below asserts the NETWORK CALL happened, with its
 *      method, path and body, not merely that a function returned a nice
 *      sentence.
 *   2. "dragon" DOES NOT FALL THROUGH. "dragon positions" is a question about
 *      his BOT; the Kalshi-direct reader answers a different question with a
 *      confident number, so the dragon branch must win the routing.
 *   3. THE PUBLIC ROUTE CANNOT START OR STOP THE BOT. /api/voice-tools faces the
 *      open internet. That invariant is grepped, not assumed, exactly like
 *      tests/public-token-scopes.test.ts greps its own.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  maybeTradeReply,
  spokenDragon,
  spokenDragonEngage,
  spokenDragonDisengage,
} from "../src/lib/tools/trade-voice";
import { DRAGON_TRADAR_AGENT_BASE, type AgentDeps } from "../src/lib/dragon-tradar";

type Call = { url: string; method: string; body?: string };

/**
 * A fetch that answers by path. Records every call so a test can assert the
 * trigger actually fired — the whole point of this file.
 */
function stub(routes: Record<string, [number, unknown]>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const hit = Object.keys(routes).find((p) => url === DRAGON_TRADAR_AGENT_BASE + p);
    const [status, body] = hit ? routes[hit] : [404, { error: "no_such_route" }];
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, deps: { token: "test-token", fetchImpl } satisfies AgentDeps };
}

/** The live shapes, copied from the real 200s recorded 2026-09-14. */
const LIVE = {
  "/stats": [200, { connected: true, balanceCents: 3012, positions: [] }] as [number, unknown],
  "/bot/state": [
    200,
    {
      running: false,
      category: "sports",
      mode: "paper",
      lastScanAt: null,
      config: { minBetCents: 1000 },
    },
  ] as [number, unknown],
  "/performance": [
    200,
    {
      realizedPnlCents: 0,
      unrealizedPnlCents: 0,
      winRate: 0,
      tradeCount: 0,
      since: "2026-09-14T04:00:00.000Z",
    },
  ] as [number, unknown],
};

describe("spokenDragon — the read", () => {
  it("says running state, category, mode, balance and P&L in one breath", async () => {
    const { calls, deps } = stub(LIVE);
    const said = await spokenDragon(deps);

    assert.match(said, /stopped/);
    assert.match(said, /sports/);
    assert.match(said, /paper/);
    assert.match(said, /\$30\.12/);
    assert.match(said, /hasn't traded yet/);
    // All three reads actually went out — no field is quietly synthesized.
    assert.equal(calls.length, 3);
  });

  it("reports a loss as a loss", async () => {
    const { deps } = stub({
      ...LIVE,
      "/performance": [
        200,
        { realizedPnlCents: -450, unrealizedPnlCents: 0, winRate: 0, tradeCount: 3, since: "x" },
      ],
    });
    const said = await spokenDragon(deps);
    assert.match(said, /3 trades/);
    assert.match(said, /down \$4\.50/);
    assert.doesNotMatch(said, /up \$4\.50/);
  });

  it("an unlinked token is a sentence, not a crash", async () => {
    const said = await spokenDragon({ token: null });
    assert.match(said, /isn't linked/);
  });

  it("a 429 says throttled, never 'regenerate your token'", async () => {
    const { deps } = stub({ "/bot/state": [429, { error: "temporarily_blocked" }] });
    const said = await spokenDragon(deps);
    assert.match(said, /throttled/);
    assert.doesNotMatch(said, /regenerate/i);
  });

  it("balance and P&L degrade independently — bot state alone still answers", async () => {
    const { deps } = stub({ "/bot/state": LIVE["/bot/state"] });
    const said = await spokenDragon(deps);
    assert.match(said, /stopped/);
    assert.doesNotMatch(said, /\$/);
  });
});

describe("engage / disengage — the trigger must actually fire", () => {
  it("engage POSTs /bot/engage with the category and reads the mode back", async () => {
    const { calls, deps } = stub({
      "/bot/engage": [200, { ok: true }],
      "/bot/state": [200, { running: true, category: "crypto", mode: "paper", lastScanAt: null, config: {} }],
    });
    const said = await spokenDragonEngage("crypto", deps);

    const post = calls.find((c) => c.method === "POST");
    assert.ok(post, "no POST was made — the trigger is dead");
    assert.equal(post.url, DRAGON_TRADAR_AGENT_BASE + "/bot/engage");
    assert.equal(post.body, JSON.stringify({ category: "crypto" }));
    // He HEARS the mode rather than having to go and look it up.
    assert.match(said, /paper mode/);
    assert.match(said, /crypto/);
  });

  it("an unknown category never reaches the network", async () => {
    const { calls, deps } = stub({ "/bot/engage": [200, { ok: true }] });
    const said = await spokenDragonEngage("roulette", deps);
    assert.equal(calls.length, 0);
    assert.match(said, /don't know that category/);
  });

  it("disengage POSTs /bot/disengage", async () => {
    const { calls, deps } = stub({ "/bot/disengage": [200, { ok: true }] });
    const said = await spokenDragonDisengage(deps);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, DRAGON_TRADAR_AGENT_BASE + "/bot/disengage");
    assert.match(said, /disengaged/);
  });

  it("a stop that did not take says so — it never reports success it did not get", async () => {
    const { deps } = stub({ "/bot/disengage": [500, { error: "boom" }] });
    const said = await spokenDragonDisengage(deps);
    assert.match(said, /didn't take/);
    assert.doesNotMatch(said, /Dragon's disengaged/);
  });
});

describe("intent routing", () => {
  it("'dragon positions' answers about the BOT, not the Kalshi account", async () => {
    const { calls, deps } = stub(LIVE);
    const said = await maybeTradeReply("dragon positions", deps);
    assert.ok(said);
    // Every call went to HIS app. Nothing leaked to the Kalshi-direct reader.
    assert.ok(calls.length > 0);
    assert.ok(calls.every((c) => c.url.startsWith(DRAGON_TRADAR_AGENT_BASE)));
    assert.match(said, /bot's stopped/);
  });

  it("'stop the dragon' disengages", async () => {
    const { calls, deps } = stub({ "/bot/disengage": [200, { ok: true }] });
    const said = await maybeTradeReply("stop the dragon", deps);
    assert.equal(calls[0]?.url, DRAGON_TRADAR_AGENT_BASE + "/bot/disengage");
    assert.match(said ?? "", /disengaged/);
  });

  it("'engage dragon on crypto' engages crypto", async () => {
    const { calls, deps } = stub({
      "/bot/engage": [200, { ok: true }],
      "/bot/state": [200, { running: true, category: "crypto", mode: "paper", lastScanAt: null, config: {} }],
    });
    await maybeTradeReply("engage dragon on crypto", deps);
    const post = calls.find((c) => c.method === "POST");
    assert.equal(post?.body, JSON.stringify({ category: "crypto" }));
  });

  it("'engage the dragon' with no category asks, and spends no request", async () => {
    const { calls, deps } = stub({ "/bot/engage": [200, { ok: true }] });
    const said = await maybeTradeReply("engage the dragon", deps);
    assert.equal(calls.length, 0, "it guessed a category instead of asking");
    assert.match(said ?? "", /which one/i);
    assert.match(said ?? "", /crypto/);
  });

  it("a non-trading message still returns null and touches nothing", async () => {
    const { calls, deps } = stub(LIVE);
    assert.equal(await maybeTradeReply("what's the weather like", deps), null);
    assert.equal(calls.length, 0);
  });
});

describe("the public route cannot start or stop his bot", () => {
  const route = readFileSync(
    path.join(process.cwd(), "src/app/api/voice-tools/[action]/route.ts"),
    "utf8",
  );

  it("voice-tools imports the dragon READ and nothing that controls the bot", () => {
    assert.match(route, /spokenDragon\b/);
    assert.ok(
      !/spokenDragonEngage|spokenDragonDisengage|engageBot|disengageBot|placeOrder/.test(route),
      "a control verb reached the internet-facing route",
    );
  });

  it("`dragon` is a read — it is not in WRITE_ACTIONS, so it takes the read token", () => {
    const line = route.split("\n").find((l) => l.includes("WRITE_ACTIONS = new Set"));
    assert.ok(line, "WRITE_ACTIONS moved — re-check the scope of `dragon`");
    assert.ok(!line.includes('"dragon"'));
  });
});
