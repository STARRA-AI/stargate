/**
 * DECK PREFS — the operator-tunable bits of boot and reply behaviour
 * (G2/G3, SHARED CONTRACT §2).
 *
 * Deliberately modelled on `src/lib/voice/wake-word.ts`: same `"1"`/`"0"`
 * string encoding, same "dispatch a CustomEvent on every write" shape, same
 * `typeof window === "undefined"` guard so importing this on the server is
 * harmless. Anything reading these values goes through this module — no
 * component touches localStorage for them directly, so there is exactly one
 * place a key name or a default can be wrong.
 *
 * Every read is defensive: a disabled/full/private-mode localStorage throws on
 * access, and none of these settings are worth breaking the deck over. A read
 * that fails returns the default; a write that fails is dropped silently and
 * the in-page value still applies for the session.
 */

const KEY_GREETING = "stargate.bootGreeting";
const KEY_GREETING_MUTED = "stargate.bootGreetingMuted";
const KEY_SYNC_REPLIES = "stargate.syncReplies";

/** CustomEvent dispatched on window after any pref write, so open UI refreshes. */
export const DECK_PREFS_EVENT = "stargate-deck-prefs";

/** What she says once the deck finishes booting, until Classic rewrites it. */
export const DEFAULT_BOOT_GREETING = "Evening, Classic.";

function readRaw(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null; // storage disabled — fall through to the default
  }
}

function writeRaw(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* quota/private mode — the setting just won't persist */
  }
  try {
    window.dispatchEvent(new CustomEvent(DECK_PREFS_EVENT, { detail: { key } }));
  } catch {
    /* notification only */
  }
}

/**
 * The line she speaks after boot. An empty/whitespace stored value falls back
 * to the default rather than producing a silent boot — clearing the field is
 * far more likely to be a slip than an intent, and muting has its own switch
 * (setBootGreetingMuted) that says so unambiguously.
 */
export function getBootGreeting(): string {
  const v = readRaw(KEY_GREETING);
  if (v === null) return DEFAULT_BOOT_GREETING;
  return v.trim() ? v : DEFAULT_BOOT_GREETING;
}

export function setBootGreeting(s: string): void {
  writeRaw(KEY_GREETING, s);
}

/** Default FALSE — she greets on boot unless Classic silences her. */
export function getBootGreetingMuted(): boolean {
  return readRaw(KEY_GREETING_MUTED) === "1";
}

export function setBootGreetingMuted(b: boolean): void {
  writeRaw(KEY_GREETING_MUTED, b ? "1" : "0");
}

/**
 * SYNC REPLIES — hold the streamed text back until her voice actually starts,
 * so the reveal lands with the audio instead of racing ahead of it.
 *
 * DEFAULT FALSE, and that default is load-bearing: OFF is byte-for-byte
 * today's behaviour (text streams in as it arrives). Anyone who never touches
 * this setting must not be able to tell G3 shipped.
 */
export function getSyncReplies(): boolean {
  return readRaw(KEY_SYNC_REPLIES) === "1";
}

export function setSyncReplies(b: boolean): void {
  writeRaw(KEY_SYNC_REPLIES, b ? "1" : "0");
}

/**
 * CALL ENGINE — which engine the NEXT summoned call runs on.
 *
 * "normal" is the hosted call the deck has always had. "private" is the
 * all-local one (src/lib/voice/usePrivateCall.ts): her own ears, her own brain,
 * her own mouth, nothing off this Mac.
 *
 * DEFAULT "normal", and that default is load-bearing in the same way
 * getSyncReplies' is: an operator who never touches this setting must not be
 * able to tell the private engine shipped. Anything stored that is not exactly
 * "private" reads as normal — a corrupted or hand-edited value falls back to
 * the lane that is known to work, never silently to the slower one.
 */
export type CallEngine = "normal" | "private";

const KEY_CALL_ENGINE = "stargate.callEngine";

export function getCallEngine(): CallEngine {
  return readRaw(KEY_CALL_ENGINE) === "private" ? "private" : "normal";
}

export function setCallEngine(e: CallEngine): void {
  writeRaw(KEY_CALL_ENGINE, e === "private" ? "private" : "normal");
}
