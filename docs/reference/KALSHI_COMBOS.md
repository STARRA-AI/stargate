# Kalshi Combos (Multivariate Event Contracts) — the verified contract

Every fact here was probed live against `api.elections.kalshi.com` or read from
`docs.kalshi.com` on **2026-09-04**. Nothing is from memory. Re-verify before trusting
anything older than a week — Kalshi is migrating endpoints right now (see §6).

---

## 1. What a combo actually is

A combo ("multivariate event contract", MVE) is a **single binary market** whose YES pays
only if **every** selected leg resolves YES.

> "The resulting market will only resolve to YES if every associated market resolves to
> YES. Scalar outcomes are multiplied (rounded down)."
> — `functional_description`, `GET /multivariate_event_collections`

It is **not** N separate orders. It is **one order on one ticker** that Kalshi mints for
your specific combination of legs.

### The five combo collections (live 2026-09-04)

| series_ticker | exchange_index | size_min | size_max | is_all_yes |
|---|---|---|---|---|
| `KXMVESPORTSMULTIGAMEEXTENDED` | 1 | 2 | 0 (unlimited) | false |
| `KXMVECROSSCATEGORY-SHARD1` | 1 | 2 | 0 | false |
| `KXMVECROSSCATEGORY` | 1 | 2 | 0 | false |
| `KXMVENFLSINGLEGAME` | 1 | 2 | 0 | false |
| `KXMVENBASINGLEGAME` | 1 | 2 | 0 | false |

`is_all_yes: false` means legs may be **NO** as well as YES. `size_min: 2` is the floor —
a one-leg "combo" is just a normal market.

### Anatomy of a real combo market

```
ticker:        KXMVECROSSCATEGORY-SHARD1-S2026BC790E788B8-E397C9502CB
event_ticker:  KXMVECROSSCATEGORY-SHARD1-S2026BC790E788B8
market_type:   binary
exchange_index: 1
custom_strike: {
  "Associated Events":       "KXLALIGABTTS-26SEP04RBBRMA,KXLALIGAGAME-26SEP04RBBRMA,KXMLBTOTAL-26SEP041410DETCLEG1",
  "Associated Market Sides": "no,yes,yes",
  "Associated Markets":      "KXLALIGABTTS-26SEP04RBBRMA-BTTS,KXLALIGAGAME-26SEP04RBBRMA-RMA,KXMLBTOTAL-26SEP041410DETCLEG1-13"
}
yes_sub_title: "no Both Teams To Score,yes Real Madrid,yes Over 12.5 runs scored"
```

★ **The ticker suffixes are content hashes, minted server-side.** `S2026BC790E788B8` and
`E397C9502CB` are not derivable from the legs. **You cannot construct a combo ticker.**
You must POST the legs and read the ticker back out of the response. Any code that builds a
combo ticker by string concatenation is broken by construction.

---

## 2. The one call that everything hinges on

> "This endpoint must be hit **at least once before trading or looking up a market**.
> Users are limited to 5000 creations per week."
> — Kalshi docs, *Create Market In Multivariate Event Collection*

```
POST /trade-api/v2/multivariate_event_collections/{collection_ticker}
```

**Note the path.** There is no `/create_market` and no `/lookup` segment — the create IS a
POST to the collection ticker itself. (Probed: `POST .../{ticker}/create_market` → 404.)

Request:

```json
{
  "selected_markets": [
    {"event_ticker": "KXNFLGAME-26SEP09NESEA", "market_ticker": "KXNFLGAME-26SEP09NESEA-SEA", "side": "yes"},
    {"event_ticker": "KXMLBGAME-26SEP041905BOSBAL", "market_ticker": "KXMLBGAME-26SEP041905BOSBAL-BOS", "side": "no"}
  ],
  "with_market_payload": true
}
```

`TickerPair` requires all three of `market_ticker`, `event_ticker`, `side`; `side` is the
string `"yes"` or `"no"` (lowercase).

Response:

```json
{ "event_ticker": "...", "market_ticker": "...", "market": { ... } }
```

**`market_ticker` from this response is the only thing you may trade.**

---

## 3. Placing the order

Kalshi is mid-migration. Use **V2**:

```
POST /trade-api/v2/portfolio/events/orders
```

> "The legacy `/portfolio/orders` endpoint will be deprecated no earlier than May 6, 2026 —
> clients should migrate to this path." — Kalshi docs, *Create Order (V2)*

Required: `ticker`, `side`, `count`, `price`, `time_in_force`, `self_trade_prevention_type`.

