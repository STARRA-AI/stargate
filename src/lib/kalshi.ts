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

// A PEM that has lost its line breaks is not decodable by OpenSSL — node throws
// ERR_OSSL_UNSUPPORTED ("DECODER routines::unsupported") before it ever signs.
// data/keys.json stores kalshi_private_key as ONE line (verified 2026-09-04), so
// every authenticated call in this file threw until this ran. Rewrap the base64
// body at 64 columns, which is what the PEM grammar actually requires. A key that
// already has its newlines passes through untouched.
export function normalisePem(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----$/);
  if (!m) return t;
  const body = m[2].replace(/\s+/g, "");
  const wrapped = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${m[1]}-----\n${wrapped.join("\n")}\n-----END ${m[1]}-----\n`;
}

function signKalshi(privateKeyPem: string, message: string): string {
  const sign = crypto.sign("sha256", Buffer.from(message, "utf8"), {
    key: normalisePem(privateKeyPem),
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sign.toString("base64");
}

/**
 * One authenticated Kalshi request. GET by default; pass a body to POST/DELETE.
 *
 * ★ The signature covers the path WITHOUT its query string — Kalshi's docs are
 * explicit: "if your request is to /trade-api/v2/portfolio/orders?limit=5, sign
 * only /trade-api/v2/portfolio/orders". Signing the full URL yields a 401 that
 * looks exactly like a bad key.
 */
async function kalshiAuthed(
  path: string,
  init?: { method?: "GET" | "POST" | "DELETE"; body?: unknown },
) {
  const keyId = await getKey("kalshi_key_id");
  const privateKey = await getKey("kalshi_private_key");
  if (!keyId || !privateKey) return null;

  const method = init?.method ?? "GET";
  const ts = Date.now().toString();
  const signedPath = path.split("?")[0];
  const signature = signKalshi(privateKey, `${ts}${method}${signedPath}`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "KALSHI-ACCESS-KEY": keyId,
      "KALSHI-ACCESS-SIGNATURE": signature,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  if (!res.ok) {
    // Carry Kalshi's own message — "insufficient balance on exchange 1" and
    // "bad signature" are different fixes and must not collapse to one string.
    const detail = await res.text().catch(() => "");
    throw new Error(`Kalshi ${method} ${signedPath} → ${res.status} ${detail.slice(0, 300)}`);
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
    // ★ V2 field names, verified against a live response 2026-09-04. This used
    // to read `position` and `market_exposure` (integer cents) — neither field
    // exists, so every position came back undefined, was filtered out as zero,
    // and the deck reported an empty book while real exposure was open.
    // What Kalshi actually sends: position_fp is a fixed-point STRING, and
    // market_exposure_dollars is already DOLLARS (do not divide by 100).
    const rawPositions =
      ((pos as { market_positions?: unknown[] })?.market_positions as {
        ticker?: string;
        position_fp?: string;
        market_exposure_dollars?: string;
        realized_pnl_dollars?: string;
      }[]) ?? [];

    const num = (v: string | undefined) => {
      const n = parseFloat(v ?? "0");
      return Number.isFinite(n) ? n : 0;
    };

    return {
      linked: true,
      balanceDollars: balanceCents / 100,
      positions: rawPositions
        .filter((p) => num(p.position_fp) !== 0)
        .slice(0, 6)
        .map((p) => ({
          ticker: p.ticker ?? "?",
          side: num(p.position_fp) > 0 ? "YES" : "NO",
          quantity: Math.abs(num(p.position_fp)),
          exposureDollars: Math.abs(num(p.market_exposure_dollars)),
        })),
    };
  } catch (err) {
    return {
      linked: true,
      error: err instanceof Error ? err.message : "portfolio fetch failed",
    };
  }
}

// ── exchange shards ────────────────────────────────────────────────────────
// Kalshi split trading across separate matching engines and holds COLLATERAL
// PER SHARD: "Programmatic traders must preallocate collateral on a given
// exchange shard before order placement" (docs.kalshi.com/getting_started/
// exchange_sharding). Combos moved to shard 1 on 2026-08-17. An account with
// its whole balance on shard 0 cannot fill a combo — the order is accepted and
// simply never fills, which reads as "it never showed up in my wallet".
// Full write-up: docs/reference/KALSHI_COMBOS.md
export const KALSHI_SHARDS = {
  0: "Default",
  1: "Combos",
  2: "Crypto",
  3: "Tennis & Baseball",
} as const;

export type ShardBalance = { exchangeIndex: number; label: string; dollars: number };

/** Per-shard balance breakdown. This is the read that reveals an unfundable combo. */
export async function fetchShardBalances(): Promise<ShardBalance[] | null> {
  const bal = await kalshiAuthed("/trade-api/v2/portfolio/balance");
  if (!bal) return null;
  const rows =
    ((bal as { balance_breakdown?: { balance?: string; exchange_index?: number }[] })
      .balance_breakdown) ?? [];
  return rows.map((r) => {
    const idx = r.exchange_index ?? 0;
    return {
      exchangeIndex: idx,
      label: KALSHI_SHARDS[idx as keyof typeof KALSHI_SHARDS] ?? `shard ${idx}`,
      dollars: Number(r.balance ?? 0),
    };
  });
}

/**
 * Set the standing split of collateral across shards, so the combo shard stops
 * being empty. Kalshi recomputes every 10s (balance minus resting orders) and
 * transfers on your behalf to restore the target.
 *
 * ★ The field is `percent`, NOT `percentage`, and the values must total exactly
 * 100. An empty array disables rebalancing entirely.
 */
export async function setTargetAllocation(
  allocations: { exchangeIndex: number; percent: number }[],
): Promise<boolean> {
  const total = allocations.reduce((n, a) => n + a.percent, 0);
  if (allocations.length > 0 && total !== 100) {
    throw new Error(`allocation must total 100, got ${total}`);
  }
  const res = await kalshiAuthed("/trade-api/v2/portfolio/target_balance_allocation", {
    method: "POST",
    body: {
      allocations: allocations.map((a) => ({
        exchange_index: a.exchangeIndex,
        percent: a.percent,
      })),
    },
  });
  return res !== null;
}

// ── orders ─────────────────────────────────────────────────────────────────
export type KalshiOrder = {
  ticker: string;
  /** bid = buy YES, ask = sell YES. Kalshi V2 quotes everything from the YES side. */
  side: "bid" | "ask";
  /** Whole contracts. Serialised as a fixed-point string, which V2 requires. */
  count: number;
  /** Dollars per contract, 0.01–0.99. Serialised to 4dp, which V2 requires. */
  priceDollars: number;
  clientOrderId?: string;
  /** Omit to let Kalshi auto-route by ticker — safer than hardcoding a shard. */
  exchangeIndex?: number;
};

/**
 * Place one order on the V2 endpoint. The legacy /portfolio/orders path is on a
 * deprecation clock ("no earlier than May 6, 2026" per Kalshi's docs) and takes
 * a DIFFERENT shape — yes/no sides and integer cents — so the two are not
 * interchangeable.
 *
 * ★ Acceptance here is NOT a fill. Confirm with fetchPortfolio()/positions
 * before reporting a position exists.
 */
export async function placeOrder(order: KalshiOrder) {
  if (!Number.isInteger(order.count) || order.count < 1) {
    throw new Error(`count must be a positive whole number, got ${order.count}`);
  }
  if (!(order.priceDollars > 0 && order.priceDollars < 1)) {
    throw new Error(`priceDollars must be between 0 and 1, got ${order.priceDollars}`);
  }
  return kalshiAuthed("/trade-api/v2/portfolio/events/orders", {
    method: "POST",
    body: {
      ticker: order.ticker,
      side: order.side,
      count: order.count.toFixed(2),
      price: order.priceDollars.toFixed(4),
      time_in_force: "good_till_canceled",
      self_trade_prevention_type: "taker_at_cross",
      client_order_id: order.clientOrderId ?? crypto.randomUUID(),
      ...(order.exchangeIndex === undefined ? {} : { exchange_index: order.exchangeIndex }),
    },
  });
}

/**
 * Lifetime realised P&L and fees, summed across every market position.
 *
 * Kalshi has no "P&L since time T" endpoint, so a daily figure is this number
 * minus a snapshot taken at the start of the UTC day. Both values are strings
 * in DOLLARS on the wire.
 */
export async function fetchRealisedPnl(): Promise<{ pnl: number; fees: number } | null> {
  const pos = await kalshiAuthed("/trade-api/v2/portfolio/positions");
  if (!pos) return null;
  const rows =
    ((pos as { market_positions?: { realized_pnl_dollars?: string; fees_paid_dollars?: string }[] })
      .market_positions) ?? [];
  const num = (v: string | undefined) => {
    const n = parseFloat(v ?? "0");
    return Number.isFinite(n) ? n : 0;
  };
  return {
    pnl: rows.reduce((a, r) => a + num(r.realized_pnl_dollars), 0),
    fees: rows.reduce((a, r) => a + num(r.fees_paid_dollars), 0),
  };
}
