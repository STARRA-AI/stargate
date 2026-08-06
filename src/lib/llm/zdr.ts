/**
 * ZERO DATA RETENTION — verified, not trusted.
 *
 * What Classic and STARRA say to each other is nobody else's. xAI reports the
 * live state of the setting on EVERY response, in the `x-zero-data-retention`
 * header, so this module reads it from the wire instead of trusting a toggle
 * that was flipped once and never re-checked.
 *
 * UNVERIFIED HERE ON PURPOSE: this file makes no claim about whether ZDR is
 * currently on for Classic's account. It records whatever xAI actually said on
 * the last response. The toggle lives in the xAI Console and only Classic can
 * flip it — see docs/ONE_BRAIN.md for the curl that reads it by hand.
 *
 * Process-local state, deliberately: it is a cache of the last observed header,
 * not a setting. A restart re-learns it from the first response.
 */

let checked = false;
let enabled = false;
let lastSeen: string | null = null;

/**
 * Record the header from a hosted response.
 *
 * Only xAI publishes it — Groq has no such header, so a `null` from any
 * provider is "nothing was reported", never "retention is on". Reading absence
 * as a failure would close the lane on the provider that simply does not speak
 * this dialect.
 */
export function recordZdrHeader(provider: string, header: string | null): void {
  if (provider !== "grok") return; // only xAI reports this
  if (header === null) return;
  checked = true;
  lastSeen = header;
  enabled = header.trim().toLowerCase() === "true";
}

export function zdrState(): {
  checked: boolean;
  enabled: boolean;
  lastSeen: string | null;
} {
  return { checked, enabled, lastSeen };
}

/**
 * True once xAI has been SEEN reporting that retention is NOT zero.
 *
 * Before any evidence this returns false — the first call has to be made before
 * a header can exist, and refusing to make it would mean she never speaks at
 * all. The moment xAI reports `false`, the caller closes the hosted lane and
 * says so out loud; when it reports `true` again, the lane reopens.
 */
export function zdrBlocksHostedLane(): boolean {
  return checked && !enabled;
}

/** Test seam. */
export function __resetZdr(): void {
  checked = false;
  enabled = false;
  lastSeen = null;
}
