/**
 * Both steps, one command: split collateral across shards, wait for Kalshi to
 * actually rebalance, then place one order and confirm it filled.
 *
 * Stops at the first failure rather than plowing on — if the rebalance does not
 * land, the order would fail on collateral anyway and there is no point sending
 * it. Nothing is written without --yes.
 *
 *   npx tsx scripts/kalshi-go.ts                                  # preview both
 *   npx tsx scripts/kalshi-go.ts --yes                            # run both
 *   npx tsx scripts/kalshi-go.ts --alloc 0:50,1:20,3:30 --yes     # custom split
 *   npx tsx scripts/kalshi-go.ts --ticker X --price 0.44 --yes    # custom order
 *
 * Shards: 0 Default · 1 Combos · 2 Crypto · 3 Tennis & Baseball
 * Background: docs/reference/KALSHI_COMBOS.md
 */
import {
  fetchShardBalances,
  setTargetAllocation,
  placeOrder,
  fetchPortfolio,
  KALSHI_SHARDS,
} from "../src/lib/kalshi";

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const apply = argv.includes("--yes");

const allocSpec = arg("alloc") ?? "0:40,1:20,3:40";
const ticker = arg("ticker") ?? "KXNFLGAME-26SEP09NESEA-SEA";
const count = Number(arg("count") ?? 1);
const BASE = "https://api.elections.kalshi.com";

const split: Record<number, number> = Object.fromEntries(
  allocSpec.split(",").map((p) => p.split(":").map(Number) as [number, number]),
);

async function showShards(label: string) {
  const s = await fetchShardBalances();
  if (!s) {
    console.error("No Kalshi key configured.");
    process.exit(1);
  }
  console.log(`\n${label}`);
  for (const r of s) {
    console.log(`  [${r.exchangeIndex}] ${r.label.padEnd(18)} $${r.dollars.toFixed(4)}`);
  }
  return s;
}

(async () => {
  // ── STEP 1 ───────────────────────────────────────────────────────────────
  console.log("STEP 1 — collateral allocation");
  await showShards("before:");

  const total = Object.values(split).reduce((a, b) => a + b, 0);
  if (total !== 100) {
    console.error(`\nAllocation must total 100, got ${total}.`);
    process.exit(1);
  }
  console.log("\ntarget:");
  for (const [i, pct] of Object.entries(split)) {
    const name = KALSHI_SHARDS[Number(i) as keyof typeof KALSHI_SHARDS] ?? `shard ${i}`;
    console.log(`  [${i}] ${name.padEnd(18)} ${String(pct).padStart(3)}%`);
  }

  if (apply) {
    await setTargetAllocation(
      Object.entries(split).map(([i, p]) => ({ exchangeIndex: Number(i), percent: p })),
    );
    console.log("\napplied — waiting 15s for Kalshi to rebalance...");
    await new Promise((r) => setTimeout(r, 15_000));
    await showShards("after:");
  } else {
    console.log("\n(preview — not applied)");
  }

  // ── STEP 2 ───────────────────────────────────────────────────────────────
  console.log("\n\nSTEP 2 — one real order");
  const res = await fetch(`${BASE}/trade-api/v2/markets/${encodeURIComponent(ticker)}`, {
    cache: "no-store",
  });
  if (!res.ok) {
    console.error(`Market ${ticker} not found (${res.status}).`);
    process.exit(1);
  }
  const market = ((await res.json()) as { market?: Record<string, string> }).market;
  if (!market || market.ticker !== ticker) {
    console.error(`Lookup returned ${market?.ticker ?? "nothing"}, expected ${ticker}.`);
    process.exit(1);
  }

  const ask = parseFloat(market.yes_ask_dollars ?? "0");
  const shard = Number(market.exchange_index ?? 0);
  const shardName = KALSHI_SHARDS[shard as keyof typeof KALSHI_SHARDS] ?? `shard ${shard}`;
  console.log(`\n  ${ticker}`);
  console.log(`  ${market.yes_sub_title ?? ""} — ask $${ask.toFixed(2)}, closes ${market.close_time}`);
  console.log(`  settles on shard ${shard} (${shardName})`);

  if (ask === 0) {
    console.error("\n  No ask on this book. A bid here would rest forever. Stopping.");
    process.exit(1);
  }

  // Take the ask so it fills now instead of resting.
  const price = Number(arg("price") ?? ask);
  const notional = price * count;
  const shards = await fetchShardBalances();
  const free = shards?.find((s) => s.exchangeIndex === shard)?.dollars ?? 0;
  console.log(`\n  order: bid ${count} @ $${price.toFixed(2)} = $${notional.toFixed(2)}`);
  console.log(`  free on shard ${shard}: $${free.toFixed(4)}`);

  if (free < notional) {
    console.error(`\n  NOT ENOUGH collateral on shard ${shard}. Stopping before the order.`);
    process.exit(1);
  }

  if (!apply) {
    console.log("\n(preview — no order sent)\n");
    return;
  }

  const out = await placeOrder({ ticker, side: "bid", count, priceDollars: price });
  console.log("\n  accepted:", JSON.stringify(out).slice(0, 220));

  // Acceptance is not a fill.
  await new Promise((r) => setTimeout(r, 5000));
  const p = await fetchPortfolio();
  const held = p.positions?.find((x) => x.ticker === ticker);
  console.log("\n  CONFIRMED:");
  console.log(
    held
      ? `    FILLED — ${held.quantity} ${held.side}, exposure $${held.exposureDollars.toFixed(2)}`
      : "    resting, not filled yet",
  );
  console.log(`    balance now $${(p.balanceDollars ?? 0).toFixed(2)}\n`);
})().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
