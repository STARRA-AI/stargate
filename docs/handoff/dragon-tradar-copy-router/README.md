# The Dragon Tradar copy-trade lane (for the Replit app)

This folder is the Replit half of leaderboard copy-trading: scan the Kalshi and
Polymarket leaderboards, resolve what each trader actually did, match it to a
live Kalshi market, and place the mirror **through Dragon Tradar** instead of
around it.

`copy-router.ts` is the whole router. It is not deck code — `docs/handoff` is
excluded from the deck's tsconfig (`tsconfig.json:44`) and nothing in the app
imports it.

**This file is the one Classic pastes into Replit, so it runs where none of the
deck's guards exist.** Everything below treats that as the design constraint.

The deck half lives in `src/lib/dragon-copy.ts`, `src/lib/copy-signals.ts`,
`src/lib/copy-match.ts` and `src/lib/kalshi-social.ts`, with tests under
`tests/`. Today `src/lib/copy-loop.ts:261` calls `kalshi.placeOrder` directly,
which signs an order with Classic's RSA key and goes straight to Kalshi — so the
deck's copy loop currently bypasses the "Agent trading enabled" toggle,
`maxOrderNotionalUsd`, `AGENT_LIVE_TRADING_ENABLED` and the daily loss floor.
Those are exactly the brakes he asked to be behind.

## What changed in this pass

Three defects in `copy-router.ts`, all found by review rather than by running it.

**1. It carried the YES-price bug.** `resolveRole` set `priceCents` straight
from `row.price`, and `row.price` is the **YES** price of the print whatever side
anyone was on. Every NO-side fill was therefore mis-stated by `100 - p`. The fix
is a **local** `sidePriceCents(yesPriceCents, side)` — local because this file is
standalone for Replit and must not import deck code; it is a deliberate duplicate
of `src/lib/kalshi-social.ts:334` and a note in both says to change both.

The evidence, measured not inferred: 41 rows of `BitcoinTradingChallenge`'s
social tape matched by `trade_id` against
`GET https://api.elections.kalshi.com/trade-api/v2/markets/trades`, which
publishes `yes_price` and `no_price` as separate fields. `social.price ===
v2.yes_price` on **all 41 rows**, including every row whose `taker_side` is
`"no"`. Worked example: trade `072529dc-5c51-8e7a-8f6d-0f39d2963f52`
(`KXWNBA3QTOTAL-26OCT04NYATL-45`) is social `taker_side=no price=99`, while v2
reports `yes_price=99, no_price=1` — that NO side transacted at **1c, not 99c**.
After the same fix shipped on the deck it was re-verified live: 40 resolved fills
cross-checked against v2 per-side prices, 40 correct, 0 wrong, 16 of them side
`"no"`.

Why it matters in dollars: a NO fill reported at 2c truly cost 98c. At 895
contracts that is **$877.10, not $17.90** — a $20 per-scan ceiling would wave
through a commitment 49x larger than his entire $42.40 balance. The error runs
both ways: a NO fill reported at 98c truly cost 2c, so a mirror limit at 98c sits
49x above the market and sweeps every ask between.

**2. It was markedly less defensive than the deck.** `src/lib/kalshi-social.ts`
`resolveFill` refuses a row it cannot prove; the router accepted almost anything.
It is now at parity, and each refusal is a **named, counted reason** rather than
a bare null:

