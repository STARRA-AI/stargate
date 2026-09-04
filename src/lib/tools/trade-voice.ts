/**
 * Trading, in sentences she can say out loud.
 *
 * Same doctrine as the rest of the voice tools: ONE OR TWO SPOKEN SENTENCES,
 * never JSON, never a payload she has to read badly. Failures come back as
 * something sayable, not a stack trace — mid-call an error still has to be a
 * sentence.
 *
 * Wired into BOTH lanes: the chat fast-path (src/lib/tools/fastpath.ts, local,
 * no xAI console involved) and /api/voice-tools (the live call, which xAI's
 * servers call over the public internet with a bearer token).
 */
import { fetchPortfolio, fetchShardBalances } from "@/lib/kalshi";
import { runOnce, scanCandidates, DEFAULTS } from "@/lib/copy-loop";

const money = (n: number) => `$${n.toFixed(2)}`;

/** "You've got nineteen sixty on the deck, nothing open." */
export async function spokenPositions(): Promise<string> {
  const p = await fetchPortfolio();
  if (!p.linked) return "Your Kalshi key isn't linked yet, so I can't see the account.";
  if (p.error) return `I couldn't reach Kalshi just then — ${p.error.slice(0, 80)}.`;
  const n = p.positions?.length ?? 0;
  const bal = money(p.balanceDollars ?? 0);
  if (n === 0) return `You've got ${bal} free and nothing open right now.`;
  const top = p.positions![0];
  return `You've got ${bal} free and ${n} position${n > 1 ? "s" : ""} open — the biggest is ${top.ticker} at ${money(top.exposureDollars)}.`;
}

/** "Crypto and baseball are both unfunded — money's all sitting on Default." */
export async function spokenShards(): Promise<string> {
  const s = await fetchShardBalances();
  if (!s) return "Your Kalshi key isn't linked yet, so I can't see the shards.";
  const empty = s.filter((x) => x.dollars < 0.5).map((x) => x.label);
  const funded = s.filter((x) => x.dollars >= 0.5);
  if (empty.length === 0) return "Every shard's funded — you can trade anything.";
  const where = funded.map((f) => `${money(f.dollars)} on ${f.label}`).join(", ");
  return `${where}. ${empty.join(" and ")} ${empty.length > 1 ? "are" : "is"} empty, so nothing there can fill.`;
}

/** "Three live edges. Best is Detroit at forty cents, seven under Polymarket." */
export async function spokenSignals(): Promise<string> {
  const c = await scanCandidates(DEFAULTS);
  if (c.length === 0) return "Nothing live matches right now — none of their games are running on Kalshi.";
  const best = c[0];
  const more = c.length > 1 ? ` I've got ${c.length - 1} more behind it.` : "";
  return (
    `Best one is ${best.match.team} at ${money(best.match.askDollars)}, ` +
    `${money(Math.abs(best.edgeDollars))} ${best.edgeDollars > 0 ? "under" : "over"} what they paid on Polymarket.${more}`
  );
}

/**
 * Run the loop. `live` false is a dry pass she can narrate without committing
 * anything — that is the default, and the caller must opt in to spending.
 */
export async function spokenTrade(live: boolean): Promise<string> {
  const r = await runOnce({ live });
  if (r.halted) return `I stopped before trading — ${r.halted}.`;
  if (!live) {
    if (r.eligible === 0)
      return `Nothing clears the bar right now. I looked at ${r.scanned} match${r.scanned === 1 ? "" : "es"}.`;
    return `${r.eligible} of ${r.scanned} would go through. Say trade for real and I'll place them.`;
  }
  if (r.placed.length === 0) {
    const why = r.skipped[0]?.why ?? "nothing cleared the bar";
    return `I didn't place anything — ${why}.`;
  }
  const first = r.placed[0];
  const rest = r.placed.length > 1 ? ` and ${r.placed.length - 1} more` : "";
  return `Placed ${first.count} on ${first.ticker} at ${money(first.price)}${rest}. I'll tell you when it settles.`;
}

/**
 * Intent router shared by chat and the call. Returns null when the message
 * isn't about trading, so the LLM handles it normally.
 *
 * ★ "trade for real" / "place it" is the ONLY phrase that spends money. Asking
 *   her to "trade" alone runs dry — a homophone or a half-heard word on a call
 *   must never be the thing that commits funds.
 */
export async function maybeTradeReply(lastUser: string): Promise<string | null> {
  const q = lastUser.toLowerCase().trim();

  if (/\b(position|holding|what do i have open|my book)\b/.test(q)) return spokenPositions();
  if (/\b(shard|collateral|which exchange|funded)\b/.test(q)) return spokenShards();
  if (/\b(signal|edge|what.?s live|any plays|find (me )?a (trade|play))\b/.test(q))
    return spokenSignals();

  if (/\b(trade|place)\b/.test(q)) {
    const forReal = /\b(for real|really|actually|do it|place it|send it|go live)\b/.test(q);
    return spokenTrade(forReal);
  }
  return null;
}
