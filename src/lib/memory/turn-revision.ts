/**
 * TURN-REVISION PREDICATES — pure, dependency-free, and deliberately in their
 * OWN module.
 *
 * Both the server store (src/lib/memory/store.ts) and the live call hook
 * (src/lib/voice/useVoiceCall.ts) have to agree on what counts as "the same
 * utterance, further along", or the client would mark a commit as a revision
 * that the server then appends anyway — reintroducing the duplicate row the
 * whole mechanism exists to remove.
 *
 * They cannot share `store.ts` to get it: store.ts imports `node:fs` and is
 * server-only, so importing it from the hook would drag the filesystem into the
 * client bundle. Same discipline as `@/lib/engine/bus` being the client's only
 * door into the engine. Nothing in this file imports anything.
 */

/**
 * Normalized form used to compare two transcripts of the same speech.
 *
 * Case, punctuation and whitespace all drift between successive partial
 * transcripts of one sentence — the realtime transcriber genuinely emits
 * "Okay. Sounds good" and then "Okay, sounds good. I'll be back." — so none of
 * them may take part in the comparison. Only the words do.
 */
export function normalizeTurn(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Is `next` the same utterance as `prev`, just further along?
 *
 * This is the test that collapses a live partial transcript into ONE turn. The
 * realtime user transcript is CUMULATIVE — each update re-sends the whole
 * utterance so far — and the call has three independent triggers that flush
 * whatever is pending, none of which is a real end-of-turn signal. MEASURED in
 * data/memory.json 2026-08-01: a single 18-second sentence from Classic wrote
 * EIGHTEEN rows, 00:48:05.433 through 00:48:23.361, each one a longer prefix of
 * the next.
 *
 * Strictly prefix-based on purpose. A transcriber that REWRITES an earlier word
 * as it gains context ("their" -> "there") breaks the prefix and is therefore
 * treated as a new turn — a duplicated row is a far cheaper failure than
 * silently overwriting something Classic actually said.
 */
export function isTurnRevision(prev: string, next: string): boolean {
  const a = normalizeTurn(prev);
  const b = normalizeTurn(next);
  if (!a || !b) return false;
  return b.length >= a.length && b.startsWith(a);
}

/**
 * How long after a commit a further commit may still be treated as the SAME
 * utterance continuing.
 *
 * Sized off the measured data, not taste: the 18-row run above had gaps of
 * 0.55s to 1.7s between flushes, and the whole utterance ran 17.9s. 45s leaves
 * a wide margin for a slow, pausing sentence while still guaranteeing that a
 * genuinely new turn — which is always separated by at least her reply — is
 * never folded into the previous one.
 */
export const USER_TURN_REVISION_MS = 45_000;
