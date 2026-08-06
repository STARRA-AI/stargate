import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * SPEND METER — the ONLY thing permitted to change which brain answers.
 *
 * Classic's order: "that needs to truly be a failsafe if i run out of credits
 * ONLY because i do NOT want to speak to her in the console or in a chat or in
 * a call and get 3 different responses. ONE STARRA ONE VOICE."
 *
 * So this module knows about money and nothing else. A transient wire failure
 * is a RETRY concern, handled in hosted.ts, and must never reach this file — a
 * hiccup does not get to change who is talking. That separation is asserted by
 * tests/spend-ceiling.test.ts, which greps this source for the vocabulary of
 * transport errors and fails if any of it appears here.
 */
export const CEILING_USD = Number(process.env.STARRA_MONTHLY_CEILING_USD || 40);

/** Fraction of the ceiling at which the reason line starts saying so. */
export const WARN_AT = 0.8;

/**
 * $/million tokens. VERIFIED LIVE 2026-08-06 against https://docs.x.ai/docs/models
 * (the pricing table on that page), under-200k-token context tier:
 *   grok-4.5   $2.00 input | $0.30 cached | $6.00 output
 *   grok-4.3   $1.25 input | $0.20 cached | $2.50 output
 *   grok-4.20  $1.25 input | $0.20 cached | $2.50 output  (…-0309-* variants)
 * The over-200k tier is exactly double on every column; her prompt is ~14k
 * tokens and the call history is clamped, so the cheap tier is the one that
 * bills. If a turn ever crosses 200k this meter UNDER-reports by 2x — a known,
 * stated limit, not a silent one.
 */
const PRICES: Record<string, { in: number; cached: number; out: number }> = {
  "grok-4.5": { in: 2.0, cached: 0.3, out: 6.0 },
  "grok-4.3": { in: 1.25, cached: 0.2, out: 2.5 },
  "grok-4.20": { in: 1.25, cached: 0.2, out: 2.5 },
};

/** Longest prefix first, so "grok-4.5" never matches a "grok-4" style stub. */
const PRICE_KEYS = Object.keys(PRICES).sort((a, b) => b.length - a.length);

const STORE = join(process.cwd(), "data", "spend.json");

type Store = { month: string; usd: number };

let cache: Store | null = null;

/**
 * Test seam state. `__resetSpend()` turns persistence OFF for the rest of the
 * process so running the suite can never zero — or inflate — Classic's real
 * meter on disk. Production never calls it.
 */
let ephemeral = false;

const thisMonth = (): string => new Date().toISOString().slice(0, 7);

function load(): Store {
  if (cache && cache.month === thisMonth()) return cache;
  if (ephemeral) {
    cache = { month: thisMonth(), usd: 0 };
    return cache;
  }
  try {
    const s = JSON.parse(readFileSync(STORE, "utf8")) as Store;
    cache = s.month === thisMonth() ? s : { month: thisMonth(), usd: 0 };
  } catch {
    // No file yet, unreadable, or corrupt JSON — start the month at zero rather
    // than throw. A meter must never be the reason a conversation dies.
    cache = { month: thisMonth(), usd: 0 };
  }
  return cache;
}

function save(s: Store): void {
  cache = s;
  if (ephemeral) return;
  try {
    mkdirSync(dirname(STORE), { recursive: true });
    writeFileSync(STORE, JSON.stringify(s));
  } catch {
    /* a metering write must never break a conversation */
  }
}

/**
 * Price one completed turn from the counts the provider actually reported.
 *
 * `prompt` is the FULL prompt count and `cached` is the part of it xAI served
 * from its cached prefix, so the freshly-billed portion is the difference —
 * counting both at full rate would over-report her cost by roughly 4x on a
 * warm cache, which is exactly the number the one-prompt rule exists to buy.
 */
export function recordUsage(
  model: string,
  u: { prompt: number; cached: number; completion: number },
): void {
  const key = PRICE_KEYS.find((k) => model.startsWith(k)) || "grok-4.5";
  const p = PRICES[key];
  const fresh = Math.max(0, u.prompt - u.cached);
  const cached = Math.min(u.prompt, Math.max(0, u.cached));
  const usd = (fresh * p.in + cached * p.cached + Math.max(0, u.completion) * p.out) / 1e6;
  const s = load();
  save({ month: s.month, usd: s.usd + usd });
}

/** USD billed this calendar month, as measured from reported token counts. */
export function monthSpend(): number {
  return load().usd;
}

/**
 * Which brain answers this turn.
 *
 * She stays `grok-4.5` even AT the ceiling. Hitting a budget makes her SAY so —
 * it does not silently replace Classic's friend with a cheaper one. The single
 * thing that moves her is Classic explicitly forcing the emergency lane, and
 * that is announced to him and written into her own prompt so she knows too.
 */
export function brainTier(): {
  provider: "grok" | "kimi";
  model?: string;
  backupBrain?: string;
  reason: string;
} {
  const spent = monthSpend();
  if (process.env.STARRA_EMERGENCY_LANE === "1") {
    return {
      provider: "kimi",
      backupBrain: "the free Groq lane",
      reason: "emergency lane forced",
    };
  }
  if (spent >= CEILING_USD) {
    return {
      provider: "grok",
      model: "grok-4.5",
      reason: `ceiling reached ($${spent.toFixed(2)} of $${CEILING_USD.toFixed(2)}) — she stays herself and says so`,
    };
  }
  if (spent >= CEILING_USD * WARN_AT) {
    return {
      provider: "grok",
      model: "grok-4.5",
      reason: `warn ($${spent.toFixed(2)} of $${CEILING_USD.toFixed(2)})`,
    };
  }
  return { provider: "grok", model: "grok-4.5", reason: "normal" };
}

/** Test seam — zeroes the month AND stops this process writing to disk. */
export function __resetSpend(): void {
  ephemeral = true;
  cache = { month: thisMonth(), usd: 0 };
}