| Rejection | What it refuses, and why refusing is cheaper than guessing |
|---|---|
| `ambiguous_role` | Neither nickname on the row is the trader asked about. Ordinary — the counterparty's nickname is `""` on anonymised rows. |
| `self_trade` | **Both** nicknames are this trader. The legs cancel; there is no "what they did" to mirror, so the role is undecidable. |
| `unusable_side` | `taker_side` / `taker_action` is not one of the four documented values. The old parser coerced anything unrecognised to `"yes"` / `"buy"`, which turns a garbled row into a confident position on a side nobody traded. |
| `unusable_price` | No orderable 1..99c price on `price` or `price_dollars`. A 0 or 100 print is an outcome, not a price a mirror order could be placed at — so it is rejected, never clamped. |
| `unusable_count` | Under one whole contract. Kalshi **does** print sub-contract fills (one row of a measured 100-row tape was `count: 0 / count_fp: "0.10"`) and no whole-contract order mirrors one. Rounding up would invent size on a money path. |
| `missing_trade_id` | `trade_id` is empty. It cannot be de-duplicated, and **minting** an id would make the same fill read as a brand-new signal next scan — a second position on a bet already held. |
| `missing_market_key` | Empty ticker: nothing to match a market against. |
| `unusable_timestamp` | `create_date` does not parse, **or is dated in the future**. `Date.parse` returns `NaN` and every comparison against `NaN` is false, so a fill of unknown age sails through as fresh; a future date does the same by arithmetic, because a negative age is under every ceiling. |

Each one is counted separately on `GET /copy/state` on purpose. A lane dropping
every row for sub-contract size and a lane dropping every row because the
nicknames never match look identical from the outside — both show zero accepted
copies — and one number called `ambiguous_role` would send him hunting the wrong
cause. The same checks now apply to the **Polymarket** path, which previously
`continue`d silently on a bad price and substituted `new Date(0)` for a missing
timestamp (a 1970 fill, caught by the staleness gate by accident and labelled
nothing).

