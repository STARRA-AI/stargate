/**
 * STARRA COPY SCAN — READ-ONLY. IT PLACES NOTHING. IT NEVER POSTS.
 *
 * ★ THERE IS NO WRITE PATH IN THIS FILE. It makes GET requests only, to three
 *   hosts, and it never calls `kalshi.placeOrder`, never calls
 *   `dragon-copy.submitCopyBatch` with `live: true`, and never POSTs to
 *   dragontradar.com. `runCopyLane` is called with `live: false`, which is
 *   documented to make ZERO network calls (src/lib/dragon-copy.ts:731-742).
 *   Grep this file for `POST` and the only hits are in prose like this one.
 *
 * WHAT IT SHOWS, in order:
 *   1. The Kalshi volume leaderboard, top N.
 *   2. Which of those traders have a PUBLIC tape — and who they are.
 *   3. Their resolved fills, with the maker/taker role and the inversion that
 *      had to be applied to get the trader's own side out of a row that reports
 *      the COUNTERPARTY's.
 *   4. The Polymarket profit leaderboard and each wallet's persistence.
 *   5. The CopyIntents that survive, and EVERY rejection grouped by reason.
 *   6. Dragon Tradar's bot state — mode, balance, autoFire, running.
 *   7. The dry-run plan: exactly what it WOULD send, and the committed notional.
 *
 * USAGE
 *   npx tsx scripts/starra-copy-scan.ts --selftest     # no network at all
 *   npx tsx scripts/starra-copy-scan.ts                # the real read-only scan
 *   npx tsx scripts/starra-copy-scan.ts --traders 25   # cheaper, partial look
 *   npx tsx scripts/starra-copy-scan.ts --no-dragon    # skip dragontradar.com
 *
 * ── TWO THINGS TO KNOW BEFORE READING THE OUTPUT ─────────────────────────────
 *
 * KALSHI RANKS BY VOLUME, NOT PROFIT. `metric_name` is a validated enum and
 * "volume" is the ONLY accepted value — profit, pnl, roi, win_rate and 17 more
 * all 400 (src/lib/kalshi-social.ts:141-166). Volume is TURNOVER. A market maker
 * working both sides of one book tops that list without having made a dollar.
 * Nothing in this output is evidence that a ranked trader is profitable, because
 * the venue does not publish that.
 *
 * AND ALMOST NOBODY'S TAPE IS PUBLIC. Trade visibility is opt-in. On 2026-10-04
 * exactly 2 of the top 100 were readable, and neither was in the top 50. If this
 * prints a small universe, that is the venue, not a bug — and the 98 hidden
 * traders are listed as named rejections rather than disappearing.
 *
 * ── THE RATE-LIMIT MANNERS THIS SCRIPT KEEPS ─────────────────────────────────
 * api.elections.kalshi.com/v1/social/* is free, undocumented and
 * unauthenticated. Finding the visible traders means one request per leaderboard
 * row, so the walk is SERIAL with a 120ms gap (--delay) and reads each tape
 * exactly ONCE — the intent pass is then served from what is already in memory,
 * so no trader is fetched twice.
 *
 * dragontradar.com is worse than rate-limited: ONE bad token there answers
 * 429 temporarily_blocked and locks Classic out of his own bot
 * (src/lib/dragon-tradar.ts:18-25). So: one attempt per endpoint, no retry, and
 * /stats is NOT sent if /bot/state already failed.
 */
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  fetchKalshiLeaderboard,
  fetchKalshiPublicTrades,
  normaliseTradeRow,
  resolveFill,
  summariseTrader,
  volumeDollars,
  type KalshiLeader,
  type KalshiPublicTrade,
  type PublicTradesResult,
} from "../src/lib/kalshi-social";
import {
  DEFAULT_SIGNAL_CONFIG,
  gatherCopyScan,
  type CopyScanDeps,
  type CopySignalConfig,
  type PolyTraderRef,
} from "../src/lib/copy-signals";
import { makeKalshiTickerResolver } from "../src/lib/copy-loop";
import { copyFeedLines, runCopyLane } from "../src/lib/dragon-copy";
import { readAgent, readBotState } from "../src/lib/dragon-tradar";
import { fetchTrades, scoreTraders } from "../src/lib/polymarket";
import type { CopyIntent, CopyRejection, CopyScan, TraderFill } from "../src/lib/copy-contracts";

