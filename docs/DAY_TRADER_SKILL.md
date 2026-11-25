# Day Trader skill pack + Robinhood Trading MCP

Added 2026-11-25 on Classic's order. Not a STARGATE product feature: it is an
agent-harness tool lane for the coding agent, same class as `multica-ops`.

## What was installed

- `.claude/skills/trader-*` — the 11 skills from
  https://github.com/Jakeschincariol/day-trader-skill, copied verbatim at
  upstream commit `3d0f4ef6986f4984b7c6bd46f7ff4f87744c3abd` (v2.0.0, MIT).
  Stdlib Python 3.8+, no pip installs. Data sources: Yahoo Finance chart/RSS,
  Nasdaq Trader symbol lists, SEC EDGAR, House Clerk PTRs, stooq.
  `trader-pelosi` shells out to `pdftotext` if present.
- `.mcp.json` — `robinhood-trading` (HTTP, `https://agent.robinhood.com/mcp/trading`).
  This is Robinhood's official endpoint (support article "Onboarding an
  external agent"). Opening this repo in Claude Code offers the server; auth is
  `/mcp` -> robinhood-trading -> authenticate, in the browser, on Classic's
  machine only.
- `.claude/settings.json` — `permissions.ask` for every Robinhood tool that
  places, cancels or exercises. Read-only tools are not listed.
- `.gitignore` — `trader/` (the pack writes orders, fills, portfolio and the
  broker log there; never commit it).

To update the pack: re-clone upstream and re-copy the `trader-*` folders. Do
not hand-edit them; put repo-specific rules here.

## Robinhood facts (verified from robinhood.com support, 2026-11-25)

- Trading needs a dedicated **Robinhood MCP account**. The agent gets READ
  access to all Robinhood accounts, but can only PLACE trades in the MCP /
  Agentic account, with money deposited into it.
- **Trade approvals default OFF for MCP accounts.** With it off, the agent can
  place eligible trades with no per-order confirmation in the app. Turn it ON:
  Robinhood app -> MCP tab -> Agent Settings (tap the agent) -> Safety Controls.
- Asset classes: long equities, options (single-leg only), crypto (needs a
  Robinhood Crypto account; not in NY and other restricted states). Order
  types: market (shares or dollars), limit, stop limit, stop market.
- Token billing applies only to Robinhood-hosted agents, not this MCP lane.
- Robinhood: "You are ultimately responsible for the trades your AI agent
  places in your account."

## Known gap: trader-broker speaks Alpaca, not Robinhood

`trader-broker/ticket.py` renders the exact JSON for Alpaca's
`place_stock_order` (fields `symbol, side, qty, type, time_in_force,
order_class, take_profit_limit_price, stop_loss_stop_price`) and knows two
brokers: `alpaca` (default) and `ibkr`. Robinhood's tool is
`place_equity_order` with its own schema, and it has no bracket order: the
stop-loss and take-profit legs are separate orders (or `place_advanced_order`).

Until an adapter exists, the broker step on Robinhood is manual:

1. `trader-risk` must PASS the order and `ticket.py approve` must record the yes.
2. Call `review_equity_order` first (simulation, pre-trade warnings).
3. Then `place_equity_order` for the entry, translating the ticket by hand.
4. Place the stop and the target as separate orders and record them with
   `ticket.py result` / `ticket.py fill`.

The pack's three gates still apply: risk PASS, an explicit typed yes for that
one order, and Claude Code's own permission prompt (forced by settings.json).
Nothing here runs from a scheduled or background task.

## Config Classic still has to set (local, not committed)

- `trader/config.json` from `trader-budget/config.example.json`: budget and
  loss limits, `"broker"`, `"paper"`. There is no paper mode on Robinhood's
  MCP: the MCP account is real money, so size it like real money.
- `SEC_USER_AGENT="Name email"` in the shell, or `sec_user_agent` in that
  config. SEC EDGAR requires it for `trader-news` and `trader-analyst`.
