# Dragon Tradar — combo execution is silently failing. Fix the whole path.

## The symptom
Dragon Tradar builds "combos" and reports them as placed. Nothing ever appears in the
Kalshi wallet. No position, no fill, no error surfaced to the user.

## The diagnosis
This is not one bug. It is six stacked failures, and the top layer is that the app
treats **order acceptance as a fill**. Kalshi accepts an order it can never fill, returns
200, and Dragon Tradar prints success. Every other defect below hides behind that one.

Fix all of it in one pass. Do not stop at the first thing that looks like the cause.

---

## STEP 0 — RE-VERIFY BEFORE YOU WRITE CODE (mandatory)

Every fact in this prompt was probed live against `api.elections.kalshi.com` and read from
`docs.kalshi.com` on **2026-09-04**. Kalshi is mid-migration on both endpoints and exchange
shards. Two migration dates have passed since: 2026-09-10 moved new commodities to shard 2
and new basketball to shard 3.

Before implementing, re-read and quote back what you actually find:

- `https://docs.kalshi.com/llms.txt` (the doc index)
- `https://docs.kalshi.com/api-reference/multivariate/create-market-in-multivariate-event-collection.md`
- `https://docs.kalshi.com/api-reference/orders/create-order-v2.md`
- `GET /trade-api/v2/exchange/status` → current `exchange_index_statuses`
- `GET /trade-api/v2/multivariate_event_collections` → current collections and their `exchange_index`

If anything below has changed, implement what the live docs say and note the delta in your
final report. Do not implement a stale fact because this prompt asserted it.

---

## FIX 1 — Stop constructing combo tickers. They are server-minted content hashes.

A combo is **one binary market** whose YES pays only if every leg resolves YES. It is not
N separate orders. Kalshi mints a ticker for your exact leg set:

```
ticker:        KXMVECROSSCATEGORY-SHARD1-S2026BC790E788B8-E397C9502CB
event_ticker:  KXMVECROSSCATEGORY-SHARD1-S2026BC790E788B8
exchange_index: 1
```

`S2026BC790E788B8` and `E397C9502CB` are content hashes. They are **not derivable from the
legs**. Any code that builds a combo ticker by string concatenation is broken by
construction — audit for it and delete it.

The market must be created before it can be traded **or even looked up**:

```
POST /trade-api/v2/multivariate_event_collections/{collection_ticker}
```

```json
{
  "selected_markets": [
    {"event_ticker": "KXNFLGAME-26SEP09NESEA", "market_ticker": "KXNFLGAME-26SEP09NESEA-SEA", "side": "yes"},
    {"event_ticker": "KXMLBGAME-26SEP041905BOSBAL", "market_ticker": "KXMLBGAME-26SEP041905BOSBAL-BOS", "side": "no"}
  ],
  "with_market_payload": true
}
```

Notes that cost hours if missed:
- The path has **no** `/create_market` and **no** `/lookup` segment. Both 404. The create IS
  a POST to the collection ticker itself.
- `side` is lowercase `"yes"` / `"no"`.
- All three of `market_ticker`, `event_ticker`, `side` are required per leg.
- Read `market_ticker` out of the response. **That string is the only thing you may trade.**
- Creation is free, capped at 5000 per week.
- `size_min` is 2 on every collection. A one-leg combo is just a normal market — reject it
  client-side with a clear message.

---

## FIX 2 — Check for a counterparty BEFORE sending the order. The combo book is nearly empty.

Measured across every open combo market on 2026-09-04:

| series | open markets | have an ask | ever traded | open interest |
|---|---|---|---|---|
| `KXMVECROSSCATEGORY-SHARD1` | 200 | 26 | 0 | 0 |
| `KXMVESPORTSMULTIGAMEEXTENDED` | 37 | 2 | 1 | 1 |
| `KXMVECROSSCATEGORY` | 24 | 0 | 0 | 0 |
| **total** | **261** | **28 (11%)** | **1** | **1** |

Same probe on ordinary single markets: `KXNFLGAME` 64/64 quoted with 3,070,194 contracts of
volume, `KXMLBGAME` 106/106 quoted with 5,277,902. So: **8.6M contracts traded on singles
versus one trade in the entire combo product.**

A freshly created combo arrives with no counterparty. A resting bid on it sits unfilled
forever. The order was accepted. Nothing filled. No position appeared. That is the reported
symptom, exactly.

Implement:

```
GET /trade-api/v2/markets?ticker=<market_ticker>
```

- If `yes_ask_dollars` is 0 or absent → **do not send the order.** Return a distinct,
  user-visible reason: `no_counterparty_on_combo_book`.
- If there is an ask → price to **take** it, not to rest behind it.
- Never post a bid into an empty combo book and report it as a placed trade.