/* ───────────────────────────────── args ─────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (n: string, d: number) => {
  const v = Number(arg(n));
  return Number.isFinite(v) && v > 0 ? v : d;
};

const KALSHI_LIMIT = Math.min(100, Math.max(1, Math.floor(num("traders", 100))));
const POLY_LIMIT = Math.min(50, Math.max(1, Math.floor(num("poly", 50))));
const FILL_PAGE = Math.min(100, Math.max(1, Math.floor(num("fills", 100))));
const DELAY_MS = Math.max(0, Math.floor(Number(arg("delay") ?? 120)));
const STATE_OUT = path.join(process.cwd(), "data", "copy-scan.json");

/* ──────────────────────────────── printing ──────────────────────────────── */

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const line = (s = "") => console.log(s);
const head = (s: string) => {
  line();
  line(s);
  line("─".repeat(Math.min(78, s.length + 8)));
};

/** Every rejection, grouped by reason, with a count — never a silent truncation. */
function printRejections(rejected: { reason: CopyRejection; detail: string }[], show: number): void {
  if (rejected.length === 0) {
    line("  (no rejections)");
    return;
  }
  const byReason = new Map<CopyRejection, string[]>();
  for (const r of rejected) {
    const list = byReason.get(r.reason) ?? [];
    list.push(r.detail);
    byReason.set(r.reason, list);
  }
  const rows = [...byReason.entries()].sort((a, b) => b[1].length - a[1].length);
  line(`  ${rejected.length} rejection(s) across ${rows.length} reason(s):`);
  for (const [reason, details] of rows) {
    line(`  ${String(details.length).padStart(4)}  ${reason}`);
    for (const d of details.slice(0, show)) line(`        · ${d}`);
    if (details.length > show) {
      line(`        · … and ${details.length - show} more with this reason (use --detail ${details.length})`);
    }
  }
}

function printIntents(intents: readonly CopyIntent[]): void {
  if (intents.length === 0) {
    line("  (no intents survived the gates)");
    return;
  }
  for (const i of intents) {
    line(
      `  ${i.venue.padEnd(10)} ${i.action.toUpperCase().padEnd(4)} ${i.count}x ` +
        `${(i.ticker ?? "(unmatched)").padEnd(34)} ${i.side.toUpperCase().padEnd(3)} ` +
        `@${String(i.priceCents).padStart(2)}c  role=${i.role.padEnd(5)} conf=${i.confidence.toFixed(3)}`,
    );
    line(`             ${i.sourceTrader} — ${i.why}`);
  }
}

/* ────────────────────────── the Kalshi social pass ──────────────────────── */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Tape = { leader: KalshiLeader; result: PublicTradesResult | null; error?: string };

/**
 * ONE pass over the leaderboard. Each tape is fetched exactly once and kept, so
 * the intent pass below costs zero further requests.
 */
async function walkKalshi(limit: number): Promise<{ leaders: KalshiLeader[]; tapes: Tape[] }> {
  const leaders = await fetchKalshiLeaderboard(limit);
  const tapes: Tape[] = [];
  for (let i = 0; i < leaders.length; i++) {
    const leader = leaders[i];
    const nick = leader.nickname.trim();
    if (leader.isAnonymous || nick === "") {
      tapes.push({ leader, result: null, error: "anonymous leaderboard row — no nickname to query" });
      continue;
    }
    if (i > 0 && DELAY_MS > 0) await sleep(DELAY_MS);
    try {
      tapes.push({ leader, result: await fetchKalshiPublicTrades(nick, FILL_PAGE) });
    } catch (e) {
      tapes.push({ leader, result: null, error: e instanceof Error ? e.message : String(e) });
    }
    if ((i + 1) % 20 === 0) process.stderr.write(`    …${i + 1}/${leaders.length} tapes read\n`);
  }
  return { leaders, tapes };
}

/** How many rows a verbatim copy of `taker_action` would have INVERTED. */
function inversionCount(rows: KalshiPublicTrade[], nickname: string): { fills: TraderFill[]; inverted: number } {
  const fills: TraderFill[] = [];
  let inverted = 0;
  for (const row of rows) {
    const fill = resolveFill(row, nickname);
    if (!fill) continue;
    fills.push(fill);
    // The money-losing bug, counted: the row says what the COUNTERPARTY did.
    if (fill.action !== row.takerAction.trim().toLowerCase()) inverted++;
  }
  return { fills, inverted };
}

