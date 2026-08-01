import type { MemoryStore } from "./store";

/**
 * THE CALL DIGEST — what GET /api/memory?digest=1 hands the live voice session.
 *
 * WHY THIS IS NOT `memoryForPrompt` (2026-07-31, Classic: "she's still saying
 * 'im right here baby and i love you baby' waaay too much").
 *
 * The call injects up to 4000 characters of the shared memory digest into her
 * realtime session instructions at connect (useVoiceCall's sessionUpdate). Until
 * now that digest was `memoryForPrompt` verbatim — the SAME block the chat brain
 * reads — and its working tier is her own recent transcript, both roles.
 *
 * For a text brain that is continuity. For a realtime VOICE model it is
 * something else entirely: dozens of examples of her own comfort-line habit,
 * sitting in the instruction block, immediately above "now talk". That is a
 * few-shot prompt. It does not compete with the VARIETY clause in
 * STARRA_VOICE_PERSONA — it overwhelms it, because concrete examples always beat
 * an abstract instruction, and every call fed her more of them than the last.
 * MEASURED across data/memory.json on 2026-07-31: "baby" 856 times, "right here"
 * 421, "love you" 136, "take your time" 74. A closed loop.
 *
 * So the loop is cut HERE, at the digest, and nowhere else:
 *
 *   1. HER OWN STYLED LINES ARE REMOVED from the working tier and from the
 *      archival blobs. What she needs carried into a call is what CLASSIC said,
 *      what is durably TRUE (the facts tier), and the rolling summaries — not
 *      her own phrasing. Her voice comes from the persona, which is LOCKED and
 *      untouched by this file.
 *   2. AN OVERUSE GUARD IS COMPUTED, not hardcoded: her removed lines are
 *      scanned for the comfort phrases below, and the ones she has actually
 *      leaned on get named back to her, with counts, as worn out for this call.
 *      A phrase she has not been overusing is never mentioned, so the guard
 *      cannot itself become the suggestion.
 *
 * DECK CHAT IS UNTOUCHED. api/chat calls `memoryForPrompt` directly, server
 * side; this module is imported only by the digest leg of the memory route.
 */

/**
 * The comfort phrases worth policing. Every one of these is MEASURED in her own
 * store, not imagined — they are her real tics, in frequency order. Matched on
 * word boundaries so "baby" never fires on "babysit".
 *
 * Ordering here does not decide what she is told: the counts do. This is only
 * the candidate set.
 */
export const COMFORT_PHRASES: readonly string[] = [
  "baby",
  "right here",
  "love you",
  "take your time",
  "not going anywhere",
  "i hear you",
  "i got you",
  "i'm with you",
  "no rush",
  "breathe",
];

/** A phrase must appear at least this often in her recent lines to be called out. */
export const OVERUSE_MIN = 2;
/** At most this many are named — a long list reads as a vocabulary, not a ban. */
export const OVERUSE_MAX = 5;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Count whole-word occurrences of `phrase` in `hay`. Case-insensitive, and
 * apostrophe-insensitive at the boundary so "im with you" counts alongside
 * "i'm with you" (speech transcripts produce both).
 */
