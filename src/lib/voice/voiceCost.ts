"use client";

/**
 * Voice cost meter — the deck's only real per-minute cost is the xAI Grok
 * Realtime voice session ($0.05/min of connection time). This tracks accrued
 * call time for the current calendar month in localStorage (client-only, no
 * backend, no keys) so the operator can see a running estimate instead of
 * guessing. Everything else in the stack (Kimi/Groq chat, local Ollama, search)
 * is free or negligible, so it's deliberately not metered here.
 */

/**
 * xAI Grok Realtime voice list price, USD per minute of connection time.
 *
 * THIS NUMBER IS ONLY CORRECT WHILE THE MODEL PIN HOLDS. It is the
 * `grok-voice-think-fast-1.0` rate — "$0.05 / min ($3.00 / hr) audio" per
 * https://docs.x.ai/docs/models (fetched 2026-07-31). The same page lists
 * `grok-voice-think-fast-2.0` at "$0.08 / min ($4.80 / hr) audio".
 *
 * So: unpinning to 2.0 makes this 0.08, not 0.05 — a 60% under-report if it is
 * left alone. The pin lives at
 * src/app/api/realtime/route.ts::XAI_REALTIME_DEFAULT_MODEL and is applied to
 * the socket as `?model=`. If that pin is ever moved to 2.0 (or relaxed back to
 * the `grok-voice-latest` alias, which xAI repoints to 2.0 on 2026-08-05),
 * this constant MUST move to 0.08 in the same commit or the meter lies.
 */
export const VOICE_RATE_PER_MIN = 0.05;

const STORAGE_KEY = "starra-voice-usage";
/** Fired after a tally update so any open readout can refresh live. */
export const VOICE_USAGE_EVENT = "starra-voice-usage";

type Usage = { month: string; seconds: number };

/** YYYY-MM in local time — the tally auto-resets when this rolls over. */
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function read(): Usage {
  const empty = { month: currentMonth(), seconds: 0 };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const u = JSON.parse(raw) as Usage;
    // A new month starts a fresh tally rather than carrying the old total over.
    return u.month === empty.month ? u : empty;
  } catch {
    return empty;
  }
}

function write(u: Usage): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(u));
    window.dispatchEvent(new Event(VOICE_USAGE_EVENT));
  } catch {
    /* storage disabled (private mode, quota) — meter just won't persist */
  }
}

/** Add elapsed call seconds to this month's tally. No-op for non-positive input. */
export function addVoiceSeconds(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const u = read(); // already reset if the month rolled over
  write({ month: u.month, seconds: u.seconds + seconds });
}

export interface VoiceUsage {
  seconds: number;
  minutes: number;
  dollars: number;
}

export function getVoiceUsage(): VoiceUsage {
  const { seconds } = read();
  const minutes = seconds / 60;
  return { seconds, minutes, dollars: minutes * VOICE_RATE_PER_MIN };
}