/* ──────────────────── deps that serve from what we already read ─────────── */

function tapeBackedKalshiDeps(tapes: Tape[]): CopyScanDeps<KalshiPublicTrade>["kalshi"] {
  const byNick = new Map<string, PublicTradesResult>();
  for (const t of tapes) if (t.result) byNick.set(t.leader.nickname.trim(), t.result);
  return {
    leaderboard: async (limit: number) => tapes.slice(0, limit).map((t) => t.leader),
    trades: async (nickname: string) => {
      const hit = byNick.get(nickname.trim());
      if (!hit) {
        // A tape we failed to read is UNKNOWN, not hidden. Say which.
        const t = tapes.find((x) => x.leader.nickname.trim() === nickname.trim());
        throw new Error(t?.error ?? "tape was not read in this pass");
      }
      return { trades: hit.trades, visibility: hit.visibility };
    },
    resolveFill,
  };
}

async function polyDeps(limit: number): Promise<{
  deps: NonNullable<CopyScanDeps<KalshiPublicTrade>["poly"]>;
  refs: PolyTraderRef[];
}> {
  const scored = await scoreTraders();
  // `rank` means rank on the PROFIT leaderboard, so it is assigned from the 7d
  // profit order — NOT from scoreTraders' own sort, which is by priorWeeks.
  const byProfit = [...scored].sort((a, b) => b.profit7d - a.profit7d);
  const rankOf = new Map(byProfit.map((r, i) => [r.proxyWallet, i + 1]));
  const refs: PolyTraderRef[] = scored.slice(0, limit).map((r) => ({
    pseudonym: r.pseudonym,
    proxyWallet: r.proxyWallet,
    rank: rankOf.get(r.proxyWallet) ?? 0,
    profit7d: r.profit7d,
    priorWeeks: r.priorWeeks,
  }));
  return {
    deps: {
      leaderboard: async (n: number) => refs.slice(0, n),
      trades: async (wallet: string, n: number) => fetchTrades(wallet, n),
    },
    refs,
  };
}

/* ───────────────────────────── .env.local ───────────────────────────────── */

/**
 * `getKey("dragontradar_agent_token")` falls back to `process.env`, and the
 * token lives in .env.local, which a plain `tsx` process does not load (there is
 * no dotenv in this repo). So load it here — WITHOUT printing any value.
 */
