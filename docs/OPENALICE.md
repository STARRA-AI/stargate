# OpenAlice in STARGATE

Source: [TraderAlice/OpenAlice](https://github.com/TraderAlice/OpenAlice) (AGPL-3.0).
STARRA uses OpenAlice as **external market intel muscle** — not an embedded autonomous trader.

## Doctrine (runtime prompt clip)

OpenAlice is a local trading workspace for coding agents: workspaces, markdown issues,
tracked entities, inbox reports, market data tools, and optional broker-backed **Trading-as-Git**
(staged → committed → operator-approved push).

**STARGA boundary:**

- Research, issues, inbox, and capability status may surface in STARGATE READOUT.
- STARGATE does **not** invent live portfolio numbers, balances, or P&amp;L.
- STARGATE does **not** relay venue-mutating orders. Trade intents require operator confirm;
  execution completes in OpenAlice UI.
- Dragon Tradar (Kalshi) stays separate — OpenAlice covers equities/crypto/brokers.
- Operator gates sacred (STARRA_GUARDIAN): protect livelihood; no unsupervised live trading.

When OpenAlice runtime is offline, STARGATE shows honest connector status — not fake live data.

## What OpenAlice is

OpenAlice maps trading work onto agent-operable files:

| Surface | Role |
| --- | --- |
| Workspaces | Per-task git repos + native agent CLIs |
| Issue board | Markdown work items, optional schedules |
| Tracked entities | Tickers, themes, theses — wikilink graph |
| Inbox | Agent reports and scheduled run output |
| Market tools | Data, news, fundamentals, technicals (read-first) |
| UTA / Trading-as-Git | Optional broker layer — beta; approval-gated in OpenAlice |

Default runtime: `http://127.0.0.1:47331` (loopback). State lives in `~/.openalice`.

## STARGATE integration (Safe mode A + B)

1. **Vendor clone** — `bash scripts/bootstrap-openalice.sh` → `vendor/openalice` (gitignored).
2. **Tools API** — `/api/tools/openalice` with `status`, `capabilities`, `issues`, `inbox`, `plan`.
3. **Trade gate** — `src/lib/security/trade-gate.ts`; POST `trade-intent` returns 428 + confirm token.
4. **Key vault hooks** — Settings → LINK APIS:
   - `openalice_base_url` — runtime URL
   - `openalice_alpaca_key_id` / `openalice_alpaca_secret_key` — dormant until linked; prefer configuring brokers inside OpenAlice directly.
5. **Tools page panel** — status, list issues/inbox, research plan stub.

## Operator workflow

### Bootstrap (once)

```bash
bash scripts/bootstrap-openalice.sh
cd vendor/openalice && pnpm install && pnpm dev
# Or detached: openalice server start vendor/openalice
```

### Daily use from STARGATE

1. Open **Tools → OpenAlice** — check vendor + runtime LEDs.
2. **List issues / inbox** when runtime is online — intel readout only.
3. **Research plan** — STARRA-shaped steps; run deep research in OpenAlice Ask Alice.
4. Any trade idea → stage in OpenAlice Trading-as-Git; never from STARGATE autonomously.

### Keys

| Slot | Required? | Purpose |
| --- | --- | --- |
| `openalice_base_url` | Optional | Non-default runtime host/port |
| `openalice_alpaca_*` | Optional | Unlocks STARGATE trade-intent gate logging only |

Broker credentials should primarily live in OpenAlice sealed credential store.

## API quick reference

```
GET  /api/tools/openalice?action=status
GET  /api/tools/openalice?action=capabilities
GET  /api/tools/openalice?action=issues
GET  /api/tools/openalice?action=inbox
GET  /api/tools/openalice?action=plan&q=sector+scan
POST /api/tools/openalice  { "mode": "plan", "query": "..." }
POST /api/tools/openalice  { "mode": "trade-intent", "action": "buy 1 SPY" }
POST /api/tools/openalice  { "mode": "trade-intent", "action": "...", "confirmToken": "abc123" }
```

## Fit vs STARRA unified doc

- **Money mission:** Research → thesis → optional execution — aligned with T3 capital lanes.
- **Dragon Tradar:** Complementary (prediction markets vs broker workspace).
- **Think Tank:** Unchanged; tank may consume real Kalshi watchlist, not OpenAlice fiction.
- **Multica pattern:** External runtime + honest status + operator-linked keys.

## What OpenAlice is not (in STARGATE)

- Not a second command deck UI — full UX stays in OpenAlice.
- Not unsupervised live trading from the Bridge.
- Not a source of fabricated market or portfolio numbers when offline.

## License note

OpenAlice is AGPL-3.0. Vendor tree stays gitignored; STARGATE integration is a thin
connector (status proxy + gates + docs). Running OpenAlice is a separate operator process.
