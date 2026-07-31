/**
 * FACT EXTRACTION — the mem0 idea, in-house and $0: after an exchange lands,
 * distill 0-3 DURABLE facts ("Classic filed the DUNS", "flip candidate X
 * rejected — failed the cost filter") and fold them into the store's fact
 * tier, which memoryForPrompt leads with on every surface.
 *
 * Rules of engagement, all load-bearing:
 *  - FIRE-AND-FORGET from the reply path — extraction may never delay, block,
 *    or throw into a reply or a call (callers use `void extractFactsFromExchange`).
 *  - Rides the free kimi/Groq driver; skipped entirely for trivial exchanges
 *    (combined < 200 chars) so the free tier is spent where memory is made.
 *  - Tolerant parse; anything unusable extracts nothing, silently.
 */
import { streamHosted } from "@/lib/llm/hosted";
import { recordFacts } from "@/lib/memory/store";

export const EXTRACT_MIN_CHARS = 200;

const SYSTEM =
  "You distill conversations into durable memory for STARRA, Classic's operator. " +
  "From the exchange, extract 0-3 facts worth remembering WEEKS from now: decisions made, " +
  "things built or filed, preferences stated, names/dates/amounts that matter, commitments. " +
  "NO transient chit-chat, NO restating the question, NO feelings-of-the-moment. " +
  'Reply with STRICT JSON only: an array of strings, e.g. ["Classic filed the DUNS application"]. ' +
  "Empty array [] when nothing is durable.";

/** Tolerant: JSON array anywhere in the reply; junk → []. Exported for tests. */
export function parseFacts(raw: string): string[] {
  if (typeof raw !== "string") return [];
  const m = /\[[\s\S]*?\]/.exec(raw);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === "string").slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * Extract + store facts from one finished exchange. Never throws; never
 * awaited by reply paths. Returns the facts it stored (for tests/telemetry).
 */
export async function extractFactsFromExchange(
  userText: string,
  assistantText: string,
): Promise<string[]> {
  try {
    const u = (userText ?? "").trim();
    const a = (assistantText ?? "").trim();
    if (u.length + a.length < EXTRACT_MIN_CHARS) return [];
    let out = "";
    await streamHosted({
      provider: "kimi",
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `Classic: ${u.slice(0, 1200)}\nSTARRA: ${a.slice(0, 1200)}`,
        },
      ],
      onText: (chunk) => {
        out += chunk;
      },
    });
    const facts = parseFacts(out);
    if (facts.length > 0) await recordFacts(facts);
    return facts;
  } catch {
    return []; // extraction is garnish — memory of the raw turns already landed
  }
}
