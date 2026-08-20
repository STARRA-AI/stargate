import { pushFeed } from "@/lib/feed";
import { fetchPortfolio, fetchWatchlist, type WatchMarket } from "@/lib/kalshi";
import { readAgent } from "@/lib/dragon-tradar";

export const runtime = "nodejs";

type Cache = {
  at: number;
  watchlist: WatchMarket[];
};

const g = globalThis as unknown as { __dragonCache?: Cache };
const TTL_MS = 60_000;

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
  // see the landmine note in lib/dragon-tradar.ts.
  const [portfolio, bot] = await Promise.all([fetchPortfolio(), readAgent()]);

  if (bot.state === "blocked") {
    pushFeed("ALERT", "Dragon Tradar throttled the agent token (429) — backing off, not retrying");
  } else if (bot.state === "rejected") {
    pushFeed("ALERT", "Dragon Tradar rejected the agent token — regenerate it in Settings → AI Trading Agent");
  }

  return Response.json({
    watchlist,
    portfolio,
    bot,
    source: "kalshi.com public market data + dragontradar.com agent API",
  });
}