```json
{
  "ticker": "<market_ticker from the create call>",
  "client_order_id": "8c35ecb3-328f-4f52-8c7c-0f4b9862f8d1",
  "side": "bid",
  "count": "10.00",
  "price": "0.5600",
  "time_in_force": "good_till_canceled",
  "self_trade_prevention_type": "taker_at_cross",
  "exchange_index": 1
}
```

★ **Four ways the V2 shape differs from legacy — each one is a silent failure:**

| | legacy | V2 |
|---|---|---|
| field name | `ticker` | `ticker` (same) |
| side | `yes` / `no` | **`bid` / `ask`** |
| count | integer `10` | **string `"10.00"`** (fixed point, 0–2 dp) |
| price | cents integer `56` | **string `"0.5600"`** (fixed-point dollars) |

`BookSide` semantics: *"For event markets, this refers to the YES leg only: `bid` means buy
YES, `ask` means sell YES. Selling YES is economically equivalent to buying NO at `1 - price`,
but this endpoint quotes everything from the YES side."*

### exchange_index — the shard

```
0 = Default    1 = Combos    2 = Crypto    3 = Tennis & Baseball
```
(`GET /exchange/status` → `exchange_index_statuses`)

> "Exchange shard index. If omitted, auto-routes when ticker is provided; otherwise defaults
> to 0. Use -1 to require auto-routing by ticker."

**Omit it, or send `1` for combos. Sending a hardcoded `0` with a combo ticker is a bug.**

---

## 4. Auth — RSA-PSS, and the two things everyone gets wrong

Headers on every request:

- `KALSHI-ACCESS-KEY` — the Key ID
- `KALSHI-ACCESS-TIMESTAMP` — current time in **milliseconds**, as a string
- `KALSHI-ACCESS-SIGNATURE` — base64 of the signed message

Message = `timestamp_ms + HTTP_METHOD + path`, concatenated with no separators.

```python
sig = private_key.sign(
    msg.encode(),
    padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH),   # ← NOT MAX_LENGTH
    hashes.SHA256())
```

★ **Landmine 1 — salt length.** Kalshi specifies `PSS.DIGEST_LENGTH`. Most sample code and
most libraries default to `MAX_LENGTH`, which produces a valid-looking signature that Kalshi
rejects with 401.

★ **Landmine 2 — strip the query string before signing.**
> "if your request is to `/trade-api/v2/portfolio/orders?limit=5`, sign only
> `/trade-api/v2/portfolio/orders`"

Sign the full path including `/trade-api/v2`, not just the route.

Base URLs (all four work): `external-api.kalshi.com`, `api.elections.kalshi.com` (prod);
`external-api.demo.kalshi.co`, `demo-api.kalshi.co` (demo).

---

## 4.5 ★★★ THE ACTUAL BLOCKER — COLLATERAL LIVES PER SHARD

> "Kalshi's collateralization checks will continue to run within the matching engine.
> **Programmatic traders must preallocate collateral on a given exchange shard before order
> placement.**" — Kalshi, *Exchange Sharding*

Balance is held **per exchange shard**. `GET /portfolio/balance` returns a breakdown.
Classic's account, read live 2026-09-04 through his own app:

```json
{"balance":1960,"balance_breakdown":[
  {"balance":"19.6062","exchange_index":0},   <- Default
  {"balance":"0.0000", "exchange_index":1},   <- COMBOS      ★ ZERO
  {"balance":"0.0036", "exchange_index":2},   <- Crypto
  {"balance":"0.0000", "exchange_index":3}]}  <- Tennis & Baseball
```

**A combo order cannot be collateralized with $0 on shard 1. It cannot fill. Nothing appears
in the wallet.** No amount of fixing the request shape changes this.

Kalshi's own migration timeline explains when this started:
- **2026-08-06** — intra-exchange transfers to index 1 enabled
- **2026-08-17** — combos over `KXMVESPORTSMULTIGAMEEXTENDED-R` and `KXMVECROSSCATEGORY-R`
  **moved to shard 1**
- **2026-08-24** — new crypto events -> shard 2; new tennis/baseball -> shard 3
- **2026-09-10** — new commodities -> shard 2; new basketball -> shard 3

### The fix — three ways, best last

1. **Kalshi UI**: <https://kalshi.com/account/exchange-indexes>
2. **One-off API**: `POST /trade-api/v2/portfolio/intra_account_transfer`
3. ★ **Auto-rebalance (set once, never think about it again)**

```
POST /trade-api/v2/portfolio/target_balance_allocation
{"allocations":[{"exchange_index":0,"percent":70},
                {"exchange_index":1,"percent":30}]}
```

