import { pushFeed } from "@/lib/feed";
import { fetchPortfolio, fetchWatchlist, type WatchMarket } from "@/lib/kalshi";
import { readAgent, readPositions, readBotState, readPerformance } from "@/lib/dragon-tradar";
import { sweepState, type SweepMarks } from "@/lib/dragon-sweep";

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

function envCents(name: keyof typeof SWEEP_ENV_DEFAULTS): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isNaN(n) || n < 0 ? SWEEP_ENV_DEFAULTS[name] : n;
}

/** Classic's sweep thresholds. No store yet — env is the source until one exists. */
export function readSweepMarks(): SweepMarks {
  return {
    targetCents: envCents("DRAGON_SWEEP_TARGET_CENTS"),
    keepWorkingCents: envCents("DRAGON_SWEEP_KEEP_WORKING_CENTS"),
    lastSweepAtRealizedCents: envCents("DRAGON_SWEEP_LAST_MARK_CENTS"),
  };
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
  const [portfolio, bot, positions, botState, performance] = await Promise.all([
    fetchPortfolio(),
    readAgent(),
    readPositions(),
    readBotState(),
    readPerformance(),
  ]);

  // One alert per request, not one per failing read — several bad reads off
  // the same bad token would otherwise spam identical lines into his ops feed.
  const agentReads = [bot, positions, botState, performance];
  if (agentReads.some((r) => r.state === "blocked")) {
    pushFeed("ALERT", "Dragon Tradar throttled the agent token (429) — backing off, not retrying");
  } else if (agentReads.some((r) => r.state === "rejected")) {
    pushFeed("ALERT", "Dragon Tradar rejected the agent token — regenerate it in Settings → AI Trading Agent");
  }

  // Never synthesize a sweep number off data that never arrived.
  const sweep =
    performance.state === "ok" ? sweepState(performance.stats, readSweepMarks()) : null;

  return Response.json({
    watchlist,
    portfolio,
    bot,
    positions,
    botState,
    performance,
    sweep,
    source: "kalshi.com public market data + dragontradar.com agent API",
  });
}
