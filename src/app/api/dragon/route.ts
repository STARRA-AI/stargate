import { pushFeed } from "@/lib/feed";
import { fetchPortfolio, fetchWatchlist, type WatchMarket } from "@/lib/kalshi";
import {
  readAgent,
  readPositions,
  readOrders,
  readBotState,
  readPerformance,
  type AgentResult,
  type AgentPerformance,
} from "@/lib/dragon-tradar";
import { sweepState, type SweepMarks, type SweepState } from "@/lib/dragon-sweep";

export const runtime = "nodejs";

type Cache = {
  at: number;
  watchlist: WatchMarket[];
};

const g = globalThis as unknown as { __dragonCache?: Cache };
const TTL_MS = 60_000;

/** Documented env defaults — a typo/unset var falls back, never produces a garbage sweep number. */
const SWEEP_ENV_DEFAULTS = {
  DRAGON_SWEEP_TARGET_CENTS: 2_500_000,
  DRAGON_SWEEP_KEEP_WORKING_CENTS: 0,
  DRAGON_SWEEP_LAST_MARK_CENTS: 0,
} as const;

function envCents(
  name: keyof typeof SWEEP_ENV_DEFAULTS,
  env: Record<string, string | undefined>,
): number {
  const n = Number.parseInt(env[name] ?? "", 10);
  return Number.isNaN(n) || n < 0 ? SWEEP_ENV_DEFAULTS[name] : n;
}

/**
 * Classic's sweep thresholds. No store yet — env is the source until one
 * exists. `env` defaults to `process.env` but is a parameter so a test can
 * pass `{}` or a typo'd value without touching global state.
 */
export function readSweepMarks(env: Record<string, string | undefined> = process.env): SweepMarks {
  return {
    targetCents: envCents("DRAGON_SWEEP_TARGET_CENTS", env),
    keepWorkingCents: envCents("DRAGON_SWEEP_KEEP_WORKING_CENTS", env),
    lastSweepAtRealizedCents: envCents("DRAGON_SWEEP_LAST_MARK_CENTS", env),
  };
}

type ReadState = AgentResult<unknown>["state"];

/**
 * Exactly one alert line for however many agent reads failed —
 * never one per read, so a bad token doesn't spam identical lines into his
 * ops feed. `blocked` (429, back off) takes precedence over `rejected`
 * (401/403, regenerate the token), matching the original single-read check.
 * `null` means nothing worth reporting.
 */
export function agentAlertMessage(states: ReadState[]): string | null {
  if (states.some((s) => s === "blocked")) {
    return "Dragon Tradar throttled the agent token (429) — backing off, not retrying";
  }
  if (states.some((s) => s === "rejected")) {
    return "Dragon Tradar rejected the agent token — regenerate it in Settings → AI Trading Agent";
  }
  return null;
}

/** `sweep` is null unless performance actually loaded — never a synthesised zero. */
export function computeSweep(
  performance: AgentResult<AgentPerformance>,
  marks: SweepMarks,
): SweepState | null {
  return performance.state === "ok" ? sweepState(performance.stats, marks) : null;
}

export async function GET() {
  const now = Date.now();
  let watchlist = g.__dragonCache?.watchlist ?? [];

  if (!g.__dragonCache || now - g.__dragonCache.at > TTL_MS) {
    try {
      watchlist = await fetchWatchlist();
      g.__dragonCache = { at: now, watchlist };
      if (watchlist.length) {
        pushFeed("SCAN", `Kalshi uplink — ${watchlist.length} live markets refreshed`);
      }
    } catch {
      // keep stale data if refresh fails
    }
  }

  // His bot's own view, straight from dragontradar.com. Fetched alongside the
  // Kalshi read, never in front of it: if his app is down or the token is gone,
  // `bot.state` says so and the market data still lands. NOT retried on 429 —
  // see the landmine note in lib/dragon-tradar.ts. Every agent read degrades
  // independently — one failing field never blanks the others, and none of
  // them can throw out of this route.
  //
  // `orders` is read alongside `positions` on purpose: a position is a FILLED
  // order, so without this she can only answer "what does he hold", never
  // "what is resting on the book right now" — and a resting bid is money
  // already committed. Five concurrent reads share one Bearer token; if his
  // app ever throttles that burst the answer is `blocked`, reported once,
  // never retried.
  const [portfolio, bot, positions, orders, botState, performance] = await Promise.all([
    fetchPortfolio(),
    readAgent(),
    readPositions(),
    readOrders(),
    readBotState(),
    readPerformance(),
  ]);

  // One alert per request, not one per failing read — several bad reads off
  // the same bad token would otherwise spam identical lines into his ops feed.
  const alert = agentAlertMessage([
    bot.state,
    positions.state,
    orders.state,
    botState.state,
    performance.state,
  ]);
  if (alert) pushFeed("ALERT", alert);

  // Never synthesize a sweep number off data that never arrived.
  const sweep = computeSweep(performance, readSweepMarks());

  return Response.json({
    watchlist,
    portfolio,
    bot,
    positions,
    orders,
    botState,
    performance,
    sweep,
    source: "kalshi.com public market data + dragontradar.com agent API",
  });
}