async function loadEnvLocal(): Promise<string[]> {
  const loaded: string[] = [];
  try {
    const raw = await fsp.readFile(path.join(process.cwd(), ".env.local"), "utf8");
    for (const l of raw.split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      process.env[key] = m[2].trim().replace(/^["']|["']$/g, "");
      loaded.push(key);
    }
  } catch {
    // No .env.local is a normal resting state, not an error.
  }
  return loaded;
}

/* ───────────────────────────────── selftest ─────────────────────────────── */

/**
 * VERBATIM rows from the live tape of BitcoinTradingChallenge, 2026-10-04.
 * These are the regression: a verbatim copy of `taker_action` inverts the maker
 * row, and the maker row is ~80% of this trader's readable tape.
 */
const MAKER_ROW_RAW = {
  count: 301,
  count_fp: "301.52",
  create_date: "2026-10-04T18:47:36.806999Z",
  maker_nickname: "BitcoinTradingChallenge",
  market_id: "01a10689-7d45-7a38-9207-e93502d43245",
  price: 99,
  price_dollars: "0.9900",
  taker_action: "sell",
  taker_nickname: "",
  taker_side: "no",
  ticker: "KXWNBA1QWINNER-26OCT04NYATL-NY",
  trade_id: "072528c9-5f99-b3d5-dea1-0eefa2fdc4be",
};

const TAKER_ROW_RAW = {
  count: 1,
  count_fp: "1.99",
  create_date: "2026-10-04T18:41:59.127169Z",
  maker_nickname: "Unitdor",
  market_id: "01a0fdfe-edbe-764a-9cd1-f09b3770ff3c",
  price: 99,
  price_dollars: "0.9900",
  taker_action: "buy",
  taker_nickname: "BitcoinTradingChallenge",
  taker_side: "yes",
  ticker: "KXNHL2P-26OCT04WPGDET-TIE",
  trade_id: "072528dc-b359-9304-fc27-84d536cb0e86",
};

const NICK = "BitcoinTradingChallenge";

function expect(ok: boolean, what: string, got?: unknown): number {
  if (ok) {
    line(`  ok    ${what}`);
    return 0;
  }
  line(`  FAIL  ${what}${got === undefined ? "" : `  got ${JSON.stringify(got)}`}`);
  return 1;
}

async function selftest(): Promise<void> {
  // NO NETWORK. Any fetch from here on is a failure, named by URL.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    fetchCalls++;
    throw new Error(`selftest made a network call to ${String(input)} — it must not`);
  }) as unknown as typeof fetch;

  let bad = 0;
  head("SELFTEST — stubbed data, zero network");

  // ★ The pipeline leg needs a maker row whose SIDE-CORRECT price is tradeable.
  //   MAKER_ROW_RAW is a 99c YES print, so the NO side this trader held cost 1c
  //   (see kalshi-social sidePriceCents) — correctly refused by the 2-99c band.
  //   A 60c YES print puts the mirrored NO side at 40c, which keeps the
  //   maker-flip assertion about the FLIP rather than about the band.
  const maker = normaliseTradeRow({ ...MAKER_ROW_RAW, price: 60, price_dollars: "0.6000" });
  const taker = normaliseTradeRow(TAKER_ROW_RAW);
  bad += expect(maker !== null && taker !== null, "both verbatim rows map");
  if (!maker || !taker) {
    globalThis.fetch = realFetch;
    process.exit(1);
  }

  line();
  line("  THE MAKER INVERSION — the money-losing bug this lane exists to stop");
  const mf = resolveFill(maker, NICK);
  bad += expect(mf !== null, "maker row resolves");
  bad += expect(mf?.role === "maker", 'role is "maker" (maker_nickname matches)', mf?.role);
  bad += expect(mf?.side === "no", 'side is PRESERVED from taker_side: "no"', mf?.side);
  bad += expect(mf?.action === "buy", 'action is FLIPPED from taker_action "sell" -> "buy"', mf?.action);
  bad += expect(
    mf?.action !== maker.takerAction,
    `a verbatim copy would have sent ${maker.takerAction.toUpperCase()} ${maker.takerSide.toUpperCase()} — INVERTED`,
  );

  line();
  line("  THE TAKER ROW — verbatim is correct here, and must not be flipped");
  const tf = resolveFill(taker, NICK);
  bad += expect(tf?.role === "taker", 'role is "taker"', tf?.role);
  bad += expect(tf?.side === "yes" && tf?.action === "buy", "side/action pass through verbatim", tf);
  bad += expect(tf?.action === taker.takerAction, "no inversion applied to a taker row");

  line();
  line("  ROLE IS PER-TRADER, not a property of the row");
  const asUnitdor = resolveFill(taker, "Unitdor");
  bad += expect(asUnitdor?.role === "maker", "the same row is a MAKER fill for Unitdor", asUnitdor?.role);
  bad += expect(asUnitdor?.action === "sell", "and the action flips to sell", asUnitdor?.action);

  line();
  line("  REFUSALS — an undecidable row is null, never a guess");
  bad += expect(resolveFill(maker, "szg.szg") === null, "a trader on neither side resolves to null");
  const self = normaliseTradeRow({ ...MAKER_ROW_RAW, taker_nickname: NICK });
  bad += expect(self !== null && resolveFill(self, NICK) === null, "a self-trade (wash print) resolves to null");
  bad += expect(resolveFill(maker, "bitcointradingchallenge") === null, "a case variant does NOT match");

  line();
  line("  THE WHOLE PIPELINE on a stubbed tape — leaderboard -> intents -> plan");
  const stubLeaders: KalshiLeader[] = [
    { nickname: NICK, socialId: "s1", value: 111068410, rank: 67, isAnonymous: false },
    { nickname: "hidden.guy", socialId: "s2", value: 86590110, rank: 87, isAnonymous: false },
    { nickname: "", socialId: "s3", value: 2302314200, rank: 1, isAnonymous: true },
  ];
  const fresh = new Date(Date.parse("2026-10-04T18:47:36.806999Z") + 60_000).getTime();
  const cfg: CopySignalConfig = {
    ...DEFAULT_SIGNAL_CONFIG,
    priceBandCents: { min: 2, max: 99 },
    includeMakerFills: true,
  };
  const scan = await gatherCopyScan<KalshiPublicTrade>(cfg, {
    kalshi: {
      leaderboard: async () => stubLeaders,
      trades: async (nickname: string) =>
        nickname === NICK
          ? { trades: [maker, taker], visibility: "visible" }
          : { trades: [], visibility: "hidden" },
      resolveFill,
    },
    now: () => fresh,
  });
  bad += expect(scan.checked.kalshiTraders === 3, "3 leaderboard rows examined", scan.checked.kalshiTraders);
  bad += expect(scan.checked.kalshiVisible === 1, "1 visible tape", scan.checked.kalshiVisible);
  bad += expect(scan.intents.length === 2, "2 intents", scan.intents.length);
  const noBuy = scan.intents.find((i) => i.side === "no");
  bad += expect(
    noBuy?.action === "buy",
    "the maker row reached the plan as BUY NO — the flip survived the whole pipeline",
    noBuy,
  );
  bad += expect(
    scan.rejected.some((r) => r.reason === "trades_hidden"),
    "the hidden and anonymous rows are named trades_hidden, not dropped",
  );

  const run = await runCopyLane({
    intents: scan.intents,
    state: { openCopies: 0, nowMs: fresh, alreadyActed: [] },
    balanceCents: 4240,
    env: {},
    live: false,
  });
  bad += expect(run.submission.live === false, "the plan is a DRY RUN");
  bad += expect(run.submission.sentCount === 0, "nothing was sent", run.submission.sentCount);
  bad += expect(run.clearance === null, "the mode guard was never consulted (nothing to clear)");
  bad += expect(
    run.submission.outcomes.every((o) => o.disposition === "would_send"),
    "every outcome is would_send",
  );
  line(`        committed ${run.plan.committedCents}c of ${run.caps.perScanCents}c scan budget`);
  for (const l of copyFeedLines(run).slice(0, 6)) line(`        ${l}`);

  bad += expect(fetchCalls === 0, "ZERO network calls in the whole selftest", fetchCalls);
  globalThis.fetch = realFetch;

  line();
  line(bad === 0 ? `  SELFTEST PASS — 0 failures` : `  SELFTEST FAIL — ${bad} failure(s)`);
  if (bad > 0) process.exit(1);
}