Unverified and worth one cheap test: whether a *freshly created* combo gets an immediate
quote from Kalshi's own maker. One authenticated create plus an orderbook read settles it.
Creation is free. Run that test and report the answer.

---

## FIX 3 — The order payload must be the V2 shape. Legacy field types fail silently.

```
POST /trade-api/v2/portfolio/events/orders
```

Kalshi's docs: the legacy `/portfolio/orders` endpoint "will be deprecated no earlier than
May 6, 2026 — clients should migrate to this path."

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

Three shape changes, each a silent failure on its own:

| field | legacy | V2 |
|---|---|---|
| `side` | `yes` / `no` | **`bid` / `ask`** |
| `count` | integer `10` | **string `"10.00"`** (fixed point, 0–2 dp) |
| `price` | cents integer `56` | **string `"0.5600"`** (fixed-point dollars) |

`bid` means buy YES. `ask` means sell YES. Selling YES is economically equivalent to buying
NO at `1 - price`, but this endpoint quotes everything from the YES side.

Required fields: `ticker`, `side`, `count`, `price`, `time_in_force`,
`self_trade_prevention_type`.

**`exchange_index`:** `0` = Default, `1` = Combos, `2` = Crypto, `3` = Tennis & Baseball.
Send `1` for combos, or omit it to auto-route by ticker. A hardcoded `0` on a combo ticker
is a bug — grep for it.

---

## FIX 4 — Preflight the shard collateral. This is the hard blocker and code alone cannot clear it.

Kalshi, on exchange sharding: "Programmatic traders must **preallocate collateral on a given
exchange shard** before order placement."

Balance is held **per shard**. Read live from the account on 2026-09-04:

```json
{"balance":1960,"balance_breakdown":[
  {"balance":"19.6062","exchange_index":0},
  {"balance":"0.0000", "exchange_index":1},
  {"balance":"0.0036", "exchange_index":2},
  {"balance":"0.0000", "exchange_index":3}]}
```

Shard 1 is the combo shard and it held **$0.00**. Combos moved to shard 1 on 2026-08-17.
Every combo placed since then was uncollateralized, so it could not fill, so nothing reached
the wallet. No amount of fixing the request shape changes this.

What to build:

1. Before any combo order, `GET /trade-api/v2/portfolio/balance` and read
   `balance_breakdown` for the target `exchange_index`.
2. If that shard's balance is below the order notional → refuse with the distinct reason
   `insufficient_collateral_on_shard_<n>`, and surface the number in the UI. Never fall
   through to a generic failure or a success message.
3. Offer the one-call fix in the UI, and wire it behind an explicit user action:

```
POST /trade-api/v2/portfolio/target_balance_allocation
{"allocations":[{"exchange_index":0,"percent":70},
                {"exchange_index":1,"percent":30}]}
```

The field is **`percent`**, not `percentage`. Percents must total 100. An empty array
disables rebalancing. Kalshi recomputes every 10 seconds (balance minus resting orders) and
transfers to restore the target, so this is set-once.

One-off alternative: `POST /trade-api/v2/portfolio/intra_account_transfer`.
Manual path, no code: `https://kalshi.com/account/exchange-indexes`.

Note for the future: as sports migrates to shard 3 and crypto/commodities to shard 2, a bot
trading those categories needs an allocation on those shards too or it hits this same wall.
Make the shard preflight generic over `exchange_index`, not hardcoded to 1.

---

## FIX 5 — Auth: RSA-PSS, two landmines that produce a valid-looking 401.

Headers on every request:
- `KALSHI-ACCESS-KEY` — the Key ID
- `KALSHI-ACCESS-TIMESTAMP` — current time in **milliseconds**, as a string
- `KALSHI-ACCESS-SIGNATURE` — base64 of the signed message

Message = `timestamp_ms + HTTP_METHOD + path`, concatenated with no separators.

```python
sig = private_key.sign(
    msg.encode(),
    padding.PSS(mgf=padding.MGF1(hashes.SHA256()),
                salt_length=padding.PSS.DIGEST_LENGTH),
    hashes.SHA256())
```

1. **Salt length must be `PSS.DIGEST_LENGTH`, not `MAX_LENGTH`.** Most sample code and most
   library defaults use `MAX_LENGTH`, which yields a signature that looks fine and gets a
   401. Check what this repo currently does.
2. **Strip the query string before signing**, but keep the `/trade-api/v2` prefix. Kalshi's
   own example: for `/trade-api/v2/portfolio/orders?limit=5`, sign only
   `/trade-api/v2/portfolio/orders`.

