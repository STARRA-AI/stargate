# STARRA — Full Operational Control of Dragon Tradar

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give STARRA read, control, and order authority over Classic's Dragon Tradar
Kalshi account through `/api/agent/v1`, with the profit-sweep loop he actually runs
built in as a first-class feature.

**Architecture:** Two halves that ship independently. **Half A** is Classic's Replit
app: the agent router today exposes exactly one route (`GET /stats`); it must mirror
the capabilities the web UI already has, behind the same Bearer token and the same
three brakes. **Half B** is the deck: a typed client over that router, her tools, an
order-safety layer, and a realized-profit tracker that tells him when to sweep.
Half B's read tasks work against the routes that exist today; the order tasks unblock
the moment Half A lands.

**Tech Stack:** TypeScript, Next.js 15 (deck, `next dev --turbopack`), node:test via
`tsx --test`, Express (Dragon Tradar on Replit), Kalshi REST.

**Spec:** this document (contract derived by live probe 2026-08-20 — see Verified
Contract below; no Replit source was available).

## Global Constraints

- **NEVER retry a rejected agent token.** One bad token returns
  `429 {"error":"temporarily_blocked"}` and locks Classic out of his own bot.
  One attempt, no retry, ever. Already enforced in `src/lib/dragon-tradar.ts`.
- **No new paid services.** Everything here is his existing Kalshi account, his
  existing Replit app, and free/open-source tooling.
- **Secrets never enter a transcript or a repo.** The agent token lives in
  `stargate/.env.local` as `DRAGON_TRADAR_AGENT_TOKEN`, resolved through
  `getKey("dragontradar_agent_token")`. Read it by name; never echo the value.
- **Three brakes stay Classic's alone:** the panel's "Agent trading enabled" toggle,
  `Max $ per order`, and the server's `AGENT_LIVE_TRADING_ENABLED`. Nothing in this
  plan loosens, bypasses, or asks him to loosen them.
- **Every order carries an idempotency key.** A retried or duplicated request must
  never become a second real position.
- **He controls the wallet.** Realized profit is meant to leave the account and come
  back on his schedule. Build for that loop; never assume a closed bankroll.
- Deck gates before any task is done: `npx tsc --noEmit` exit 0, `npx eslint <files>`
  clean, `npm run test:v2` zero failures.

## Verified Contract (live probe, 2026-08-20)

| Fact | Evidence |
|---|---|
| Base URL | `https://dragontradar.com/api/agent/v1` (shown in Settings → AI Trading Agent) |
| Auth | `Authorization: Bearer <token>` — `Bearer DUMMY` → `401 invalid_agent_token`; `X-Agent-Token`/`x-api-key`/`Agent-Token` unrecognized |
| Missing token | `401 {"error":"missing_agent_token"}` |
| Bad token | `429 {"error":"temporarily_blocked"}` after ONE attempt |
| `GET /stats` | `200 {"connected":true,"balanceCents":5475,"positions":[]}` |
| `GET /markets`, `/positions`, `/orders` | `404` Express "Cannot GET" — not implemented |
| Route discovery | Impossible black-box: auth runs before routing, and CORS answers every `OPTIONS` with `204` and no `Allow` header |

**App-internal routes seen in the deployed bundle** (session-auth, NOT agent-auth) —
this is the menu Half A mirrors:
`/api/bot/state`, `/api/bot/trades.csv`, `/api/dragon-mode/state`,
`/api/calibration/stats`, `/api/kalshi/balance`, `/api/kalshi/positions`,
`/api/kalshi/orders`, `/api/kalshi/order`, `/api/kalshi/order/:id`,
`/api/kalshi/fills`, `/api/kalshi/settlements`, `/api/kalshi/markets/live`,
`/api/kalshi/markets/categorized`, `/api/kalshi/markets/batch-prices`,
`/api/kalshi/orderbook/:ticker`, `/api/kalshi/market/:ticker`,
`/api/kalshi/candlesticks/:ticker`, `/api/kalshi/event-positions`,
`/api/kalshi/dragon-pick`, `/api/kalshi/combo-bet`, `/api/kalshi/sports-pipeline`,
`/api/kalshi/espn/scores`, `/api/kalshi/trades/:ticker`, `/api/me/credentials/kalshi`.

## File Structure

