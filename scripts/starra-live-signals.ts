/**
 * The copy-trade signal: who on Polymarket is actually persistent, what they
 * just bought, and which LIVE Kalshi market is the same bet.
 *
 * Read-only. Prints candidates; places nothing. Execution is scripts/kalshi-order.ts.
 *
 *   npx tsx scripts/starra-live-signals.ts --selftest   # verify the team mapping
 *   npx tsx scripts/starra-live-signals.ts              # live signal scan
 *   npx tsx scripts/starra-live-signals.ts --traders 8  # widen the trader pool
 *
 * Background: docs/reference/KALSHI_COMBOS.md
 */
import { scoreTraders, fetchTrades, aggregateFills, type PolyTrade } from "../src/lib/polymarket";
import {
  mlbTeamCode,
  matchMlbOutcome,
  isLive,
  isTradeable,
  type KalshiMarketLite,
} from "../src/lib/copy-match";

const argv = process.argv.slice(2);
const arg = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const BASE = "https://api.elections.kalshi.com";

// Every MLB club as Polymarket writes it, with the Kalshi code it must resolve
// to. A mapping table nobody checks is a mapping table that is wrong.
const SELFTEST: [string, string][] = [
  ["Oakland Athletics", "ATH"], ["Arizona Diamondbacks", "AZ"], ["Atlanta Braves", "ATL"],
  ["Baltimore Orioles", "BAL"], ["Boston Red Sox", "BOS"], ["Chicago Cubs", "CHC"],
  ["Chicago White Sox", "CWS"], ["Cincinnati Reds", "CIN"], ["Cleveland Guardians", "CLE"],
  ["Colorado Rockies", "COL"], ["Detroit Tigers", "DET"], ["Houston Astros", "HOU"],
  ["Kansas City Royals", "KC"], ["Los Angeles Angels", "LAA"], ["Los Angeles Dodgers", "LAD"],
  ["Miami Marlins", "MIA"], ["Milwaukee Brewers", "MIL"], ["Minnesota Twins", "MIN"],
  ["New York Mets", "NYM"], ["New York Yankees", "NYY"], ["Philadelphia Phillies", "PHI"],
  ["Pittsburgh Pirates", "PIT"], ["San Diego Padres", "SD"], ["San Francisco Giants", "SF"],
  ["Seattle Mariners", "SEA"], ["St. Louis Cardinals", "STL"], ["Tampa Bay Rays", "TB"],
  ["Texas Rangers", "TEX"], ["Toronto Blue Jays", "TOR"], ["Washington Nationals", "WSH"],
];

function selftest(): void {
  let bad = 0;
  for (const [name, want] of SELFTEST) {
    const got = mlbTeamCode(name);
    if (got !== want) {
      console.log(`  MISMATCH  ${name.padEnd(24)} want ${want}  got ${got ?? "null"}`);
      bad++;
    }
  }
  // Non-baseball must return null, not a bad guess.
  for (const n of ["Daniil Medvedev", "Eternal Fire", "Arsenal FC", "Over"]) {
    const got = mlbTeamCode(n);
    if (got !== null) {
      console.log(`  FALSE POSITIVE  "${n}" -> ${got}`);
      bad++;
    }
  }
  console.log(
    bad === 0
      ? `  all ${SELFTEST.length} clubs map correctly, and 4 non-MLB names correctly return null`
      : `  ${bad} FAILURES`,
  );
  if (bad > 0) process.exit(1);
}

async function kalshiMarkets(series: string): Promise<KalshiMarketLite[]> {
  const res = await fetch(`${BASE}/trade-api/v2/markets?series_ticker=${series}&limit=200&status=open`, {
    cache: "no-store",
  });
  if (!res.ok) return [];
  return ((await res.json()) as { markets?: KalshiMarketLite[] }).markets ?? [];
}

(async () => {
  if (argv.includes("--selftest")) {
    console.log("\nTEAM MAPPING SELF-TEST");
    selftest();
    console.log("");
    return;
  }

  const nTraders = Number(arg("traders") ?? 5);

  console.log("\n1. WHO IS ACTUALLY PERSISTENT (ranked by profit BEFORE this week)");
  const scored = await scoreTraders();
  const pool = scored.filter((t) => t.persistent).slice(0, nTraders);
  for (const t of pool) {
    console.log(
      `   ${t.pseudonym.slice(0, 20).padEnd(22)} 7d $${Math.round(t.profit7d).toLocaleString().padStart(9)}` +
        `   prior 3wks $${Math.round(t.priorWeeks).toLocaleString().padStart(9)}`,
    );
  }
  if (pool.length === 0) {
    console.log("   none — nobody on the weekly board was profitable in the prior three weeks.");
    return;
  }

  console.log("\n2. WHAT THEY JUST BOUGHT");
  const all: PolyTrade[] = [];
  for (const t of pool) {
    const trades = aggregateFills(await fetchTrades(t.proxyWallet, 100));
    all.push(...trades);
  }
  const mlbSignals = all.filter((t) => t.side === "BUY" && mlbTeamCode(t.outcome) !== null);
  console.log(`   ${all.length} aggregated intents, ${mlbSignals.length} of them MLB sides`);

  const other = all.filter((t) => mlbTeamCode(t.outcome) === null).slice(0, 5);
  if (other.length) {
    console.log("   non-MLB they are also trading (not matched here):");
    for (const t of other) console.log(`     ${t.title.slice(0, 62)}`);
  }

  if (mlbSignals.length === 0) {
    console.log("\n   No MLB signal from this pool right now. Nothing to place.");
    return;
  }

  console.log("\n3. THE SAME BET ON KALSHI, LIVE ONLY");
  const markets = await kalshiMarkets("KXMLBGAME");
  const live = markets.filter((m) => isLive(m) && isTradeable(m));
  console.log(`   ${markets.length} open MLB markets, ${live.length} live and quoted right now`);

  let found = 0;
  const seen = new Set<string>();
  for (const sig of mlbSignals) {
    const m = matchMlbOutcome(sig.outcome, live);
    if (!m || seen.has(m.ticker)) continue;
    seen.add(m.ticker);
    found++;
    const edge = sig.price - m.askDollars;
    console.log(
      `\n   ${m.ticker}\n` +
        `     they bought ${sig.outcome} @ $${sig.price.toFixed(2)} on Polymarket\n` +
        `     Kalshi ask $${m.askDollars.toFixed(2)} · shard ${m.shard} · ${m.live ? "LIVE" : "not started"}\n` +
        `     ${edge > 0 ? `CHEAPER on Kalshi by $${edge.toFixed(2)}` : `dearer on Kalshi by $${(-edge).toFixed(2)}`}`,
    );
  }
  if (found === 0) {
    console.log("   No overlap right now — their MLB games are not live on Kalshi at this moment.");
  } else {
    console.log(`\n   ${found} tradeable overlap(s). To place one:`);
    console.log(`   npx tsx scripts/kalshi-order.ts --ticker <TICKER> --price <ASK> --yes`);
  }
  console.log("");
})().catch((e) => {
  console.error("\nFAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