Base URLs, all working: `external-api.kalshi.com`, `api.elections.kalshi.com` (prod);
`external-api.demo.kalshi.co`, `demo-api.kalshi.co` (demo).

---

## FIX 6 — Confirm the fill. Acceptance is not a fill. This is the root defect.

After ordering:

```
GET /trade-api/v2/portfolio/positions
```

Only a position in that response proves the trade happened. Until it appears, the correct UI
state is **pending**, never "placed" and never a green check. A 200 from the order endpoint
means Kalshi accepted a request, nothing more.

Add an explicit terminal state for "accepted but unfilled after N seconds" and show it.

---

## FIX 7 — Surface every refusal. Stop swallowing gates.

The app's own config had six stacked conditions that each silently produce "nothing
happened," read live from the running page on 2026-09-04:

1. Combo shard collateral $0 (Fix 4).
2. **Auto-Fire OFF** — the app's own tooltip says "Without this, combos are locked but
   require manual FIRE." Combos get built and locked. This alone reproduces the symptom.
3. **Simulation Mode (Paper Trading) ON** — nothing was ever real.
4. **Minimum Trade Balance $50** against a real Kalshi balance of **$19.61** → "Bot won't
   place trades below this balance." Blocks every trade, not just combos.
5. **Max Bet Per Combo $5.00** against **Dragon Mode Min Bet $10** — a dead zone where every
   combo is simultaneously over the max and under the min. Validate these against each other
   at save time and refuse an impossible pair.
6. **Cross-Category Mode ON with Min Categories 2** (sports + crypto) — crypto is shard 2,
   also near-zero. A cross-shard combo needs collateral on every shard involved.

Requirements:
- Build a single preflight that evaluates every gate before a combo is attempted, and
  returns the **complete list** of blocking reasons with their live values — not the first
  one, and never a generic failure.
- Render that list in the UI. "Nothing happened" must be impossible; the user should always
  be able to see which gate stopped it and what number it wanted.
- In paper/simulation mode, label simulated results as simulated everywhere they appear.
  A paper result must never render identically to a real fill.

Two UI truth bugs found the same day, fix them too:
- The header read **CAPITAL $41.20**, which was `peakBalance` out of localStorage, not the
  live balance of $19.61. `dragon-tradar-storage` held `{balance:19.6098, peakBalance:41.1998}`.
  Show the live balance; if peak is worth showing, label it peak.
- `/admin` said "Setup Required — Add your Kalshi API credentials" while `/config` said
  "Connected — stored securely on server." The two pages disagreed. `/config` was accurate
  (the server had proxied a real Kalshi balance call). Make both read one source of truth.
- Server-side `/api/bot/state` returned `config:null, balanceKnown:false,
  kalshiApiStatus:"UNKNOWN"`, which is why the agent API reported `balanceCents: 0`. The
  server bot was never configured — the browser was doing all the Kalshi talking. Decide
  which side owns the Kalshi connection and make the other side reflect it.

---

## The correct sequence, end to end

```
1. GET  /multivariate_event_collections            -> pick a collection_ticker
2. GET  /multivariate_event_collections/{ct}       -> read associated_events, size_min
3. GET  /markets?series_ticker=<leg series>        -> resolve each leg's real market_ticker
4. GET  /portfolio/balance                         -> CHECK the target shard's collateral
   |- if under the order notional: STOP, report insufficient_collateral_on_shard_<n>
5. POST /multivariate_event_collections/{ct}       -> {selected_markets:[...]}
   |- READ BACK market_ticker. Never construct it.
6. GET  /markets?ticker=<market_ticker>            -> CHECK yes_ask_dollars > 0
   |- if 0: STOP, report no_counterparty_on_combo_book. Do not send the order.
7. POST /portfolio/events/orders                   -> V2 shape, side=bid, string count/price,
                                                      exchange_index 1 or omitted
8. GET  /portfolio/positions                       -> CONFIRM the position exists
   |- acceptance at step 7 is NOT a fill. Only step 8 proves it.
```

Steps 4, 6 and 8 are the ones Dragon Tradar is missing. They are the entire bug.

---

## How to report back

Do not report success on a green build or a passing test suite. A test suite passes whether
the real path works or is stubbed.

State, in plain sentences:
1. What changed, file by file, with line references.
2. What the live Kalshi docs said where they differed from this prompt.
3. The result of one real authenticated end-to-end run in **demo** environment
   (`demo-api.kalshi.co`) through all 8 steps — including what step 6 returned for
   `yes_ask_dollars` and what step 8 returned from `/portfolio/positions`.
4. Anything you could not verify, named as unverified.
5. What the user will now **see on screen** that they could not see before.

If the shard-1 collateral is still $0, say so and say that no code change can fill it — that
is an account action, not a build.