The field is **`percent`**, not `percentage`. Percents must total 100. An empty array
disables rebalancing. Kalshi recomputes every 10 seconds (balance minus resting orders) and
transfers on your behalf to restore the target.

★ As sports migrates to shard 3 and crypto to shard 2, any bot trading those categories needs
an allocation on those shards too, or it hits exactly this same wall.

---

## 5. ★★★ MEASURED: the combo order book is empty

Sampled every open combo market, 2026-09-04:

| series | open markets | have an ask | ever traded | open interest |
|---|---|---|---|---|
| `KXMVECROSSCATEGORY-SHARD1` | 200 | 26 | **0** | 0 |
| `KXMVESPORTSMULTIGAMEEXTENDED` | 37 | 2 | **1** | 1 |
| `KXMVECROSSCATEGORY` | 24 | 0 | **0** | 0 |
| `KXMVENFLSINGLEGAME` | 0 | — | — | — |
| `KXMVENBASINGLEGAME` | 0 | — | — | — |
| **total** | **261** | **28 (11%)** | **1** | **1** |

The same measurement on ordinary single markets:

| series | open markets | have an ask | traded | total volume |
|---|---|---|---|---|
| `KXNFLGAME` | 64 | 64 (100%) | 64 | 3,070,194 |
| `KXMLBGAME` | 106 | 106 (100%) | 92 | 5,277,902 |
| `KXNCAAFGAME` | 200 | 200 (100%) | 166 | 329,192 |

**Singles: 100% quoted, 8.6M contracts traded. Combos: 11% quoted, one trade in the entire
product.**

### What this means operationally

A combo you create arrives with **no counterparty**. A resting bid on it will sit unfilled
indefinitely. The order was accepted; nothing filled; **no position appears** — which is
exactly the symptom of "it made a combo but it never shows in my wallet."

**Rule: only send a combo order when `yes_ask_dollars > 0`, and price it to take that ask.
Never post a bid into an empty combo book and treat acceptance as a fill.**

Unverified from outside: whether a **freshly created** combo gets an immediate quote from
Kalshi's own maker. That needs one authenticated create + an orderbook read. Creation is free
and capped at 5000/week, so it is a cheap, definitive test — do it before building on combos.

---

## 6. The correct sequence, end to end

```
1. GET  /multivariate_event_collections            → pick a collection_ticker
2. GET  /multivariate_event_collections/{ct}       → read associated_events, size_min
3. GET  /markets?series_ticker=<leg series>        → resolve each leg's real market_ticker
4. POST /multivariate_event_collections/{ct}       → {selected_markets:[...]}
                                                   → READ BACK market_ticker  ★ never construct it
5. GET  /markets?ticker=<market_ticker>            → CHECK yes_ask_dollars > 0
   └─ if 0: STOP. There is no counterparty. Do not send the order.
6. POST /portfolio/events/orders                   → V2 shape, side=bid, string price/count,
                                                     exchange_index 1 (or omitted)
7. GET  /portfolio/positions                       → CONFIRM the position exists
   └─ acceptance at step 6 is NOT a fill. Only step 7 proves it.
```

Step 5 and step 7 are the two that Dragon Tradar appears to be missing.

---

## 7. Where the deck's own code stands

- `src/lib/dragon-orders.ts` speaks the **Dragon Tradar** contract (`/api/agent/v1/order`),
  not Kalshi's directly. Kalshi shape lives on the Replit side — that is where the V2 vs
  legacy shape and the `exchange_index` must be fixed.
- Ceiling knobs, if a cap is ever wanted: `DRAGON_MAX_ORDER_NOTIONAL_CENTS` (deck, default
  10_000¢) and `maxOrderNotionalUsd` (his app, currently $100). A caller may only tighten,
  never loosen, the deck ceiling.
- Dragon Tradar live state 2026-09-04: `mode: "paper"`, `running: false`, `autoFire: false`,
  balance $0, `category: "sports"`, `minBetCents: 1000`.

## 8. Sources

- `https://docs.kalshi.com/llms.txt` — the full documentation index
- `https://docs.kalshi.com/api-reference/multivariate/create-market-in-multivariate-event-collection.md`
- `https://docs.kalshi.com/api-reference/orders/create-order-v2.md`
- `https://docs.kalshi.com/getting_started/api_keys.md`
- Live probes: `/exchange/status`, `/multivariate_event_collections`, `/events/multivariate`,
  `/markets` — `api.elections.kalshi.com/trade-api/v2`, 2026-09-04