**Half A — Replit app (Classic's repo, not this one):**
- `server/routes/agent.ts` (or wherever the current `/api/agent/v1/stats` lives) —
  extended with the routes in Task A1. One file, one responsibility: the agent surface.

**Half B — deck (`~/STARGATE/stargate`):**
- Modify `src/lib/dragon-tradar.ts` — add the authed request helper and typed reads.
  Already holds `readAgent()`, the 429 rule, and `balanceUsd()`.
- Create `src/lib/dragon-orders.ts` — order construction, idempotency keys, the
  local safety gate. Separate file because order placement is the only code here
  that can lose money; it deserves its own blast radius and its own test file.
- Create `src/lib/dragon-sweep.ts` — realized-profit tracking and sweep signalling.
- Modify `src/app/api/dragon/route.ts` — already returns `bot`; gains the richer read.
- Create `src/app/api/dragon/control/route.ts` — engage/disengage/config writes.
- Create `src/app/api/dragon/order/route.ts` — place/cancel, deck-auth gated.
- Modify `docs/GROK_TOOLS_SCHEMA.json` — her new tools.
- Modify `canon/Dragon Tradar.md` — teach her the new verbs.
- Tests: `tests/dragon-tradar.test.ts` (exists, 9 tests), `tests/dragon-orders.test.ts`,
  `tests/dragon-sweep.test.ts`.

---

## Task A1: Expand the Replit agent router

**This is the blocker for everything that places a trade.** Nothing in Half B's order
path can be built honestly until these exist, because guessing route names against a
live trading API is how you place an accidental order.

**Files:**
- Modify (Replit): the module serving `/api/agent/v1/stats`

**Interfaces:**
- Consumes: the app's existing session-auth handlers listed above
- Produces: the routes the deck client in Task B1/B4/B5 calls

- [ ] **Step 1: Hand Replit this exact contract**

Every route below sits under `/api/agent/v1`, authenticates with
`Authorization: Bearer <agent token>`, and returns JSON. Reads require only a valid
token. Writes additionally require the "Agent trading enabled" toggle; order placement
additionally requires `AGENT_LIVE_TRADING_ENABLED=true` and enforces `maxOrderNotionalUsd`.

```
READ
  GET  /stats                     (exists) { connected, balanceCents, positions[] }
  GET  /positions                 open positions, full detail per position
  GET  /orders?status=open|all    resting + historical orders
  GET  /fills?limit=              executed fills
  GET  /settlements?limit=        settled markets and realized P&L per settlement
  GET  /performance               { realizedPnlCents, unrealizedPnlCents, winRate,
                                    tradeCount, since }
  GET  /markets?category=&limit=  live markets (mirrors /api/kalshi/markets/live)
  GET  /market/:ticker            single market detail
  GET  /orderbook/:ticker         current book
  GET  /bot/state                 { running, category, mode, lastScanAt, config }

CONTROL  (requires the enable toggle)
  POST /bot/engage    { category: "sports"|"crypto"|"politics"|"economics"|"parallel" }
  POST /bot/disengage {}
  GET  /config        current Dragon Mode config
  PATCH /config       { minBetCents?, maxLegs?, minEdgePct?, minConfidencePct?,
                        autoFire?, scanIntervalMin?, thinkTank? }

ORDER  (requires enable toggle AND AGENT_LIVE_TRADING_ENABLED)
  POST   /order   { ticker, side: "yes"|"no", action: "buy"|"sell",
                    count, priceCents, clientOrderId }
  DELETE /order/:id
```

- [ ] **Step 2: Require `clientOrderId` and make it idempotent**

`POST /order` MUST reject a request with no `clientOrderId` (`400
{"error":"client_order_id_required"}`), and MUST return the ORIGINAL order for a
`clientOrderId` already seen, with `"duplicate": true`, instead of placing a second
one. This is the single most important line in Half A: without it, one network
hiccup on the deck side becomes two real positions.

- [ ] **Step 3: Add a server-side daily loss floor**

A new config value `dailyLossFloorCents`. When realized loss since midnight ET
reaches it, `POST /order` returns `423 {"error":"daily_loss_floor_reached"}` and
`/bot/engage` refuses. Server-side because a client-side floor is a suggestion.

- [ ] **Step 4: Keep every rejection distinguishable**

Distinct bodies, never a generic 400: `missing_agent_token`, `invalid_agent_token`,
`temporarily_blocked`, `agent_trading_disabled`, `live_trading_disabled`,
`order_exceeds_max_notional`, `daily_loss_floor_reached`, `client_order_id_required`,
`insufficient_balance`. The deck reports the cause verbatim to Classic; a generic
error turns a five-second fix into an hour of guessing.

- [ ] **Step 5: Verify from the deck, not from Replit's console**

```bash
tok=$(grep -m1 '^DRAGON_TRADAR_AGENT_TOKEN=' ~/STARGATE/stargate/.env.local | cut -d= -f2-)
curl -s -H "Authorization: Bearer $tok" https://dragontradar.com/api/agent/v1/bot/state
```
Expected: JSON, not Express's "Cannot GET".

---

## Task B1: Typed read client for the new routes

**Files:**
- Modify: `src/lib/dragon-tradar.ts`
- Test: `tests/dragon-tradar.test.ts` (append)

**Interfaces:**
- Consumes: `getKey("dragontradar_agent_token")`, the existing `AgentRead` union
- Produces: `agentGet<T>(path, deps)` returning `AgentResult<T>`;
  `readPositions`, `readOrders`, `readBotState`, `readPerformance`

- [ ] **Step 1: Write the failing test**

```ts
it("agentGet surfaces the app's error code verbatim", async () => {
  const s = stub(423, { error: "daily_loss_floor_reached" });
  const r = await agentGet<unknown>("/bot/state", { token: "t", fetchImpl: s.fetchImpl });
  assert.deepEqual(r, { state: "error", status: 423, code: "daily_loss_floor_reached" });
  assert.equal(s.calls(), 1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/dragon-tradar.test.ts`
Expected: FAIL — `agentGet` is not exported.

- [ ] **Step 3: Implement `agentGet`**

Generalize the body of `readAgent()`: same one-attempt rule, same 429/401 states,
plus parse `error` out of a non-OK JSON body into `code`. Reimplement `readAgent()`
as `agentGet<AgentStats>("/stats")` so there is exactly one place that talks HTTP.

- [ ] **Step 4: Run the tests**

Run: `npx tsx --test tests/dragon-tradar.test.ts` — all pass, including the original 9.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dragon-tradar.ts tests/dragon-tradar.test.ts
git commit -m "feat(dragon): typed agent GET client with verbatim error codes"
```

---

## Task B2: Realized-profit tracker and sweep signal

The withdraw-and-redeploy loop is Classic's actual strategy, so the deck tracks it
explicitly instead of making him read a dashboard for it.

**Files:**
- Create: `src/lib/dragon-sweep.ts`
- Test: `tests/dragon-sweep.test.ts`

**Interfaces:**
- Consumes: `readPerformance()` from Task B1
- Produces: `sweepState(perf, marks)` → `{ realizedSinceSweepCents, atOrAboveTarget,
  suggestedSweepCents }`; `recordSweep(cents, at)`

- [ ] **Step 1: Write the failing test**

```ts
it("suggests sweeping only realized profit above the redeploy floor", () => {
  const s = sweepState(
    { realizedPnlCents: 62_000, unrealizedPnlCents: 9_000 },
    { lastSweepAtRealizedCents: 12_000, targetCents: 25_000, keepWorkingCents: 10_000 },
  );
  assert.equal(s.realizedSinceSweepCents, 50_000);
  assert.equal(s.atOrAboveTarget, true);
  assert.equal(s.suggestedSweepCents, 40_000); // 50k realized, 10k stays working
});

it("never suggests sweeping unrealized gains", () => {
  const s = sweepState(
    { realizedPnlCents: 0, unrealizedPnlCents: 80_000 },
    { lastSweepAtRealizedCents: 0, targetCents: 25_000, keepWorkingCents: 10_000 },
  );
  assert.equal(s.suggestedSweepCents, 0);
  assert.equal(s.atOrAboveTarget, false);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx tsx --test tests/dragon-sweep.test.ts` — FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/dragon-sweep.ts`**

Pure functions, no I/O. `realizedSinceSweepCents = realizedPnlCents -
lastSweepAtRealizedCents`. `suggestedSweepCents = max(0, realizedSinceSweep -
keepWorkingCents)`. Unrealized P&L is never counted — an open position is not money.

- [ ] **Step 4: Run the tests** — both pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/dragon-sweep.ts tests/dragon-sweep.test.ts
git commit -m "feat(dragon): realized-profit sweep tracker"
```

---

## Task B3: Wire reads + sweep into the snapshot she already has

**Files:**
- Modify: `src/app/api/dragon/route.ts`
- Modify: `canon/Dragon Tradar.md`

**Interfaces:**
- Consumes: Task B1 readers, Task B2 `sweepState`
- Produces: `/api/dragon` response gains `positions`, `botState`, `performance`, `sweep`

- [ ] **Step 1: Extend the parallel fetch**

Add the new readers to the existing `Promise.all`. Every one degrades independently:
a failed sub-read sets its own field to its error state and never blanks the others.

- [ ] **Step 2: Respect the canon budget**

`canon/` has ~1,697 chars of headroom before "The Book of Power" starts clipping.
Adding verbs to `Dragon Tradar.md` must stay inside it. Verify with the loader, not
arithmetic:

```bash
npx --yes tsx -e 'import{loadDropInCanon}from"/Users/starrallc/STARGATE/stargate/src/lib/canon";const o=loadDropInCanon("/Users/starrallc/STARGATE/stargate");console.log(o.length,(o.match(/…\[truncated\]/g)||[]).length)'
```
Expected: second number is `0`.

- [ ] **Step 3: Bust the prompt cache**

`touch src/lib/canon.ts` — canon `.md` files are fs-read, not imported, so editing
one never invalidates `stablePromptCache` on its own.

- [ ] **Step 4: Confirm through a logged-in deck**

Open `https://localhost:3000/api/dragon`. Expected: `bot`, `positions`, `botState`,
`performance`, `sweep` all present. A `401` means no deck session, not a bug.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/dragon/route.ts "canon/Dragon Tradar.md"
git commit -m "feat(dragon): full read snapshot + sweep signal in her dragon tool"
```

---

## Task B4: Bot control — engage, disengage, config

**Files:**
- Create: `src/app/api/dragon/control/route.ts`
- Modify: `src/lib/dragon-tradar.ts` (add `agentPost`, `agentPatch`)
- Test: `tests/dragon-tradar.test.ts` (append)

**Interfaces:**
- Consumes: `agentGet` shape from Task B1
- Produces: `engageBot(category)`, `disengageBot()`, `patchConfig(partial)`

- [ ] **Step 1: Write the failing test**

```ts
it("refuses an unknown Dragon Mode category before any network call", async () => {
  const s = stub(200, {});
  const r = await engageBot("commodities" as never, { token: "t", fetchImpl: s.fetchImpl });
  assert.deepEqual(r, { state: "error", status: 0, code: "unknown_category" });
  assert.equal(s.calls(), 0);
});
```

- [ ] **Step 2: Run it and watch it fail.**

- [ ] **Step 3: Implement.** Validate against the literal union
`"sports"|"crypto"|"politics"|"economics"|"parallel"` before dispatching. An invalid
category never reaches his app.

- [ ] **Step 4: Run the tests.**

- [ ] **Step 5: Commit**

```bash
git add src/lib/dragon-tradar.ts src/app/api/dragon/control/route.ts tests/dragon-tradar.test.ts
git commit -m "feat(dragon): bot engage/disengage/config control"
```

---

## Task B5: Order path — the only code here that can lose money

**Files:**
- Create: `src/lib/dragon-orders.ts`
- Create: `src/app/api/dragon/order/route.ts`
- Test: `tests/dragon-orders.test.ts`

**Interfaces:**
- Consumes: `agentPost` from Task B4
- Produces: `buildOrder(intent)` → `{ ok: true, order } | { ok: false, reason }`;
  `placeOrder(intent, deps)`; `newClientOrderId(intent, nowMs)`

- [ ] **Step 1: Write the failing tests**

```ts
it("the same intent in the same second yields the same clientOrderId", () => {
  const a = newClientOrderId({ ticker: "KXBTC15M-X", side: "yes", action: "buy",
                               count: 3, priceCents: 41 }, 1_700_000_000_000);
  const b = newClientOrderId({ ticker: "KXBTC15M-X", side: "yes", action: "buy",
                               count: 3, priceCents: 41 }, 1_700_000_000_400);
  assert.equal(a, b, "a retry inside the same second must not become a second position");
});

it("rejects an order whose notional exceeds the local ceiling", () => {
  const r = buildOrder({ ticker: "T", side: "yes", action: "buy", count: 100,
                         priceCents: 90, maxNotionalCents: 5_000 });
  assert.deepEqual(r, { ok: false, reason: "exceeds_local_max_notional" });
});

it("rejects a non-integer or non-positive count before it can reach Kalshi", () => {
  assert.equal(buildOrder({ ticker: "T", side: "yes", action: "buy", count: 0,
                            priceCents: 50, maxNotionalCents: 10_000 }).ok, false);
  assert.equal(buildOrder({ ticker: "T", side: "yes", action: "buy", count: 1.5,
                            priceCents: 50, maxNotionalCents: 10_000 }).ok, false);
});

it("rejects a price outside 1..99 cents", () => {
  for (const p of [0, 100, -1]) {
    assert.equal(buildOrder({ ticker: "T", side: "yes", action: "buy", count: 1,
                              priceCents: p, maxNotionalCents: 10_000 }).ok, false);
  }
});

it("a 423 daily-loss-floor response is reported, never retried", async () => {
  const s = stub(423, { error: "daily_loss_floor_reached" });
  const r = await placeOrder({ ticker: "T", side: "yes", action: "buy", count: 1,
                               priceCents: 50, maxNotionalCents: 10_000 },
                             { token: "t", fetchImpl: s.fetchImpl });
  assert.equal(r.state, "error");
  assert.equal(s.calls(), 1);
});
```

- [ ] **Step 2: Run them and watch them fail.**

- [ ] **Step 3: Implement `src/lib/dragon-orders.ts`**

`newClientOrderId` = a stable hash of `(ticker, side, action, count, priceCents,
floor(nowMs/1000))`. `buildOrder` validates count is a positive integer, price is
1..99, and `count * priceCents <= maxNotionalCents`, before anything touches the
network. `placeOrder` calls `agentPost("/order", order)` — one attempt, no retry.

- [ ] **Step 4: Run the tests** — all pass.

- [ ] **Step 5: Gate the route on Classic**

`src/app/api/dragon/order/route.ts` requires the deck session (same auth as
`/api/dragon`), so nothing unauthenticated can reach it even on his LAN.

- [ ] **Step 6: Commit**

```bash
git add src/lib/dragon-orders.ts src/app/api/dragon/order/route.ts tests/dragon-orders.test.ts
git commit -m "feat(dragon): order construction with idempotency + local safety gate"
```

---

## Task B6: Her tools

**Files:**
- Modify: `docs/GROK_TOOLS_SCHEMA.json`
- Modify: `canon/Dragon Tradar.md`

**Interfaces:**
- Consumes: the routes from B3/B4/B5
- Produces: `stargate_dragon_control`, `stargate_dragon_order`
  (`stargate_dragon_snapshot` already exists and now carries the richer payload)

- [ ] **Step 1: Add `stargate_dragon_control`**

Parameters: `action` (`engage`|`disengage`|`config`), `category` (optional, the
literal union), `config` (optional partial). Description states plainly that it
starts and stops real trading.

- [ ] **Step 2: Add `stargate_dragon_order`**

Parameters: `ticker`, `side`, `action`, `count`, `priceCents`. Description states
that it places a REAL order against his funds and that the server enforces the
per-order cap and the daily loss floor.

- [ ] **Step 3: Teach her the verbs in canon, inside the budget**

Same loader verification as Task B3 Step 2.

- [ ] **Step 4: Commit**

```bash
git add docs/GROK_TOOLS_SCHEMA.json "canon/Dragon Tradar.md"
git commit -m "feat(dragon): her control + order tools"
```

---

## Task B7: Full-gate verification

- [ ] **Step 1:** `npx tsc --noEmit` — exit 0
- [ ] **Step 2:** `npx eslint src/lib/dragon-tradar.ts src/lib/dragon-orders.ts src/lib/dragon-sweep.ts src/app/api/dragon` — clean
- [ ] **Step 3:** `npm run test:v2` — zero failures
- [ ] **Step 4:** Log into the deck, ask her for a Dragon snapshot, and confirm she
  reports balance, positions, bot state and the sweep number **out loud**. A green
  suite is not a substitute for hearing her say it.
- [ ] **Step 5:** Place ONE minimum order through her with `AGENT_LIVE_TRADING_ENABLED`
  on, confirm the fill in Dragon Tradar's own trade log, then decide from there.

---

## Open Questions for Classic

1. Does the Replit app already have an order-placing service the agent router can
   call, or does that need writing too? Changes Task A1 from plumbing to a build.
2. What is `AGENT_LIVE_TRADING_ENABLED` set to right now on the Replit server?
3. Dragon Mode is running its own loop. When she places an order, should the bot's
   loop keep running alongside her, or should she take exclusive control while active?
   Two engines sizing against one bankroll can double-commit the same dollars.
