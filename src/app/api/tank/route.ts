import { getTank } from "@/lib/tank";
import type { WatchMarket } from "@/lib/kalshi";

export const runtime = "nodejs";

type DragonCache = { at: number; watchlist: WatchMarket[] };

export async function GET() {
  // Reuse the Dragon watchlist cache so the tank votes on a real market.
  const dragon = (globalThis as unknown as { __dragonCache?: DragonCache })
    .__dragonCache;
  const top =
    dragon?.watchlist?.slice().sort((a, b) => b.volume - a.volume)[0] ?? null;

  const tank = getTank(top);
  return Response.json(tank);
}
