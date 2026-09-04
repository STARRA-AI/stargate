/**
 * Set the standing split of Kalshi collateral across exchange shards.
 *
 * WHY THIS EXISTS: Kalshi holds collateral PER SHARD and combos live on shard 1
 * ("Programmatic traders must preallocate collateral on a given exchange shard
 * before order placement" — docs.kalshi.com/getting_started/exchange_sharding).
 * An account with everything on shard 0 cannot place a combo at all. Kalshi
 * recomputes every 10s and transfers on your behalf to hold the target.
 *
 * Reads the current split first, shows the change, and only writes when you
 * pass --yes. Without --yes it is a read-only preview.
 *
 *   npx tsx scripts/kalshi-allocate.ts                 # preview 70/30
 *   npx tsx scripts/kalshi-allocate.ts --yes           # apply 70/30
 *   npx tsx scripts/kalshi-allocate.ts 60 40 --yes     # apply 60/40
 *   npx tsx scripts/kalshi-allocate.ts --clear --yes   # disable rebalancing
 *
 * Full background: docs/reference/KALSHI_COMBOS.md
 */
import { fetchShardBalances, setTargetAllocation, KALSHI_SHARDS } from "../src/lib/kalshi";

const argv = process.argv.slice(2);
const apply = argv.includes("--yes");
const clear = argv.includes("--clear");
const nums = argv.filter((a) => /^\d+$/.test(a)).map(Number);

const defaultSplit = { 0: 70, 1: 30 } as Record<number, number>;
const split: Record<number, number> =
  nums.length === 2 ? { 0: nums[0], 1: nums[1] } : defaultSplit;

async function show(label: string) {
  const shards = await fetchShardBalances();
  if (!shards) {
    console.error("No Kalshi key configured (kalshi_key_id / kalshi_private_key).");
    process.exit(1);
  }
  console.log(`\n${label}`);
  let total = 0;
  for (const s of shards) {
    total += s.dollars;
    console.log(`  [${s.exchangeIndex}] ${s.label.padEnd(18)} $${s.dollars.toFixed(4)}`);
  }
  console.log(`  ${"".padEnd(22)} ------- total free: $${total.toFixed(4)}`);
  return total;
}

(async () => {
  const total = await show("CURRENT free balance by shard:");

  if (clear) {
    if (!apply) {
      console.log("\nWould DISABLE auto-rebalancing (empty allocations array).");
      console.log("Re-run with --clear --yes to apply.\n");
      return;
    }
    await setTargetAllocation([]);
    console.log("\nAuto-rebalancing disabled.\n");
    return;
  }

  const sum = Object.values(split).reduce((a, b) => a + b, 0);
  if (sum !== 100) {
    console.error(`\nAllocation must total 100, got ${sum}.`);
    process.exit(1);
  }

  console.log("\nTARGET allocation:");
  for (const [idx, pct] of Object.entries(split)) {
    const label = KALSHI_SHARDS[Number(idx) as keyof typeof KALSHI_SHARDS] ?? `shard ${idx}`;
    console.log(
      `  [${idx}] ${label.padEnd(18)} ${String(pct).padStart(3)}%  ≈ $${((total * pct) / 100).toFixed(2)}`,
    );
  }

  if (!apply) {
    console.log("\nPreview only — nothing was changed.");
    console.log("Re-run the same command with --yes to apply.\n");
    return;
  }

  await setTargetAllocation(
    Object.entries(split).map(([idx, pct]) => ({ exchangeIndex: Number(idx), percent: pct })),
  );
  console.log("\nApplied. Kalshi rebalances within ~10 seconds.");

  await new Promise((r) => setTimeout(r, 12_000));
  await show("AFTER rebalance:");
  console.log("");
})().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
