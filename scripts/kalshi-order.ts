/**
 * Place ONE real Kalshi order through the deck's own client, then confirm it
 * actually filled. This is the end-to-end proof of the write path.
 *
 * Acceptance is NOT a fill. Kalshi returning 200 means the order rested, not
 * that you own anything — so this polls positions afterwards and reports what
 * really happened.
 *
 *   npx tsx scripts/kalshi-order.ts --ticker KXMLBGAME-26SEP042140NYYSD-SD --price 0.49
 *   ... add --yes to actually send it. Without --yes it only quotes the book.
 *
 * Optional: --count N (default 1), --side bid|ask (default bid = buy YES).
 *
 * Full background: docs/reference/KALSHI_COMBOS.md
 */
import { placeOrder, fetchPortfolio, fetchShardBalances, KALSHI_SHARDS } from "../src/lib/kalshi";

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const ticker = arg("ticker");
const price = Number(arg("price"));
const count = Number(arg("count") ?? 1);
const side = (arg("side") ?? "bid") as "bid" | "ask";
const apply = argv.includes("--yes");

if (!ticker || !Number.isFinite(price)) {
  console.error("Usage: --ticker <TICKER> --price <0.01-0.99> [--count N] [--side bid|ask] [--yes]");
  process.exit(1);
}

const BASE = "https://api.elections.kalshi.com";

(async () => {
  // 1. What does the book actually look like right now?
  // ★ Use the single-market path. `/markets?ticker=X` does NOT filter — it
  //   ignores the param and returns the first market on the exchange, which
  //   silently quotes you a completely different contract.
  const res = await fetch(`${BASE}/trade-api/v2/markets/${encodeURIComponent(ticker)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    console.error(`Market ${ticker} not found (${res.status}).`);
    process.exit(1);
  }
  const market = ((await res.json()) as { market?: Record<string, string> }).market;
  if (!market || market.ticker !== ticker) {
    console.error(`Market lookup returned ${market?.ticker ?? "nothing"}, expected ${ticker}.`);
    process.exit(1);
  }

  const ask = parseFloat(market.yes_ask_dollars ?? "0");
  const bid = parseFloat(market.yes_bid_dollars ?? "0");
  console.log(`\nMARKET  ${ticker}`);
  console.log(`  ${market.yes_sub_title ?? ""}`);
  console.log(`  bid $${bid.toFixed(2)}   ask $${ask.toFixed(2)}   status ${market.status}`);
  console.log(`  closes ${market.close_time}`);

  if (ask === 0) {
    console.error("\nNo ask on this book — nothing to buy. A resting bid here would never fill.");
    process.exit(1);
  }

  const notional = price * count;
  console.log(`\nORDER   ${side} ${count} @ $${price.toFixed(4)}  =  $${notional.toFixed(2)} committed`);
  if (side === "bid" && price < ask) {
    console.log(`  NOTE: $${price.toFixed(2)} is below the $${ask.toFixed(2)} ask — this will REST, not fill.`);
    console.log(`        To take the offer immediately, use --price ${ask.toFixed(2)}`);
  }

  // ★ Check the shard THIS market actually lives on, not shard 0. Kalshi moved
  //   baseball and tennis to shard 3 on 2026-08-24 and crypto to shard 2, so an
  //   MLB order collateralises against shard 3 — which is $0 on a fresh account.
  //   Checking shard 0 here would greenlight an order that cannot possibly fill.
  const marketShard = Number(market.exchange_index ?? 0);
  const before = await fetchShardBalances();
  const free = before?.find((s) => s.exchangeIndex === marketShard)?.dollars ?? 0;
  const shardName =
    KALSHI_SHARDS[marketShard as keyof typeof KALSHI_SHARDS] ?? `shard ${marketShard}`;
  console.log(`\nThis market settles on shard ${marketShard} (${shardName}) — free: $${free.toFixed(4)}`);
  if (free < notional) {
    console.error(
      `\nNOT ENOUGH collateral on shard ${marketShard} for $${notional.toFixed(2)}.` +
        `\nMove funds there first:  npx tsx scripts/kalshi-allocate.ts 0:70,${marketShard}:30 --yes`,
    );
    process.exit(1);
  }

  if (!apply) {
    console.log("\nPreview only — no order was sent.");
    console.log("Re-run the same command with --yes to send it.\n");
    return;
  }

  // 2. Send it.
  const out = await placeOrder({ ticker, side, count, priceDollars: price });
  console.log("\nAccepted by Kalshi:", JSON.stringify(out).slice(0, 300));

  // 3. Acceptance is not a fill. Go look.
  await new Promise((r) => setTimeout(r, 4000));
  const p = await fetchPortfolio();
  const held = p.positions?.find((x) => x.ticker === ticker);
  console.log("\nCONFIRMATION:");
  if (held) {
    console.log(`  FILLED — holding ${held.quantity} ${held.side}, exposure $${held.exposureDollars.toFixed(2)}`);
  } else {
    console.log("  No position yet — the order is resting, not filled.");
    console.log("  That is normal for a limit below the ask. Check again shortly.");
  }
  console.log(`  Balance now $${(p.balanceDollars ?? 0).toFixed(2)}\n`);
})().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
