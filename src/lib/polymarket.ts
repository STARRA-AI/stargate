/**
 * Polymarket leaderboard + trade tape. All endpoints are public and need no
 * key — this reads who is winning and exactly what they bought.
 *
 * Used as the SIGNAL side of the copy-trade loop; execution happens on Kalshi
 * (see src/lib/kalshi.ts). Background: docs/reference/KALSHI_COMBOS.md and the
 * polymarket-copytrade-substrate memory.
 */

const LB = "https://lb-api.polymarket.com";
const DATA = "https://data-api.polymarket.com";

// ★ lb-api rejects a default Node/python User-Agent with 403. It wants
//   something browser-shaped. data-api does not care, but sending it to both
//   costs nothing and stops this from being a silent, confusing failure.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`polymarket ${url} → ${res.status}`);
  return (await res.json()) as T;
}

export type LeaderRow = { proxyWallet: string; pseudonym: string; amount: number };

/** Windows the API actually accepts. Anything else returns 400 "invalid request". */
export type Window = "1d" | "7d" | "30d" | "all";

/**
 * Top traders by realised profit for a window.
 * ★ `limit` is HARD-CAPPED at 50 server-side — asking for 100 returns 50.
 */
export async function fetchLeaderboard(window: Window, limit = 50): Promise<LeaderRow[]> {
  const rows = await get<LeaderRow[]>(`${LB}/profit?window=${window}&limit=${Math.min(limit, 50)}`);
  return rows.map((r) => ({
    proxyWallet: r.proxyWallet,
    pseudonym: r.pseudonym || r.proxyWallet.slice(0, 10),
    amount: Number(r.amount) || 0,
  }));
}

export type PolyTrade = {
  wallet: string;
  side: "BUY" | "SELL";
  outcome: string;
  title: string;
  /**
   * ★ The market-type signal, and the reason this field exists.
   *
   * `outcome` is only ever a competitor name: a POINT-SPREAD bet on
   * "Spread: Bills (-6.5)" arrives as `outcome: "Patriots"`. Matching on that
   * name alone finds the Kalshi MONEYLINE and buys "Patriots win outright" —
   * a different, less likely event, at a cheaper price that reads as free edge.
   * The slug is the only field that states the kind outright:
   * `nfl-ne-buf-2026-10-04-spread-home-6pt5` (observed live 2026-10-04 on the
   * #1 profit wallet). Feed it to classifyPolyMarket/matchOutcomeGuarded in
   * copy-match.ts BEFORE any name matching.
   *
   * Optional because the field is absent on some rows; a missing slug must
   * classify as "other" and be skipped, never guessed into a moneyline.
   */
  slug?: string;
  price: number;
  size: number;
  timestamp: number;
  conditionId: string;
};

type RawActivity = {
  type?: string;
  side?: string;
  outcome?: string;
  title?: string;
  /** Present on the live feed; see PolyTrade.slug for why it is load-bearing. */
  slug?: string;
  price?: number;
  size?: number;
  timestamp?: number;
  conditionId?: string;
};

/**
 * One trader's recent activity, filtered to real TRADEs.
 *
 * ★ The feed also carries REDEEM, MAKER_REBATE and TAKER_REBATE. Rebates are
 *   market-making income, not a directional opinion — copying them is
 *   meaningless, and on the top wallet they were a large share of "profit".
 */
export async function fetchTrades(wallet: string, limit = 100): Promise<PolyTrade[]> {
  const raw = await get<RawActivity[]>(`${DATA}/activity?user=${wallet}&limit=${limit}`);
  return raw
    .filter((r) => r.type === "TRADE")
    .map((r) => ({
      wallet,
      side: (r.side === "SELL" ? "SELL" : "BUY") as "BUY" | "SELL",
      outcome: r.outcome ?? "",
      title: r.title ?? "",
      slug: typeof r.slug === "string" && r.slug !== "" ? r.slug : undefined,
      price: Number(r.price) || 0,
      size: Number(r.size) || 0,
      timestamp: Number(r.timestamp) || 0,
      conditionId: r.conditionId ?? "",
    }));
}

/**
 * Collapse a burst of fills into the ORDER that caused them.
 *
 * Top wallets' fills arrive as many small clips at one price — three $5 prints
 * are one $15 intent, not three signals.
 *
 * ★ The bucket is ONE MINUTE, not one second: `timestamp` is in unix SECONDS and
 *   the key divides it by 60. (This comment previously said "second", which did
 *   not match the code.) A minute is the wider, safer choice here — it collapses
 *   a slow iceberg fill that a per-second bucket would emit as a dozen signals.
 *   dragon-orders.ts newClientOrderId buckets per SECOND; the two are
 *   deliberately different and must not be "aligned" without a reason.
 */
export function aggregateFills(trades: PolyTrade[]): PolyTrade[] {
  const byKey = new Map<string, PolyTrade>();
  for (const t of trades) {
    const key = `${t.conditionId}|${t.outcome}|${t.side}|${t.price.toFixed(3)}|${Math.floor(t.timestamp / 60)}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.size += t.size;
      // Keep the first non-empty slug: every clip in a bucket shares one market,
      // and dropping it would strip the gate's input (see PolyTrade.slug).
      if (!prev.slug && t.slug) prev.slug = t.slug;
    } else byKey.set(key, { ...t });
  }
  return [...byKey.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export type ScoredTrader = LeaderRow & {
  profit7d: number;
  profit30d: number;
  /** 30d minus 7d — what they earned BEFORE this week. The persistence test. */
  priorWeeks: number;
  persistent: boolean;
};

/**
 * Rank traders by whether they were winning BEFORE this week.
 *
 * ★ THE MEASUREMENT THAT MATTERS (2026-09-04): of the 21 wallets clearing
 *   $100k in the 7d window, ZERO had meaningful profit in the prior three
 *   weeks — several were deeply negative. Ranking on the raw weekly
 *   leaderboard is ranking on one hot streak. `priorWeeks` is the correction:
 *   it asks what they made in the ~23 days before the current week.
 *
 * Note the 30d figure is only available for wallets inside the 30d top 50; a
 * wallet missing from it gets profit30d 0, which correctly fails the test
 * rather than silently passing.
 */
export async function scoreTraders(minPriorWeeks = 0): Promise<ScoredTrader[]> {
  const [d7, d30] = await Promise.all([fetchLeaderboard("7d"), fetchLeaderboard("30d")]);
  const by30 = new Map(d30.map((r) => [r.proxyWallet, r.amount]));

  return d7
    .map((r) => {
      const profit30d = by30.get(r.proxyWallet) ?? 0;
      const priorWeeks = profit30d - r.amount;
      return {
        ...r,
        profit7d: r.amount,
        profit30d,
        priorWeeks,
        persistent: priorWeeks >= minPriorWeeks && profit30d > 0,
      };
    })
    .sort((a, b) => b.priorWeeks - a.priorWeeks);
}