/* ──────────────────────────────── the scan ──────────────────────────────── */

async function scan(): Promise<void> {
  const detail = Math.max(1, Math.floor(num("detail", 3)));
  const startedAt = new Date().toISOString();

  line();
  line("STARRA COPY SCAN — read-only. Nothing in this run can place an order.");
  line(`  ${startedAt}   kalshi top ${KALSHI_LIMIT} · polymarket top ${POLY_LIMIT} · ${DELAY_MS}ms between tape reads`);

  /* 1 + 2 — leaderboard and visibility, one pass */
  head("1. KALSHI VOLUME LEADERBOARD  (the only metric Kalshi publishes)");
  process.stderr.write(`    reading ${KALSHI_LIMIT} tapes, serial, ${DELAY_MS}ms apart…\n`);
  const { leaders, tapes } = await walkKalshi(KALSHI_LIMIT);
  line(`  ${leaders.length} rows. Volume is TURNOVER, not profit — a two-sided maker tops this list.`);
  for (const t of tapes.slice(0, 10)) {
    line(
      `  #${String(t.leader.rank).padStart(3)}  ${(t.leader.nickname || "(anonymous)").padEnd(28)} ` +
        `${usd(volumeDollars(t.leader)).padStart(16)}  ${t.result ? t.result.visibility : `UNREAD (${t.error})`}`,
    );
  }
  if (tapes.length > 10) line(`  … ${tapes.length - 10} more rows read`);

  head("2. WHO HAS A PUBLIC TAPE  (trade visibility is opt-in)");
  const visible = tapes.filter((t) => t.result && t.result.visibility === "visible");
  const hidden = tapes.filter((t) => t.result && t.result.visibility !== "visible");
  const unread = tapes.filter((t) => !t.result);
  line(`  visible ${visible.length} · hidden ${hidden.length} · unread ${unread.length} · of ${tapes.length} examined`);
  if (visible.length === 0) {
    line("  NOBODY in this slice shares their trades. The copy universe on Kalshi is empty right now.");
  }
  for (const t of visible) {
    line(
      `  VISIBLE  #${String(t.leader.rank).padStart(3)}  ${t.leader.nickname.padEnd(28)} ` +
        `${usd(volumeDollars(t.leader)).padStart(16)}  ${t.result!.trades.length} rows readable`,
    );
  }
  for (const t of unread) line(`  UNREAD   #${String(t.leader.rank).padStart(3)}  ${t.leader.nickname || "(anonymous)"} — ${t.error}`);

  /* 3 — resolved fills with the inversion applied */
  head("3. RESOLVED FILLS  (role resolved; taker_side/taker_action is the COUNTERPARTY)");
  if (visible.length === 0) line("  (nothing to resolve)");
  for (const t of visible) {
    const nick = t.leader.nickname;
    const rows = t.result!.trades;
    const { fills, inverted } = inversionCount(rows, nick);
    const s = summariseTrader(nick, rows);
    line(
      `  ${nick}: ${s.rows} rows, ${s.resolved} resolved, ${s.unresolved} refused · ` +
        `maker ${s.makerFills} / taker ${s.takerFills} (${(s.makerShare * 100).toFixed(1)}% maker) · ${s.profile}`,
    );
    line(
      `  ★ ${inverted} of ${fills.length} resolved rows (${fills.length ? ((inverted / fills.length) * 100).toFixed(1) : "0.0"}%) ` +
        `would have been INVERTED by copying taker_action verbatim.`,
    );
    for (const f of fills.slice(0, 8)) {
      line(
        `      ${f.observedAt}  ${f.role.padEnd(5)}  ${f.action.toUpperCase().padEnd(4)} ` +
          `${String(f.count).padStart(5)}x ${f.marketKey.padEnd(34)} ${f.side.toUpperCase().padEnd(3)} @${String(f.priceCents).padStart(2)}c`,
      );
    }
    if (fills.length > 8) line(`      … ${fills.length - 8} more fills`);
    line(
      `      NOTE: a MAKER fill collected the spread. Mirroring it with a market order PAYS it — ` +
        `the faithful mirror is a resting limit at the same price.`,
    );
  }

  /* 4 — Polymarket */
  head("4. POLYMARKET PROFIT LEADERBOARD + PERSISTENCE");
  const poly = await polyDeps(POLY_LIMIT);
  const persistent = poly.refs.filter((r) => r.priorWeeks >= DEFAULT_SIGNAL_CONFIG.minPolyPriorWeeks);
  line(`  ${poly.refs.length} wallets. persistence gate = priorWeeks >= ${usd(DEFAULT_SIGNAL_CONFIG.minPolyPriorWeeks)}`);
  line(`  ${persistent.length} of ${poly.refs.length} pass it.`);
  line("  priorWeeks = 30d profit minus 7d profit — what they made BEFORE this week.");
  for (const r of poly.refs.slice(0, 10)) {
    line(
      `  #${String(r.rank).padStart(3)}  ${(r.pseudonym || r.proxyWallet).padEnd(26)} ` +
        `7d ${usd(r.profit7d).padStart(14)}   prior ${usd(r.priorWeeks).padStart(14)}  ` +
        `${r.priorWeeks >= DEFAULT_SIGNAL_CONFIG.minPolyPriorWeeks ? "persistent" : "one hot week"}`,
    );
  }
  if (poly.refs.length > 10) line(`  … ${poly.refs.length - 10} more`);

  /* 5 — intents and every rejection */
  head("5. COPY INTENTS + EVERY REJECTION, GROUPED");
  const signalCfg: CopySignalConfig = {
    ...DEFAULT_SIGNAL_CONFIG,
    kalshiTraderLimit: KALSHI_LIMIT,
    polyTraderLimit: POLY_LIMIT,
  };
  // The Kalshi half is served from the tapes ALREADY read — zero extra requests.
  // ★ The Polymarket -> Kalshi ticker resolver. Without it every Polymarket
  //   intent carries ticker=null and the router drops it as `no_ticker`, because
  //   Dragon Tradar executes on Kalshi only. It goes through matchOutcomeGuarded,
  //   so a point-spread bet can never resolve onto a game-winner market.
  //   Markets are fetched once per series and cached inside the resolver.
  const resolveKalshiTicker = makeKalshiTickerResolver();
  const result: CopyScan = await gatherCopyScan<KalshiPublicTrade>(signalCfg, {
    kalshi: tapeBackedKalshiDeps(tapes),
    poly: poly.deps,
    resolveKalshiTicker,
  });
  line(
    `  checked: kalshi ${result.checked.kalshiTraders} traders / ${result.checked.kalshiVisible} visible · ` +
      `polymarket ${result.checked.polyTraders} wallets`,
  );
  line(
    `  gates: age <= ${signalCfg.maxSignalAgeMin}m · count >= ${signalCfg.minCount} · ` +
      `price ${signalCfg.priceBandCents.min}-${signalCfg.priceBandCents.max}c · ` +
      `makerFills ${signalCfg.includeMakerFills ? "INCLUDED" : "excluded"} · max ${signalCfg.maxIntentsPerTrader}/trader`,
  );
  line();
  line(`  ${result.intents.length} INTENT(S):`);
  printIntents(result.intents);
  line();
  printRejections(result.rejected, detail);

  /* 6 — Dragon Tradar */
  head("6. DRAGON TRADAR BOT STATE  (one attempt per endpoint, no retry)");
  let balanceCents: number | undefined;
  let botMinBetCents: number | undefined;
  let openCopies = 0;
  if (flag("no-dragon")) {
    line("  skipped (--no-dragon)");
  } else {
    const loaded = await loadEnvLocal();
    line(`  env: loaded ${loaded.length} name(s) from .env.local (values never printed)`);
    // 30s rather than the module's 10s default. A read-only scan can afford to
    // wait, and it removes the timeout as a possible cause of a failed read.
    const dragonDeps = { timeoutMs: Math.max(1_000, Math.floor(num("dragon-timeout", 30_000))) };

    // ── THE ONE NARROW EXCEPTION TO "ONE ATTEMPT, NO RETRY" ──────────────────
    // `status: 0` is the ONLY state that means NO HTTP RESPONSE ARRIVED:
    // src/lib/dragon-tradar.ts maps 429 -> "blocked", 401/403 -> "rejected", and
    // any other response -> "error" with its real status, BEFORE the catch that
    // produces 0. So a 0 proves his server never evaluated the token — which is
    // exactly the thing the no-retry rule exists to protect. Retrying a 0 cannot
    // be a bad-token retry, and it is allowed ONCE, here, in a read-only script.
    // Any other state is final and is NOT retried.
    //
    // MEASURED 2026-10-04: a full scan got status 0 from this endpoint after
    // ~150 HTTPS requests to two other hosts in the same process, while DNS
    // resolved, TCP 443 connected, and a FRESH process read the same endpoint in
    // 263ms. So it was transport-level and transient. I could not establish the
    // mechanism — it is NOT a cold start, because the host answers in 263ms.
    let st = await readBotState(dragonDeps);
    if (st.state === "error" && st.status === 0) {
      line("  GET /bot/state -> no response reached us (status 0). Retrying ONCE — a 0 means his");
      line("  server never saw the token, so this is not the retry the 429 lockout rule forbids.");
      st = await readBotState(dragonDeps);
    }
    if (st.state !== "ok") {
      const extra = st.state === "error" ? ` status=${st.status}${st.code ? ` code=${st.code}` : ""}` : "";
      line(`  GET /bot/state -> ${st.state}${extra}`);
      line("  NOT sending GET /stats: one bad token here answers 429 and locks him out of his own bot.");
      if (st.state === "error" && st.status === 0) {
        line("  (status 0 = no HTTP response. Nothing was rejected; the request never landed.)");
      }
    } else {
      const c = st.stats.config ?? {};
      line(
        `  GET /bot/state -> ok   running=${st.stats.running}  mode=${st.stats.mode}  ` +
          `category=${st.stats.category}  lastScanAt=${st.stats.lastScanAt ?? "null"}`,
      );
      line(
        `    autoFire=${String(c["autoFire"])}  minBetCents=${String(c["minBetCents"])}  ` +
          `scanIntervalMin=${String(c["scanIntervalMin"])}  dailyLossFloorCents=${String(c["dailyLossFloorCents"])}`,
      );
      if (c["autoFire"] === true) {
        line("    ★ autoFire is TRUE. Harmless in paper mode; a flip to live would fire with no human in the way.");
      }
      if (st.stats.running === true) {
        line("    ★ his own scanner is RUNNING — the copy lane REFUSES to go live against a bankroll another engine is already sizing.");
      }
      const stats = await readAgent(dragonDeps);
      if (stats.state !== "ok") {
        const extra =
          stats.state === "error" ? ` status=${stats.status}${stats.code ? ` code=${stats.code}` : ""}` : "";
        line(`  GET /stats -> ${stats.state}${extra}`);
      } else {
        balanceCents = stats.stats.balanceCents;
        openCopies = stats.stats.positions.length;
        line(
          `  GET /stats -> ok   connected=${stats.stats.connected}  balance=${usd(balanceCents / 100)}  ` +
            `positions=${openCopies}`,
        );
        const minBet = Number(st.stats.config?.["minBetCents"] ?? 0);
        if (Number.isFinite(minBet) && minBet > 0) botMinBetCents = minBet;
        if (minBet > 0) {
          line(`    that is ${Math.floor(balanceCents / minBet)} minimum-size bet(s) at ${usd(minBet / 100)} each.`);
        }
      }
    }
  }

  /* 7 — the dry-run plan */
  head("7. DRY-RUN PLAN  (live:false — dragon-copy makes ZERO network calls here)");
  // ★ His bot's OWN minimum bet, taken from the state read above — never guessed.
  //   An entry under it is refused as `below_bot_min_bet` instead of being POSTed
  //   to find out whether his app rejects it or silently sizes it up.
  const run = await runCopyLane({
    intents: result.intents,
    state: { openCopies, nowMs: Date.now(), alreadyActed: [] },
    balanceCents,
    botMinBetCents,
    live: false,
  });
  line(
    `  caps: perOrder ${run.caps.perOrderCents}c · perScan ${run.caps.perScanCents}c · ` +
      `maxOpenCopies ${run.caps.maxOpenCopies} · makerFills ${run.caps.allowMakerFills ? "allowed" : "refused"}`,
  );
  line(`  committed ${run.plan.committedCents}c (${usd(run.plan.committedCents / 100)}) of ${run.caps.perScanCents}c budget`);
  line(`  would send ${run.plan.accepted.length} order(s); routing dropped ${run.plan.rejected.length}`);
  for (const o of run.submission.outcomes) {
    const p = run.plan.provenance[o.clientOrderId];
    line(
      `    WOULD SEND  ${o.body.action.toUpperCase().padEnd(4)} ${o.body.count}x ${o.body.ticker} ` +
        `${o.body.side.toUpperCase()} @${o.body.priceCents}c  = ${o.notionalCents}c   ` +
        `clientOrderId=${o.clientOrderId}`,
    );
    if (p) line(`                ${p.venue}:${p.sourceTrader} role=${p.role} conf=${p.confidence.toFixed(3)}`);
  }
  if (run.plan.rejected.length > 0) {
    line("  routing rejections:");
    const byReason = new Map<string, number>();
    for (const r of run.plan.rejected) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    for (const [reason, n] of [...byReason.entries()].sort((a, b) => b[1] - a[1])) {
      line(`    ${String(n).padStart(4)}  ${reason}`);
      for (const r of run.plan.rejected.filter((x) => x.reason === reason).slice(0, 2)) {
        line(`          · ${r.detail}`);
      }
    }
  }
  line();
  line(`  NOTHING WAS SENT. sentCount=${run.submission.sentCount}, live=${run.submission.live}.`);

  /* a cache the voice lane can READ without doing the walk mid-call */
  const snapshot = {
    scannedAt: result.scannedAt,
    kalshi: {
      examined: result.checked.kalshiTraders,
      visible: result.checked.kalshiVisible,
      visibleNicknames: visible.map((t) => t.leader.nickname),
    },
    polymarket: { examined: result.checked.polyTraders, persistent: persistent.length },
    intents: result.intents.length,
    rejections: result.rejected.length,
    plan: {
      accepted: run.plan.accepted.length,
      committedCents: run.plan.committedCents,
      perScanCents: run.caps.perScanCents,
    },
    dragon: { balanceCents: balanceCents ?? null, openPositions: openCopies },
  };
  await fsp.mkdir(path.dirname(STATE_OUT), { recursive: true });
  await fsp.writeFile(STATE_OUT, JSON.stringify(snapshot, null, 2));
  line(`  snapshot written to ${STATE_OUT} (so the voice lane can answer without re-walking).`);
  line();
}

/* ─────────────────────────────────── main ───────────────────────────────── */

(async () => {
  if (flag("selftest")) {
    await selftest();
    return;
  }
  await scan();
})().catch((e) => {
  console.error(`\n  scan failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
