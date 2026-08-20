# Task A1 — the Dragon Tradar agent router (for the Replit app)

This is the blocker. The deck side is finished and tested; every control and
order route it calls returns 404 until this exists on `dragontradar.com`.

`agent-router.ts` in this folder is the whole router, written against the
contract that was probed live on 2026-08-20. It is **not** deck code — it is
excluded from the deck's tsconfig (`docs/handoff`) and nothing in the app
imports it.

## What is verified and what is not

Verified live: the base path `/api/agent/v1`, `Authorization: Bearer <token>`,
`GET /stats` → `{connected, balanceCents, positions[]}`, and the 429
`temporarily_blocked` lockout after a single bad token.

Not verified: the inside of the Replit app. This file has never seen that
source, so it does not guess at service names. Everything it needs is declared
in the `AgentServices` interface at the top; wiring those functions to the
handlers already serving `/api/kalshi/*` and `/api/bot/*` is the one step that
has to happen over there.

## The rule that matters most

**401 and 403 mean the token, and nothing else.** The deck maps them to "the
token was rejected — go regenerate it." A business refusal answered with a 403
sends Classic off to rotate a healthy token while the real cause stays hidden.

| Status | Codes |
|---|---|
| 401 | `missing_agent_token`, `invalid_agent_token` |
| 429 | `temporarily_blocked` |
| 409 | `agent_trading_disabled`, `live_trading_disabled` |
| 422 | `order_exceeds_max_notional`, `insufficient_balance` |
| 423 | `daily_loss_floor_reached` |
| 400 | `client_order_id_required`, `invalid_order`, `unknown_category`, `unknown_config_key`, `empty_config` |

Every error body is `{"error": "<code>"}`. The deck reads `.error` verbatim and
shows it to him, so a generic 400 turns a five-second fix into an hour of
guessing.

## Wiring, in order

1. Mount the router behind the **same** Bearer middleware that already guards
   `/api/agent/v1/stats`. That middleware keeps owning 401 and the 429 lockout —
   the router deliberately does not re-implement auth, so the lockout can't
   drift between routes.
2. Implement `AgentServices` against the existing handlers.
3. Add `dailyLossFloorCents` to the bot config (0 = off) and implement
   `realizedTodayCents()` — realized P&L since midnight ET, signed, a loss
   negative. Unrealized drawdown is not a loss until it settles.
4. Leave `AGENT_LIVE_TRADING_ENABLED` alone. `liveTradingEnabled()` is read per
   request, never cached, so flipping it takes effect immediately.

## The one thing to fix if the app has a database

The idempotency store is an in-memory `Map`. A Replit restart forgets every
`clientOrderId`, which reopens the double-fill window for as long as it takes a
retry to cross that restart. If there is a database, move it to a table with a
unique index on `clientOrderId`. That is the version that actually cannot
double-fill; the Map is the version that usually doesn't.

## Verify from the deck, not from Replit's console

Run this in Terminal after deploying. It should print JSON, not Express's
"Cannot GET".

```
cd ~/STARGATE/stargate && curl -s -H "Authorization: Bearer $(grep -m1 '^DRAGON_TRADAR_AGENT_TOKEN=' .env.local | cut -d= -f2-)" https://dragontradar.com/api/agent/v1/bot/state
```

## Paste-ready brief for the Replit agent

Everything below the line can be pasted into Replit as one message, with
`agent-router.ts` attached.

---

Add an agent API router to this app at `/api/agent/v1`, mounted behind the same
Bearer-token middleware that already guards `/api/agent/v1/stats`. I am
attaching `agent-router.ts` — use it as written and do not rename its routes or
change its status codes; a client already calls them exactly as they are.

Your job is the wiring:

1. Implement the `AgentServices` interface at the top of the file against the
   handlers already serving `/api/kalshi/balance`, `/api/kalshi/positions`,
   `/api/kalshi/orders`, `/api/kalshi/order`, `/api/kalshi/fills`,
   `/api/kalshi/settlements`, `/api/kalshi/markets/live`, `/api/bot/state`, and
   the Dragon Mode config. Reuse the existing services — do not write a second
   Kalshi client.
2. Add `dailyLossFloorCents` to the bot config, defaulting to 0 (off), editable
   from the same place as the rest of the Dragon Mode config.
3. Implement `realizedTodayCents()`: realized P&L in cents since midnight
   America/New_York, signed, with a loss negative. Realized only — unrealized
   drawdown must not count.
4. `liveTradingEnabled()` is `process.env.AGENT_LIVE_TRADING_ENABLED === "true"`,
   read per request so flipping the env var takes effect without a redeploy.
5. Do not change the existing Bearer middleware, the "Agent trading enabled"
   toggle, or the `maxOrderNotionalUsd` cap. The router reads all three; it must
   never be able to bypass any of them.

Hard requirements, in priority order:

- `POST /order` must reject a request with no `clientOrderId`
  (`400 {"error":"client_order_id_required"}`), and must return the ORIGINAL
  order with `"duplicate": true` for a `clientOrderId` it has already seen,
  instead of placing a second one. If this app has a database, store those ids
  in a table with a unique index rather than the in-memory Map in the file, and
  say so in your reply.
- Never answer a business refusal with 401 or 403. Those two mean the token and
  only the token. Use the status codes exactly as the file has them.
- Every error response is JSON shaped `{"error": "<code>"}`, with the distinct
  codes listed in the file. No generic 400s.
- `POST /bot/disengage` must work even when the "Agent trading enabled" toggle
  is off. Stopping is always allowed.

When you are done, reply with: the file path the router lives at, the code you
wrote for `realizedTodayCents()`, and whether the idempotency store ended up in
memory or in the database.
