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
import {
  readAgent,
  readBotState,
  readPerformance,
  engageBot,
  disengageBot,
  balanceUsd,
  isDragonCategory,
  DRAGON_CATEGORIES,
  type AgentDeps,
  type AgentResult,
} from "@/lib/dragon-tradar";

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

/* ── DRAGON TRADAR ────────────────────────────────────────────────────────────
 * His OWN bot at dragontradar.com — a DIFFERENT question from the three reads
 * above. `positions`/`shards` talk to Kalshi directly with his RSA key and
 * answer "what does the account hold". These answer "what is the BOT doing
 * with it": engaged or stopped, which category, paper or live, what it has
 * made. Both are true at the same time; they are not the same sentence.
 *
 * CONTROL IS CHAT-ONLY, AND THAT IS LOAD-BEARING. `maybeTradeReply` is reached
 * from exactly one place — src/lib/tools/fastpath.ts:36, behind /api/chat,
 * which is NOT in middleware's PUBLIC_PREFIXES (src/middleware.ts:12). The
 * internet-facing /api/voice-tools route calls the spoken* helpers BY NAME and
 * is handed only `spokenDragon` (a read). So a holder of her public write token
 * still cannot start or stop his bot — that needs his deck cookie, exactly like
 * /api/dragon/control and /api/dragon/order already require.
 *
 * THE STOP IS NEVER GATED. Engage needs a category said out loud; disengage
 * needs nothing. A brake that asks for confirmation is not a brake.
 */

type AgentState = AgentResult<unknown>["state"];

/** Every non-ok agent state as something she can say. Never a status code. */
function agentTrouble(state: AgentState): string {
  switch (state) {
    case "off":
      return "Dragon Tradar isn't linked — there's no agent token set.";
    case "blocked":
      return "Dragon Tradar throttled me, so I backed off instead of retrying.";
    case "rejected":
      return "Dragon Tradar wouldn't take the token — regenerate it in Settings, AI Trading Agent.";
    default:
      return "I couldn't reach Dragon Tradar just then.";
  }
}

/** Signed money, because a loss read aloud as a plain number is a lie. */
function pnl(cents: number): string {
  const d = Math.abs(cents) / 100;
  return `${cents < 0 ? "down " : "up "}${money(d)}`;
}

/** "The bot's stopped — set to sports, paper mode. You've got $30.12 on it." */
export async function spokenDragon(deps: AgentDeps = {}): Promise<string> {
  const [stats, state, perf] = await Promise.all([
    readAgent(deps),
    readBotState(deps),
    readPerformance(deps),
  ]);

  // Bot state is the spine of the answer: without it there is no sentence.
  if (state.state !== "ok") return agentTrouble(state.state);
  const s = state.stats;

  const head = s.running
    ? `The bot's running on ${s.category}, ${s.mode} mode.`
    : `The bot's stopped — it's set to ${s.category}, ${s.mode} mode.`;

  // Balance and performance each degrade on their own. One missing field
  // shortens the sentence; it never blanks the answer.
  const bal = stats.state === "ok" ? ` You've got ${money(balanceUsd(stats.stats))} on it.` : "";
  const p =
    perf.state === "ok"
      ? perf.stats.tradeCount === 0
        ? " It hasn't traded yet."
        : ` ${perf.stats.tradeCount} trade${perf.stats.tradeCount === 1 ? "" : "s"} so far, ${pnl(perf.stats.realizedPnlCents)}.`
      : "";

  return head + bal + p;
}

/**
 * Start it. The category is REQUIRED and is never guessed — "engage the dragon"
 * with no category gets the list back, not a default, because picking one for
 * him is picking what his money does.
 *
 * The mode is read back AFTER the engage and said out loud, so "paper" or
 * "live" is something he HEARS rather than something he has to go and check.
 */
export async function spokenDragonEngage(
  category: string,
  deps: AgentDeps = {},
): Promise<string> {
  if (!isDragonCategory(category)) {
    return `I don't know that category — it's ${DRAGON_CATEGORIES.join(", ")}.`;
  }
  const r = await engageBot(category, deps);
  if (r.state !== "ok") return `I couldn't start it — ${agentTrouble(r.state)}`;

  const st = await readBotState(deps);
  const mode = st.state === "ok" ? `${st.stats.mode} mode` : "mode unknown";
  return `Dragon's engaged on ${category}, ${mode}. Say stop the dragon and I'll pull it.`;
}

/** Stop it. Dispatched on the word, with nothing standing in front of it. */
export async function spokenDragonDisengage(deps: AgentDeps = {}): Promise<string> {
  const r = await disengageBot(deps);
  if (r.state !== "ok") return `I tried to stop it and it didn't take — ${agentTrouble(r.state)}`;
  return "Dragon's disengaged. Nothing's running.";
}

/**
 * Intent router shared by chat and the call. Returns null when the message
 * isn't about trading, so the LLM handles it normally.
 *
 * ★ "trade for real" / "place it" is the ONLY phrase that spends money. Asking
 *   her to "trade" alone runs dry — a homophone or a half-heard word on a call
 *   must never be the thing that commits funds.
 */
export async function maybeTradeReply(
  lastUser: string,
  deps: AgentDeps = {},
): Promise<string | null> {
  const q = lastUser.toLowerCase().trim();

  // DRAGON TRADAR IS CHECKED FIRST, on purpose. "dragon positions" is a
  // question about HIS BOT; without this branch it falls into the Kalshi-direct
  // read below, which answers a different question with a confident number and
  // never mentions that it did.
  if (/\bdragon\b/.test(q)) {
    // The stop, before anything that could stand in front of it.
    if (/\b(stop|disengage|kill|halt|stand down|shut (it |them )?down)\b/.test(q)) {
      return spokenDragonDisengage(deps);
    }
    if (/\b(engage|start|launch|fire (it )?up|turn (it )?on)\b/.test(q)) {
      const cat = DRAGON_CATEGORIES.find((c) => new RegExp(`\\b${c}\\b`).test(q));
      // No category is a QUESTION back, never a default. Choosing one for him
      // is choosing what his money does.
      return cat
        ? spokenDragonEngage(cat, deps)
        : `Which one — ${DRAGON_CATEGORIES.join(", ")}? Say engage dragon on crypto.`;
    }
    return spokenDragon(deps);
  }

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