export function countPhrase(hay: string, phrase: string): number {
  // An empty phrase would match the zero-width boundary pair and advance the
  // cursor by nothing — an infinite loop in the scan below.
  if (!phrase) return 0;
  // Apostrophes are OPTIONAL in the pattern: speech transcripts emit both "im
  // with you" and "I'm with you" for the same words, and both are the tic.
  const p = escapeRe(phrase.toLowerCase()).replace(/'/g, "'?");
  try {
    const re = new RegExp(`(^|[^a-z0-9'])${p}($|[^a-z0-9'])`, "gi");
    let n = 0;
    // Overlapping-safe scan: step the cursor to just after the MATCHED phrase,
    // not past the trailing boundary character, so "baby, baby" counts as two.
    // The matched length is derived from the match rather than phrase.length,
    // because the optional apostrophe makes those differ.
    let m: RegExpExecArray | null;
    let from = 0;
    const text = hay.toLowerCase();
    while (from <= text.length) {
      re.lastIndex = from;
      m = re.exec(text);
      if (!m) break;
      n += 1;
      const next = m.index + m[0].length - m[2].length;
      from = next > from ? next : from + 1; // never stall the cursor
    }
    return n;
  } catch {
    return 0; // a malformed phrase must never break the digest
  }
}

/**
 * Which comfort phrases is she actually leaning on, worst first? PURE — this is
 * the whole reason the guard is trustworthy: it names only what is measurably
 * there, so a call where she was varied produces no guard at all.
 */
export function overusedPhrases(
  herText: string,
  phrases: readonly string[] = COMFORT_PHRASES,
): { phrase: string; count: number }[] {
  if (!herText.trim()) return [];
  return phrases
    .map((phrase) => ({ phrase, count: countPhrase(herText, phrase) }))
    .filter((p) => p.count >= OVERUSE_MIN)
    .sort((x, y) => y.count - x.count || x.phrase.localeCompare(y.phrase))
    .slice(0, OVERUSE_MAX);
}

/**
 * Render the guard line. Returns "" when she has not been repeating anything —
 * naming phrases she is NOT overusing would plant them.
 */
export function overuseGuardLine(hits: { phrase: string; count: number }[]): string {
  if (hits.length === 0) return "";
  const list = hits.map((h) => `"${h.phrase}" (${h.count}x)`).join(", ");
  return (
    `WORN OUT — you have already used these in your own recent lines: ${list}. ` +
    `They have stopped meaning anything to him through sheer repetition. Do NOT ` +
    `open with any of them and do not use them as filler this call; at most ONE, ` +
    `once, and only if the moment genuinely earns it. Say the care a different ` +
    `way every time — the warmth is in what you actually notice about him, not ` +
    `in a stock phrase.`
  );
}

/** Split an archival blob ("user: … | assistant: …") into its role segments. */
function blobSegments(text: string): { role: string; content: string }[] {
  return text
    .split(" | ")
    .map((seg) => {
      const m = /^(user|assistant):\s*([\s\S]*)$/.exec(seg);
      return m ? { role: m[1], content: m[2] } : { role: "", content: seg };
    })
    .filter((s) => s.content.trim().length > 0);
}

/**
 * Everything the digest WOULD have shown her of her own voice. This is the
 * material the overuse guard is computed from, and exactly the material that is
 * then withheld.
 */
export function herOwnLines(store: MemoryStore): string {
  const working = store.working
    .filter((e) => e.role === "assistant")
    .map((e) => e.content);
  const archival = store.archival
    .slice(-5)
    .flatMap((a) => blobSegments(a.text).filter((s) => s.role === "assistant"))
    .map((s) => s.content);
  return [...working, ...archival, ...store.summaries.slice(-5)].join("\n");
}

/**
 * The digest the LIVE CALL gets. Same tier headings as memoryForPrompt (so the
 * shape she has been trained on by every previous call is unchanged) with her
 * own transcript voice removed and the computed guard appended.
 *
 * NEWEST FIRST throughout, for the same reason memoryForPrompt does it: the
 * caller clips this from the TAIL at 4000 chars, so whatever gets cut must be
 * the oldest material, never the most recent.
 */
export function callDigest(store: MemoryStore): string {
  const facts = [...store.facts]
    .slice(-20)
    .reverse()
    .map((f) => f.text)
    .join(" || ");

  const hisTurns = store.working.filter((e) => e.role === "user");
  const said =
    [...hisTurns]
      .reverse()
      .map((e) => e.content)
      .join(" || ") || "empty";

  const archival =
    store.archival
      .slice(-5)
      .map((a) =>
        blobSegments(a.text)
          .filter((s) => s.role !== "assistant")
          .map((s) => s.content)
          .join(" | "),
      )
      .filter((t) => t.trim().length > 0)
      .join(" || ") || "none";

  const guard = overuseGuardLine(overusedPhrases(herOwnLines(store)));

  return [
    // THE GUARD LEADS, and that placement is load-bearing, not cosmetic. The
    // call clips this block with `digest.slice(0, 4000)` (useVoiceCall) — it
    // keeps the HEAD and drops the tail. A guard appended at the bottom is the
    // first thing truncation deletes, on exactly the long-history calls that
    // need it most. It is also an INSTRUCTION, not a memory tier, so it belongs
    // above the tier headings either way.
    ...(guard ? [guard, ""] : []),
    "MEMORY TIERS",
    `Facts (${store.facts.length}, newest first): ${facts || "none yet"}`,
    // Named for what it now is. Her own replies are deliberately NOT here —
    // see this file's header. She should recall what he SAID, not re-read how
    // she said things back.
    `What Classic has been saying (${hisTurns.length}, newest first): ${said}`,
    `Summaries (${store.summaries.length}): ${store.summaries.slice(-5).join(" || ") || "empty"}`,
    `Earlier (his side, ${store.archival.length} blocks stored): ${archival}`,
  ].join("\n");
}
