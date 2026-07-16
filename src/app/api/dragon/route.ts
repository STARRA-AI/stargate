import { pushFeed } from "@/lib/feed";
import { fetchPortfolio, fetchWatchlist, type WatchMarket } from "@/lib/kalshi";

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

  const portfolio = await fetchPortfolio();

  return Response.json({
    watchlist,
    portfolio,
    source: "kalshi.com public market data",
  });
}
