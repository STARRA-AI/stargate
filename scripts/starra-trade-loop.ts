/**
 * The unattended loop. Scans, filters, and (with --live) places.
 *
 * DRY BY DEFAULT. Without --live it reports what it would do and spends nothing.
 *
 *   npx tsx scripts/starra-trade-loop.ts                     # one dry pass
 *   npx tsx scripts/starra-trade-loop.ts --every 5           # dry, every 5 min
 *   npx tsx scripts/starra-trade-loop.ts --live --every 5    # REAL, every 5 min
 *   npx tsx scripts/starra-trade-loop.ts --live --floor -5 --count 2
 *
 * Knobs: --traders --count --floor --min-edge --max-edge --max-open
 *
 * The daily loss floor is measured against a realised-P&L snapshot taken on the
 * first pass of each UTC day, and the loop refuses to trade at all if it cannot
 * read P&L — an unattended loop with a broken stop is worse than no loop.
 *
 * Background: docs/reference/KALSHI_COMBOS.md
 */
import { runOnce, DEFAULTS, type LoopConfig } from "../src/lib/copy-loop";

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (n: string, d: number) => {
  const v = arg(n);
  return v === undefined ? d : Number(v);
};

const cfg: Partial<LoopConfig> = {
  live: argv.includes("--live"),
  traders: num("traders", DEFAULTS.traders),
  count: num("count", DEFAULTS.count),
  minEdgeDollars: num("min-edge", DEFAULTS.minEdgeDollars),
  maxEdgeDollars: num("max-edge", DEFAULTS.maxEdgeDollars),
  dailyLossFloorDollars: num("floor", DEFAULTS.dailyLossFloorDollars),
  maxOpenPositions: num("max-open", DEFAULTS.maxOpenPositions),
};
const everyMin = Number(arg("every") ?? 0);

function stamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

async function pass(n: number) {
  const r = await runOnce(cfg);
  const head = `[${stamp()}] pass ${n} — ${cfg.live ? "LIVE" : "dry"}`;
  if (r.halted) {
    console.log(`${head}  HALTED: ${r.halted}`);
    return r;
  }
  console.log(`${head}  scanned ${r.scanned}, eligible ${r.eligible}, placed ${r.placed.length}`);
  for (const p of r.placed) console.log(`    PLACED  ${p.ticker}  ${p.count} @ $${p.price.toFixed(2)}`);
  for (const s of r.skipped.slice(0, 6)) console.log(`    skip    ${s.ticker.slice(0, 42).padEnd(44)} ${s.why}`);
  return r;
}

(async () => {
  console.log(
    `\ncopy-trade loop — ${cfg.live ? "LIVE, REAL MONEY" : "DRY RUN, nothing will be placed"}\n` +
      `  traders ${cfg.traders} · ${cfg.count} contract(s) · edge $${cfg.minEdgeDollars}-$${cfg.maxEdgeDollars}\n` +
      `  daily floor $${cfg.dailyLossFloorDollars} · max ${cfg.maxOpenPositions} open` +
      (everyMin ? ` · every ${everyMin}m (ctrl-C to stop)` : " · single pass") +
      "\n",
  );

  let n = 1;
  const first = await pass(n);
  if (!everyMin) {
    if (!cfg.live && first.eligible > 0) {
      console.log(`\n  ${first.eligible} would have gone through. Add --live to place them.\n`);
    } else {
      console.log("");
    }
    return;
  }

  setInterval(
    () => {
      n += 1;
      pass(n).catch((e) => console.error(`[${stamp()}] pass ${n} FAILED:`, e?.message ?? e));
    },
    everyMin * 60_000,
  );
})().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
