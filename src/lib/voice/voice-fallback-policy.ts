/**
 * WHO IS ALLOWED TO SPEAK WHEN HER VOICE FAILS.
 *
 * ONE VOICE, ONE STARRA. Her voice is Ara/eve (xAI) — the same one as the live
 * call. This module answers exactly one question: when that voice does not come
 * out, may a DIFFERENT engine speak the reply instead?
 *
 * Almost always: no.
 *
 * THE HISTORY, because it is the whole reason this file exists. Classic has
 * reported "two of her" more than once. On 2026-07-30 the response was to give
 * Ara one RETRY before a fallback engine could speak. That reduced how OFTEN a
 * stranger finished his sentence; it never made it impossible, and it was
 * reported to him as fixed. On 2026-08-08 he heard it again: an error mid-answer
 * and "that other british voice". Both fallbacks are in fact British —
 * Piper `en_GB-cori-medium`, and Web Speech via voice-select.ts's GB_FEMALE list
 * (google uk english female / kate / serena / martha / stephanie / hazel /
 * sonia). Making a wrong voice rarer is not the same as having one voice.
 *
 * So the rule is now structural rather than probabilistic:
 *
 *   TRANSIENT failure (network, HTTP error, decode, stall, barge-in)
 *     -> NOBODY else speaks. She is silent and the UI says so, loudly.
 *        Silence he can see the reason for beats a stranger's voice.
 *
 *   NEVER CONFIGURED (/api/tts answers 204 — no key)
 *     -> the local voice may speak. This is the documented offline lane in
 *        CLAUDE.md, not a mid-answer error, and it is announced.
 *
 *   OPERATOR CHOSE a specific Web Speech voice in Settings
 *     -> honor it. That is his decision, not a degrade.
 *
 * Fails CLOSED: any outcome this function does not recognise is treated as a
 * failure, so adding a new outcome later cannot silently re-open the door.
 */

export type AraOutcome =
  /** Sound came out in her voice. */
  | "ok"
  /** /api/tts returned 204 — no key configured. The offline lane. */
  | "unconfigured"
  /** Network / HTTP / empty body / decode / stalled element. TRANSIENT. */
  | "failed"
  /** Barge-in or a newer turn took her voice. */
  | "aborted"
  /** Ara was not tried, because the operator picked another voice. */
  | "not-attempted";

export interface FallbackDecision {
  outcome: AraOutcome;
  /** Whether Ara/eve is the operator's selected voice (voice-select.ts). */
  araSelected: boolean;
}

/**
 * True only when an engine OTHER than Ara may speak this utterance.
 *
 * Deliberately boring and total: no I/O, no clock, no globals — so the rule
 * that protects her voice is provable in a unit test rather than only
 * observable by Classic being angry on a live turn.
 */
export function mayAnotherVoiceSpeak({
  outcome,
  araSelected,
}: FallbackDecision): boolean {
  // He explicitly chose a different voice in Settings. His call, not a degrade.
  if (!araSelected) return true;

  // Her hosted voice was never available to begin with — the offline lane.
  if (outcome === "unconfigured") return true;

  // Everything else — failed, aborted, ok, not-attempted, or anything added
  // later — means no second voice. Fail closed.
  return false;
}

/**
 * Operator-facing reason her voice did not come out, for the UI to SAY rather
 * than swallow. A silent degrade is what let this hide for weeks.
 */
export function voiceFailureNotice(outcome: AraOutcome): string | null {
  switch (outcome) {
    case "failed":
      return "Her voice (xAI) did not respond — reply shown as text. Not switching voices.";
    case "unconfigured":
      return "Her hosted voice is not configured — using the local offline voice.";
    default:
      return null;
  }
}
