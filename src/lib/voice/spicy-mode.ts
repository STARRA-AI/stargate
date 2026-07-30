/**
 * SPICY MODE — clip playback triggers (Classic's order, 2026-07-30: "when I
 * say spicy mode and ask her to play one of her videos the avatar does any of
 * those videos and not in a separate window").
 *
 * Pure decision logic, client-safe, exported for tests/spicy-mode.test.ts.
 * The overlay feeds it each finished USER line from the call transcript (voice
 * or typed — both land there) and keeps the returned state. Playback itself is
 * the overlay's on-face video layer over the avatar — same window, never a
 * popup — streamed from the auth-gated /api/avatar/spicy route.
 *
 * Doctrine unchanged: SPICY MODE is Classic-initiated only (persona.ts clause,
 * locked). This module only ever ARMS on his explicit words; nothing here
 * self-initiates. No regex lookbehind (macOS 12 WKWebView).
 */

export type SpicyAction = "none" | "play" | "stop";

export interface SpicyDecision {
  /** Spicy mode armed state AFTER this line. */
  armed: boolean;
  /** What the overlay should do with the on-face player. */
  action: SpicyAction;
}

const ARM = /\bspicy\s*mode\b/i;
const DISARM = /\b(exit|close|end|stop|leave)\b[^.!?]*\bspicy\s*mode\b|\bspicy\s*mode\b\s*(off|over|done)\b/i;
const PLAY =
  /\b(play|show|put\s+on|run|start)\b[^.!?]*\b(video|videos|clip|clips|movie)\b|\b(one\s+of\s+(your|her)\s+videos?)\b/i;
const STOP =
  /\b(stop|close|end|cut|kill)\b[^.!?]*\b(video|clip|movie)\b|\bback\s+to\s+you\b|\bthat'?s\s+enough\b/i;

/**
 * Decide what one finished user line means for the on-face spicy player.
 * Total: any input yields a valid decision; unknown text changes nothing.
 *
 * Order matters and is deliberate:
 *  1. disarm phrases beat everything (an exit is honored even mid-sentence);
 *  2. an ARM line that ALSO asks to play ("spicy mode — play one of your
 *     videos") arms and plays in one utterance, because that is exactly how
 *     Classic phrased the order;
 *  3. play/stop only work while ARMED — outside spicy mode the words "play a
 *     video" must never put these clips on her face.
 */
export function decideSpicy(line: string, armed: boolean): SpicyDecision {
  const text = typeof line === "string" ? line : "";
  if (DISARM.test(text)) {
    return { armed: false, action: armed ? "stop" : "none" };
  }
  const arming = ARM.test(text);
  const nowArmed = armed || arming;
  if (!nowArmed) return { armed: false, action: "none" };
  if (STOP.test(text) && !PLAY.test(text)) {
    return { armed: nowArmed, action: "stop" };
  }
  if (PLAY.test(text)) return { armed: nowArmed, action: "play" };
  return { armed: nowArmed, action: "none" };
}

/** Pick a clip name from the list — index comes from the caller so this stays
 *  pure (the overlay passes Math.random()). Avoids repeating `last` when there
 *  is any alternative. */
export function pickSpicyClip(
  clips: readonly string[],
  rand: number,
  last: string | null,
): string | null {
  if (!Array.isArray(clips) || clips.length === 0) return null;
  const pool =
    clips.length > 1 && last ? clips.filter((c) => c !== last) : clips;
  const r = Number.isFinite(rand) ? Math.min(Math.max(rand, 0), 0.999999) : 0;
  return pool[Math.floor(r * pool.length)] ?? pool[0];
}
