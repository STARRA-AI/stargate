# DRAGON TRADAR — what it is and how I work it

Classic's own app. Live at https://dragontradar.com. An autonomous prediction-market
trading bot for **Kalshi** — the US-licensed, CFTC-regulated exchange. Not stocks, not
crypto spot. Kalshi contracts resolve YES/NO on a real-world outcome. This is a
different account and a different market from his Alpaca equities engine; I never
confuse the two.

His Kalshi API credentials are already saved and read "Configured". Setup is done.
What follows is how the thing operates, so I speak about it like someone who runs it.

## The pages
- **/dashboard** — portfolio value (cash + open positions), open positions with
  mark-to-market P&L, live bot activity log, start/stop, balance sync.
- **/markets** — 500+ live Kalshi markets, filter by category, YES/NO prices and
  implied probabilities, buy direct.
- **/scanner** — AI opportunity scanner across all markets, shows its reasoning.
- **/analysis** — deeper trend detection and risk-adjusted scoring.
- **/log** — every trade, win/loss, settlement, P&L per trade.
- **/performance** — win rate, ROI, mission countdown, and the Dragon Ball tracker:
  one Dragon Ball per $7 of profit.
- **Shenron** — the in-app Dragon Ball-themed advisor. His, not me. I don't
  impersonate it and I don't pretend its calls are mine.

## Dragon Mode — the autonomous engine, five modes
**Sports** (orange): 43+ live series — NBA, NHL, MLB, MLS, EPL, UFC, tennis. Only
trades games actually IN PROGRESS, using ESPN live scores for in-play status.
Multi-leg parlays through Kalshi's RFQ combo system.

**Crypto** (yellow): 15-minute binaries — KXBTC15M, KXETH15M, KXXRP15M, KXDOGE15M,
KXHYPE15M, KXBCH15M. Each asks "will this coin be above $X in 15 minutes?" and
settles on the CF Benchmarks 60-second average. Also hourly directionals: KXBTCD,
KXSOLD, KXDOGED, KXRIPPLED, KXHYPED. Live prices from CoinGecko. Computes RSI(14),
6-hour momentum, volatility, SMA20 trend. Scan interval auto-drops to 2 minutes.
Crypto runs 24/7 — there is always something live, unlike sports.

**Politics** (blue): all open political markets — elections, legislation, executive
actions, confirmations, tariffs and sanctions. Sorted by 24h volume, top 20 analyzed
per cycle. AI weighs polling, precedent, institutional dynamics.

**Economics** (green): FOMC and rate decisions, CPI/PPI/PCE, jobs, GDP, yields,
index levels, recession markets. Same volume sort and top-20 cycle. AI weighs Fed
trajectory, consensus forecasts, data releases.

**Parallel**: every category loop at once.

Trades fire on **FIRE STRIKE** manually, or automatically if Auto-Fire is on.

## The knobs that decide whether a trade happens
- Min Bet — default $10
- Max Legs — default 5 for combos
- Min Edge — default 2%
- Min Confidence — default 50%
- Auto-Fire — executes without asking
- Scan Interval — minutes between scans (2 for crypto)
- Think Tank — multi-model consensus

## Risk posture
- **Simulation Mode** is the default and it is ON until deliberately turned off:
  real markets, real decisions, virtual money, Kalshi account untouched.
- **Live Mode** is simulation OFF — every position is real money.
- **Kelly Criterion** sizes positions: bet = (edge x bankroll) / odds. Bigger on
  confidence, smaller without it. A max bet cap can override a large Kelly bet.
- **Server Mode** runs 24/7 on the server with the phone off. **Client Mode** runs
  in the browser and pauses when the browser closes or the phone sleeps.

## Think Tank — 5-model ensemble
Each model gets identical market data and independently returns YES / NO / SKIP with
confidence, edge, and reasoning. Weighted vote decides; real disagreement means SKIP.
Default weights: Claude 25%, Gemini 25%, ChatGPT 20%, Groq 15%, Grok 15%. Roles shape
each one: analyst, quant, contrarian, risk. Needs 2+ models. Default threshold 45%
ensemble confidence, and a trade wants >=2% edge. Prompts are category-specific —
sports gets game state, crypto gets price-vs-target and RSI, politics gets polling and
precedent, economics gets Fed policy and data. Groq is the free brain, no card.

## How I connect — the agent bridge
The app exposes an agent surface so I can read his stats and place trades through it
with his own Kalshi credentials.
- Base: `https://dragontradar.com/api/agent/v1`
- Auth: `Authorization: Bearer <agent token>` — issued in Settings -> AI Trading Agent.
- **One bad token returns 429 temporarily_blocked.** I back off. I never retry-storm,
  because a retry loop locks him out of his own bot.
- Three brakes stand between me and a real order: the panel's enable toggle, the
  `maxOrderNotionalUsd` per-order cap, and the server's `AGENT_LIVE_TRADING_ENABLED`.
  All three are his to set. I do not ask him to loosen them.

## How I talk about it
His money, his call. I bring him the read — what's live, what the edge looks like,
what the bot did and why — and I don't rank his priorities or lecture him about risk
he already understands. Returns here are genuinely high-variance on a small account;
when he asks, I say that plainly once and move on. I never claim a trade went through
until I have the fill.

## What the snapshot now carries
Her one tool, `stargate_dragon_snapshot` (`/api/dragon`), now also returns his open
positions, the bot's live state (running, category, mode), performance (realized +
unrealized P&L, win rate, trade count), and a sweep signal: realized profit banked
since the last sweep, whether it has crossed his target, and how much to suggest
moving out. Unrealized P&L never counts toward that target — it isn't money yet.
`sweep` is only present when performance actually loaded; I never invent a number.
Each read degrades on its own — one failing field never blanks the rest, and a
blocked or rejected token surfaces once per request, not once per field.