**3. `ResolvedMarket.askCents` was side-blind in a money path handed to someone
else to implement.** It was documented only as "the current ask in whole cents,
1..99", while the order carries `side: fill.side` — which is `"no"` on a real
share of rows (16 of 40 on the deck's cross-check). An implementer returning the
YES ask would price every NO order on the wrong side of the book, and returning
the YES ask is the *obvious* thing to do: the deck's own matcher reads only
`yes_ask_dollars` (`src/lib/copy-match.ts:102` and `:141`). The type now demands
both sides by name:

```
export type ResolvedMarket = {
  ticker: string;
  yesAskCents: number | null;
  noAskCents: number | null;
};
```

`askForSide(market, side)` picks the one the order will actually use, and never
derives one side from the other. `null` means that side is not quoted — not 0,
not 100 — and the signal is rejected `missing_side_ask`, which is a different
fact from `price_out_of_band`.

**The NO ask is not `100 - yesAskCents`.** A completed trade has two sides
summing to 100c, which is why `sidePriceCents` may complement a *print*. A *book*
does not work that way: buying NO at `n` is the same trade as selling YES at
`100 - n`, so the cheapest NO you can lift is set by the best YES **bid**.

```
noAskCents  = 100 - yesBidCents
yesAskCents = 100 - noBidCents
```

Deriving the NO ask from the YES ask prices the order inside the spread, where it
rests unfilled, or straight through it. **Unverified:** whether the market object
his app already reads carries a NO ask field of its own. If it does, read it —
do not derive anything.

## What this does, in one paragraph

`POST /copy/scan` reads the Kalshi social leaderboard (by volume) and the
Polymarket profit leaderboard, pulls each trader's recent fills, works out
whether that trader was the maker or the taker on every row **and what their side
actually cost**, drops everything unprovable / stale / unmatched / out of band /
over a cap with a named reason, builds limit orders at **the ask for the side
being bought**, and returns the plan. **It is a dry run unless the body says
`{"live": true}`.** `GET /copy/state` returns the last scan with the rejection
counts by reason. `POST /copy/config` edits the signal config with per-field
validation.

## What is verified, and what is not

Probed live by curl on 2026-10-04. These are measurements, not documentation.

**Kalshi has a leaderboard API.** The public consensus is that it does not. It
is at `https://api.elections.kalshi.com/v1/social/*`, free, no auth, no key, and
undocumented.

- `GET /v1/social/leaderboard?metric_name=volume&limit=100` → 200 with
  `rank_list[]`.
- `metric_name` is required and validated by a Go `oneof` tag. **Only `volume`
  works.** `profit`, `pnl`, `realized_pnl`, `roi`, `win_rate`, `trades`,
  `streak`, `notional` and 13 others all return 400 `invalid_parameters`. So the
  only ranking Kalshi will give is **by turnover, not by skill** — a market
  maker churning both sides of a book ranks first and may be flat on the year.
- `limit` is required. The cap is 100; 200 and 500 return error/empty.
- `period`, `window`, `timeframe`, `category` and `series_ticker` are all
  ignored — identical rank 1 for every value. There is one window and it is
  unlabelled.
- `GET /v1/social/trades?nickname=<n>&page_size=<n>` → 200
  `{"trades":[...],"visibility_state":"visible"|"hidden"}`. `page_size` works;
  `limit` is ignored (always 100) and `cursor` is ignored.
- Trade row keys exactly: `trade_id, market_id, ticker, price, price_dollars,
  count, count_fp, taker_side, taker_action, maker_nickname, taker_nickname,
  create_date`. The timestamp field is **`create_date`** — there is no
  `created_time` and no `ts`.
- **`price` is the YES price, always.** Proven by the 41-row `trade_id`
  cross-check above against `/trade-api/v2/markets/trades`.
- 404, do not use: `/v1/social/positions`, `/social/posts`, `/social/activity`,
  `/social/feed`, `/social/shared_positions`, `/trade-api/v2/social/*`,
  `/trade-api/v2/leaderboard`.

**Polymarket** re-verified 200 today: `GET https://lb-api.polymarket.com/profit?window=7d&limit=50`
is ranked by profit, windows `1d/7d/30d/all`, `limit` hard-capped at 50. A
default Python-urllib or bare Node User-Agent gets **403** on `lb-api` — send a
browser User-Agent. `defaultFetchJson` in the router does.
`GET https://data-api.polymarket.com/activity?user=<proxyWallet>&limit=100`
returns `type` of `TRADE | REDEEM | MAKER_REBATE | TAKER_REBATE`; only `TRADE`
becomes a signal, and the row carries a `slug`.

**Dragon Tradar**, probed today with his token: `GET /api/agent/v1/stats` → 200
`{"connected":true,"balanceCents":4240,"positions":[]}`; `GET /bot/state` → 200
`running=false category=sports mode="paper" lastScanAt=null` with
`config{minBetCents:1000, maxLegs:5, minEdgePct:0.02, minConfidencePct:0.5,
autoFire:true, scanIntervalMin:15, thinkTank:false, dailyLossFloorCents:0}` plus
an `authority{}` block that was not in the earlier notes.

**Not verified: the write lane.** `GET /order`, `/bot/engage`, `/signals`,
**`/copy/scan` and `/copy/state` all answer `404 "Cannot GET /api/..."` on the
live host right now.** `/copy/scan` and `/copy/state` 404 because this file does
not exist there yet. **An Express POST-only route answers a GET with exactly that
same string**, so a GET 404 is **not proof a POST-only route is absent** — and
not proof it exists either. The 404 tells you nothing in either direction.
Nothing on the deck side has ever successfully POSTed to his app.

**This router has never been compiled or run.** `docs/handoff` is outside the
deck's tsconfig (`tsconfig.json:44`), it imports `express` — which the deck does
not depend on, and `@types/express` is not installed here — and no test
exercises it. It was typechecked in isolation under `strict` with a hand-written
`express` module shim and came back clean, and `npx eslint` on it reports 0
problems; neither of those is the same as running it. **The first real `tsc` it
sees will be the one on his Replit.**

**The 429 lockout is real.** One request with a bad token returns
`429 temporarily_blocked` and locks Classic out of his own bot. One attempt, no
retry, anywhere. The deck's `submitCopyBatch` also stops the whole batch on the
first 429/401/403 rather than walking the rest of the list into the same wall.

## Two findings that decide whether this strategy can work at all

**Kalshi copy-trading has a universe of two traders.** Of the top 100 by volume,
exactly two have `visibility_state == "visible"`: rank 67
`BitcoinTradingChallenge` (volume $1,110,684) and rank 87 `szg.szg` (volume
$865,901). The other 98 return `{"trades":[],"visibility_state":"hidden"}`.
Trade visibility is opt-in on Kalshi, and neither visible trader is in the top
50. `GET /copy/state` reports `kalshiVisible` on every scan, because a lane that
legitimately finds nothing and a lane that is broken look identical otherwise.

**The maker/taker fields describe the counterparty, not the trader.**
`taker_side` and `taker_action` are the other side of the trade. Measured role
split: `BitcoinTradingChallenge` maker 77 / taker 23; `szg.szg` maker 91 /
taker 9. Copying those two fields verbatim **inverts the position on roughly 85%
of rows.** `resolveRole` in the router is the fix:

- `maker_nickname === nickname` → our trader was the maker. Side is
  `taker_side` unchanged; action is the **opposite** of `taker_action`. (A taker
  selling NO moves NO contracts to the maker, so the maker bought NO. The
  contract type is the same object for both parties; only the direction of the
  transfer differs.)
- `taker_nickname === nickname` → our trader was the taker. Both fields verbatim.
- Neither matches — the other nickname is `""` on anonymised rows — the row is
  ambiguous: `ambiguous_role`, never a guess.
- Both match — a self-trade: `self_trade`, because the role is undecidable.

Matching is **exact**, never case-insensitive. Kalshi nickname case-sensitivity
is unverified, and a loose match could bind two distinct accounts: a missed match
costs one skipped signal, a wrong match costs a wrong position.

And a maker fill is a resting limit someone crossed to: they **collected** the
spread. Mirroring it with a market order **pays** the spread, which is the
opposite trade. Nothing in either half ever sends a market order — every order
carries `priceCents`, so what goes out is a limit. That is what makes a maker
mirror faithful rather than backwards.

## The rule that matters most

**401 and 403 mean the token, and nothing else.** The deck maps them to "the
token was rejected — go regenerate it", so a business refusal answered with a
403 sends Classic off to rotate a healthy token while the real cause stays
hidden. Status codes, the same contract as the A1 router
(`docs/handoff/dragon-tradar-agent-router/README.md`):

| Status | Codes |
|---|---|
| 401 | `missing_agent_token`, `invalid_agent_token` |
| 429 | `temporarily_blocked` |
| 409 | `agent_trading_disabled`, `live_trading_disabled`, `copy_lane_disabled`, `copy_mode_not_accepted` |
| 422 | `scan_budget_exhausted`, `insufficient_balance`, `order_exceeds_max_notional` |
| 423 | `daily_loss_floor_reached` |
| 400 | `invalid_copy_config`, `unknown_copy_config_key`, `empty_copy_config`, `invalid_scan_request` |

Every error body is `{"error": "<code>"}`. A bot mode this lane was not told to
accept is a **409 `copy_mode_not_accepted`**, never a 403. The per-signal
rejections in the table further up are **not** HTTP statuses — they are counted
inside a 200 scan body, because a scan that correctly rejects everything
succeeded.

## Sizing, because the account is small

Balance $42.40. Dragon Tradar's own `minBetCents` is $10. The account is **four
minimum-size bets wide**, so a per-order ceiling alone cannot protect it: four
individually legal $10 orders in one scan is the whole bankroll. Both halves
therefore cap the **total notional per scan**, not just per order.

Defaults, all ceilings and never targets:

- `perOrderCents` 2000 ($20) — new env `DRAGON_COPY_MAX_NOTIONAL_CENTS` on the
  deck side, `perOrderCents` in the config here.
- `perScanCents` 2000 ($20) — the total one scan may commit. At the measured
  balance the deck also clamps this to half the balance, whichever is tighter.
- `maxOpenCopies` 4 — derived, not guessed: 4240c ÷ 1000c is exactly 4.
- The deck's existing `DRAGON_MAX_ORDER_NOTIONAL_CENTS` ($100 default) still
  applies on top, and so does his app's `maxOrderNotionalUsd`. Every combination
  is a `Math.min`, so nothing a caller passes can make an order larger.

Note the sizing arithmetic only holds if the price is right, which is why the
YES-price fix above is listed first: a mis-priced NO fill makes every one of
these ceilings measure the wrong number.

## Wiring, in order

1. **Deploy nothing live first.** Add the router with `COPY_LANE_ENABLED` unset,
   so `POST /copy/scan` answers `409 copy_lane_disabled` and nothing can fire.
2. Mount `createCopyRouter(...)` behind the **same** Bearer middleware that
   already guards `/api/agent/v1/stats`, alongside the A1 router. That middleware
   keeps owning 401 and the 429 lockout; nothing in this file re-implements auth.
3. Implement `CopyServices`. Reuse the existing services — do not write a second
   Kalshi client. `agentSettings`, `botState`, `balanceCents` and
   `realizedTodayCents` are the **same** functions the A1 router already uses.
4. Implement `resolveMarket(fill)` returning **`{ ticker, yesAskCents,
   noAskCents }`**. This is the one genuinely app-specific judgment and the only
   place a wrong answer costs money quietly.
   - Both asks are **whole cents** (`yes_ask_dollars` is a dollar string —
     multiply by 100 and round), each `null` when that side is not quoted.
   - If the market object carries its own NO ask, read it. If it does not,
     `noAskCents = 100 - yesBidCents`. **Never `100 - yesAskCents`.**
   - A game's clock is `occurrence_datetime`, **not** `close_time` —
     `close_time` is the settlement window and stays open after the final
     whistle. Return `null` rather than a loose match. The deck's equivalent is
     `src/lib/copy-match.ts`; note its `matchOutcomeGuarded`, which exists to
     refuse a Polymarket **spread** (outcome "Patriots" on slug
     `nfl-ne-buf-2026-10-04-spread-home-6pt5`) being matched to the Kalshi
     **moneyline** — a different, less likely event at a cheaper price that reads
     as free edge.
5. Set `COPY_LANE_ENABLED=true` and run **dry scans only** until the plan looks
   right: `POST /copy/scan` with an empty body, or `{"live": false}`.
6. Only then consider `{"live": true}`, which still needs the agent toggle,
   `AGENT_LIVE_TRADING_ENABLED`, and a bot mode in `acceptModes` (default
   `["paper"]`).

## Rollback

Each step undoes on its own, newest first.

- **Stop it firing, immediately:** unset `COPY_LANE_ENABLED`. Every scan then
  answers `409 copy_lane_disabled`. No redeploy — it is read per request.
- **Stop it trading but keep scanning:** unset `AGENT_LIVE_TRADING_ENABLED`, or
  `POST /copy/config {"acceptModes":["paper"]}` while the bot is in another mode.
- **Remove the lane:** delete the `createCopyRouter` mount. The A1 router and
  every existing route are untouched — this file adds three paths and changes
  nothing else.
- **Undo this pass specifically:** the only breaking change is
  `ResolvedMarket`'s shape. If a `resolveMarket` was already written against the
  old single `askCents`, the forward fix is two lines —
  `yesAskCents: askCents, noAskCents: null` — which is **correct but YES-only**:
  every NO signal then rejects `missing_side_ask` instead of being mispriced.
  That is the right failure while the NO side is being wired.
- **Deck side:** nothing in `src/` was touched by this pass, and nothing in
  `src/` or `tests/` imports this router (`grep` for `copy-router`, `askForSide`,
  `RoleResult` returns nothing). Deleting this whole folder cannot affect the
  running deck.

## Assumptions for Classic to verify

These are the places I could be wrong, in the order they would cost him money.

1. **`resolveMarket` is unwritten, and now has a two-sided contract.**
   Everything above it is verified; the matching and the two asks are what has to
   be implemented inside his app. A loose match sends a correct order for the
   wrong game; a YES ask returned for a NO order prices it on the wrong side of
   the book.
2. **Whether his market object has a NO ask field at all is unverified.** If it
   does not, the derivation is `100 - yesBid`. If the implementer uses
   `100 - yesAsk` instead, every NO order is priced inside or through the spread
   and nothing in this file can catch it.
3. **This router has never been compiled or run** — see the verification section.
   Isolated `tsc --strict` against a shimmed `express` is clean and `eslint` is
   clean; the real `express` types and the real runtime are untested here.
4. **The write lane has never been exercised.** `POST /order` returning a 200 has
   not been observed by anything I have run. The first live scan is the first
   time that path is tested.
5. **`autoFire` is `true`** in his current bot config (measured today; the older
   notes said false). Harmless in paper mode. It means a flip to live mode would
   fire without a human in the way. Flagged, not changed.
6. **Volume is not profit.** The only Kalshi ranking available ranks turnover.
   Whether `BitcoinTradingChallenge` and `szg.szg` are actually profitable is
   not something this API can answer, and with 98 of 100 traders hidden there is
   no selection to make.
7. **The Polymarket leaderboard does not identify a consistent earner.** Of the
   21 wallets that cleared $100k in 7d (2026-09-04), **zero** had meaningful
   profit in the prior three weeks. The raw board identifies whoever just got
   hot. Persistence has to be measured across collected snapshots over time; it
   cannot be read off one call. Until those snapshots exist, treat every
   Polymarket name as a lead, not a signal.
8. **A mirrored SELL is priced at the ask, which makes it passive.** Named in
   the router at the order-build site, not fixed: fixing it needs bid fields
   `ResolvedMarket` does not carry. A buy at the ask crosses and fills; a sell at
   the ask joins the best offer and rests. That is not mispriced, but a mirrored
   sell can be a silent no-op instead of a position. If he wants sells to fill,
   `ResolvedMarket` needs `yesBidCents` / `noBidCents` and a sell must be priced
   at the bid for its side.
9. **How his `POST /order` handles `action: "sell"` on a position the account
   does not hold is unverified.** On Kalshi that is a short; his app may open it,
   reject it, or read it as a close. One live paper order is the only thing that
   answers it.
10. **No Polymarket equivalent of the 41-row price cross-check exists.** The
   Kalshi YES-price bug was proven; the assumption that Polymarket's `activity`
   price already describes the traded token (so no complement is needed) is
   **unverified**. `fetchPolyTrades` says so at that line.
11. **Half the bankroll per scan is my number, not his.**
   `COPY_SCAN_BANKROLL_FRACTION` is 0.5 on the deck side. If he wants it tighter,
   that is a one-line change or a `perScanCents` override per call.
12. **The idempotency store is still in memory** on the A1 router. A Replit
    restart forgets every `clientOrderId`. The copy lane mints ids with the same
    hash as the deck, so the two callers dedupe against each other — but only
    while that store is alive.

## Post-deploy verification checklist

Run these from Terminal on the deck, in order. Each line should print JSON, not
Express's "Cannot GET". Stop at the first one that does not.

**Before any of it**, the deck gates must be clean — `npm run typecheck` and
`npm run test:v2` (node:test via `tsx --test`, not vitest; passing lines followed
by "0 test" is a failure, not a pass). Note that **no test in that suite touches
this router** — nothing in `src/` or `tests/` imports it, so a green suite says
nothing about this file.

**Step 0 — prove the price fix on this Mac, before pasting anything into
Replit.** No deploy, no network, no money. It feeds the router the real measured
row (social `taker_side=no price=99`, which v2 reports as `yes_price=99 /
no_price=1`) and prints what the NO side cost. It must print `1`.

```
cd ~/STARGATE/stargate && npx --yes tsx -e 'import("./docs/handoff/dragon-tradar-copy-router/copy-router.ts").then((m)=>{const r=m.resolveRole({trade_id:"072529dc-5c51-8e7a-8f6d-0f39d2963f52",ticker:"KXWNBA3QTOTAL-26OCT04NYATL-45",price:99,price_dollars:"0.99",count:895,count_fp:"895.00",taker_side:"no",taker_action:"buy",maker_nickname:"BitcoinTradingChallenge",taker_nickname:"x",create_date:"2026-10-04T18:00:00Z"},"BitcoinTradingChallenge");console.log(r.ok?`side=${r.fill.side} priceCents=${r.fill.priceCents} (must be 1, not 99)`:`REJECTED ${r.reason}`)})'
```

It should print exactly:

```
side=no priceCents=1 (must be 1, not 99)
```

If it prints `99`, the YES-price fix is not in the file being pasted.

```
cd ~/STARGATE/stargate && TOKEN=$(grep -m1 '^DRAGON_TRADAR_AGENT_TOKEN=' .env.local | cut -d= -f2-) && curl -s -H "Authorization: Bearer $TOKEN" https://dragontradar.com/api/agent/v1/copy/state
```

```
cd ~/STARGATE/stargate && TOKEN=$(grep -m1 '^DRAGON_TRADAR_AGENT_TOKEN=' .env.local | cut -d= -f2-) && curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' https://dragontradar.com/api/agent/v1/copy/scan
```

```
cd ~/STARGATE/stargate && TOKEN=$(grep -m1 '^DRAGON_TRADAR_AGENT_TOKEN=' .env.local | cut -d= -f2-) && curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"maxSignalAgeMinutes":45}' https://dragontradar.com/api/agent/v1/copy/config
```

What each one must show:

1. `/copy/state` returns `enabled`, `liveTradingEnabled`, the full `config`, and
   `last` (null before the first scan). If `enabled` is false that is correct for
   step 1 of the wiring.
2. `/copy/scan` with `{}` returns `dryRun: true`, a `checked` block, and
   `rejectedByReason`. **`checked.kalshiVisible` should be 2.** If it is 0, the
   social API changed or the fetch is being blocked — not that the lane is
   broken. `sent` must be `[]` and `mode` must read `paper`.
3. **The price check, and it is the one that proves this pass.** In the scan's
   `accepted[]`, every `why` string prints both prices: the trader's side price
   and the ask the mirror is placed at. Pick any accepted copy whose `order.side`
   is `"no"` and confirm the trader's price is **not** the YES print —
   `sidePriceCents` has made it `100 - p`. If a NO copy shows a price near 99c
   while the market's NO ask is near 1c, the fix is not in the deployed file.
4. `rejectedByReason` must use the **specific** reasons. A scan whose only
   reason is `ambiguous_role` when the tape clearly has unusable rows means an
   older `resolveRole` is deployed — it used to return a bare null and the caller
   labelled everything `ambiguous_role`.
5. `missing_side_ask` appearing is **correct behaviour**, not a bug: it is
   `resolveMarket` honestly reporting that the side being bought is not quoted.
   `missing_side_ask` on *every* row means `noAskCents` is being returned `null`
   unconditionally — step 4 of the wiring is unfinished.
6. `/copy/config` echoes the whole config back with only the field you sent
   changed. Send `{}` to it and it must answer `400 empty_copy_config` — a config
   write that silently does nothing is the failure this check exists to catch.
7. Run `/copy/scan` with `{}` **twice in a row.** The second must report
   `duplicate_intent` rejections for everything the first accepted. If it accepts
   the same bets again, `saveCopyState` is not persisting and a live scan would
   double every position.
8. Only after all of the above: one `{"live": true}` scan **in paper mode**, and
   read `sent[]` before considering any other mode.

Never retry a 429. If `temporarily_blocked` comes back, stop and wait — one more
request deepens the lockout on his own bot.

## Paste-ready brief for the Replit agent

Everything below the line can be pasted into Replit as one message, with
`copy-router.ts` attached.

---

Add a copy-trade router to this app at `/api/agent/v1`, mounted behind the same
Bearer-token middleware that already guards `/api/agent/v1/stats`. I am
attaching `copy-router.ts` — use it as written. Do not rename its routes, do not
change its status codes, and do not change `resolveRole`, `sidePriceCents` or
`askForSide`.

Your job is the wiring:

1. Implement the `CopyServices` interface at the top of the file. `agentSettings`,
   `botState`, `balanceCents` and `realizedTodayCents` must be the **same**
   functions the existing agent router uses — do not fork them, and do not write
   a second Kalshi client.
2. Implement `resolveMarket(fill)`: given a fill observed on Kalshi or
   Polymarket, return the Kalshi market that is the same bet and is **live and
   tradeable**, as `{ ticker, yesAskCents, noAskCents }`, or `null` if there
   isn't one.
   - Both asks are **whole cents**, not dollars. `yes_ask_dollars` is a string
     like `"0.42"` — multiply by 100 and round.
   - Use `null` for a side the book is not quoting. Do not send 0 and do not
     send 100.
   - If the market object has its own NO ask field, use it. If it does not,
     `noAskCents = 100 - yesBidCents`. **It is NOT `100 - yesAskCents`** —
     buying NO at `n` is selling YES at `100 - n`, so the NO ask is set by the
     YES **bid**. Getting this from the ask prices the order inside the spread.
   - Use `occurrence_datetime` to decide whether an event is still in play;
     `close_time` is the settlement window and stays open after the game ends.
   - Return `null` rather than a loose match. A Polymarket **spread** bet arrives
     as outcome "Patriots" on a slug like
     `nfl-ne-buf-2026-10-04-spread-home-6pt5`. Matching the team name alone buys
     the Kalshi **moneyline** — a different, less likely event at a cheaper
     price that looks like free edge. Refuse it.
3. Implement `loadCopyConfig` / `saveCopyConfig` / `loadCopyState` /
   `saveCopyState`. If this app has a database, put them in it — `acted` must
   survive a restart or a restart will let the lane re-fire every signal it
   already copied.
4. `copyLaneEnabled()` is `process.env.COPY_LANE_ENABLED === "true"` and
   `liveTradingEnabled()` is `process.env.AGENT_LIVE_TRADING_ENABLED === "true"`,
   both read per request so flipping either takes effect without a redeploy.
   **Deploy with `COPY_LANE_ENABLED` unset.**
5. Do not change the existing Bearer middleware, the "Agent trading enabled"
   toggle, `maxOrderNotionalUsd`, or the bot's mode. This router reads all of
   them and must never be able to bypass or set any of them.

Hard requirements, in priority order:

- `POST /copy/scan` is a **dry run** unless the body is exactly `{"live": true}`.
  A dry run must never call `placeOrder`.
- Never answer a business refusal with 401 or 403. Those two mean the token and
  only the token. A bot mode the lane was not told to accept is
  `409 {"error":"copy_mode_not_accepted"}`.
- `resolveRole` decides which side our trader was on **and what that side cost**.
  `taker_side` and `taker_action` describe the **counterparty**, and `price` is
  the **YES** price whatever side anyone was on. Do not "simplify" either one by
  reading the fields directly: the first inverts the position on about 85% of
  rows, and the second mis-states a NO fill's cost by `100 - p`, which at 895
  contracts is $877.10 reported as $17.90.
- `resolveRole` returns `{ok: true, fill}` or `{ok: false, reason, detail}`. Keep
  the distinct reasons. Do not collapse them into one "unresolved" count — a lane
  dropping every row for sub-contract size and a lane whose nicknames never match
  both show zero copies, and the reason is the only thing that tells them apart.
- Every error response is JSON shaped `{"error": "<code>"}` with the distinct
  codes in the file. No generic 400s.
- Send orders sequentially, one attempt each, and stop the whole batch on the
  first failure. One bad token returns 429 `temporarily_blocked` and locks the
  account out; retrying makes it worse.
- `GET /copy/state` must report `checked.kalshiVisible`. Of the top 100 Kalshi
  traders only 2 have visible trades, so a near-zero result is expected and has
  to be distinguishable from a broken scan.

When you are done, reply with: the file path the router lives at, the code you
wrote for `resolveMarket` **including how you got `noAskCents`**, whether `acted`
ended up in a database or in memory, and the JSON that `POST /copy/scan {}`
returned on your first dry run.
