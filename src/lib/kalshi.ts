import crypto from "crypto";
import { getKey } from "@/lib/keys";

/**
 * Kalshi market data. Public endpoints need no auth; portfolio endpoints
 * use the operator's API key ID + RSA private key (LINK API in settings).
 */

const BASE = "https://api.elections.kalshi.com";

// Series the operator cares about — macro, crypto, AI. Highest-volume
// live market is pulled from each.
const WATCH_SERIES = [
  "KXBTCMAXY",
  "KXFEDDECISION",
  "KXCPIYOY",
  "KXETHMAXY",
];

export type WatchMarket = {
  ticker: string;
  title: string;
  subtitle: string;
  lastCents: number;
  volume: number;
};

type KalshiMarket = {
  ticker?: string;
  title?: string;
  yes_sub_title?: string;
  last_price_dollars?: string;
  volume_fp?: string;
};

type KalshiEvent = {
  title?: string;
  markets?: KalshiMarket[];
};

function fp(v: string | undefined): number {
  const n = parseFloat(v ?? "0");
  return Number.isFinite(n) ? n : 0;
}

export async function fetchWatchlist(): Promise<WatchMarket[]> {
  const results = await Promise.allSettled(
    WATCH_SERIES.map(async (series) => {
      const res = await fetch(
        `${BASE}/trade-api/v2/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=1`,
        { signal: AbortSignal.timeout(8000), cache: "no-store" },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { events?: KalshiEvent[] };
      const event = data.events?.[0];
      if (!event?.markets?.length) return null;

      // Most-traded market with a live (non-degenerate) price.
      const markets = [...event.markets].sort(
        (a, b) => fp(b.volume_fp) - fp(a.volume_fp),
      );
      const pick =
        markets.find((m) => {
          const p = fp(m.last_price_dollars);
          return p >= 0.03 && p <= 0.97;
        }) ?? markets[0];

      return {
        ticker: pick.ticker ?? series,
        title: event.title ?? series,
        subtitle: pick.yes_sub_title ?? "",
        lastCents: Math.round(fp(pick.last_price_dollars) * 100),
        volume: Math.round(fp(pick.volume_fp)),
      } satisfies WatchMarket;
    }),
  );

  return results
    .filter(
      (r): r is PromiseFulfilledResult<WatchMarket> =>
        r.status === "fulfilled" && r.value !== null,
    )
    .map((r) => r.value);
}

function signKalshi(privateKeyPem: string, message: string): string {
  const sign = crypto.sign("sha256", Buffer.from(message, "utf8"), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sign.toString("base64");
}

async function kalshiAuthed(path: string) {
  const keyId = await getKey("kalshi_key_id");
  const privateKey = await getKey("kalshi_private_key");
  if (!keyId || !privateKey) return null;

  const ts = Date.now().toString();
  const signature = signKalshi(privateKey, `${ts}GET${path}`);
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": ts,
    },
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Kalshi ${path} → ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

export type Portfolio = {
  linked: boolean;
  balanceDollars?: number;
  positions?: {
    ticker: string;
    side: "YES" | "NO";
    quantity: number;
    exposureDollars: number;
  }[];
  error?: string;
};

export async function fetchPortfolio(): Promise<Portfolio> {
  const keyId = await getKey("kalshi_key_id");
  const privateKey = await getKey("kalshi_private_key");
  if (!keyId || !privateKey) return { linked: false };

  try {
    const [bal, pos] = await Promise.all([
      kalshiAuthed("/trade-api/v2/portfolio/balance"),
      kalshiAuthed("/trade-api/v2/portfolio/positions"),
    ]);

    const balanceCents = Number(
      (bal as { balance?: number })?.balance ?? 0,
    );
    const rawPositions =
      ((pos as { market_positions?: unknown[] })?.market_positions as {
        ticker?: string;
        position?: number;
        market_exposure?: number;
      }[]) ?? [];

    return {
      linked: true,
      balanceDollars: balanceCents / 100,
      positions: rawPositions
        .filter((p) => (p.position ?? 0) !== 0)
        .slice(0, 6)
        .map((p) => ({
          ticker: p.ticker ?? "?",
          side: (p.position ?? 0) > 0 ? "YES" : "NO",
          quantity: Math.abs(p.position ?? 0),
          exposureDollars: Math.abs(p.market_exposure ?? 0) / 100,
        })),
    };
  } catch (err) {
    return {
      linked: true,
      error: err instanceof Error ? err.message : "portfolio fetch failed",
    };
  }
}
