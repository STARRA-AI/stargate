"use client";

/**
 * Voice cost meter — the deck's only real per-minute cost is the xAI Grok
 * Realtime voice session ($0.08/min of connection time on the model actually
 * running; see VOICE_RATE_PER_MIN). This tracks accrued call time for the
 * current calendar month in localStorage (client-only, no backend, no keys).
 * Everything else in the stack (Kimi/Groq chat, local Ollama, search) is free or
 * negligible, so it's deliberately not metered here.
 *
 * ★ NOTHING RENDERS THIS YET. `getVoiceUsage()` has no callers repo-wide and no
 * surface shows a dollar figure, so the tally accrues and is never displayed —
 * do not read a correct rate here as a number anyone can see. Verified by
 * grepping the repo 2026-09-30.
 */

/**
 * xAI Grok Realtime voice list price, USD per minute of connection time.
 *
 * ★ CORRECTED 2026-09-30, AND THE CORRECTION IS THE POINT. This was 0.05 with a
 * comment that said it was "only correct while the model pin holds" and that the
 * pin at src/app/api/realtime/route.ts is "applied to the socket as `?model=`".
 * MEASURED ON THE WIRE: the pin is NOT honoured. With the socket opened as
 * `?model=grok-voice-think-fast-1.0`, xAI's own `session.created` event reports
 * model `grok-voice-think-fast-2.0`. The 2.0 rate is what is being charged, so
 * the meter's rate is the 2.0 rate: "$0.08 / min ($4.80 / hr) audio" per
 * https://docs.x.ai/docs/models (1.0 is listed at $0.05 / min).
 *
 * The old comment was not just stale, it was load-bearing: it told every reader
 * that 0.05 was safe because of a pin that does nothing.
 *
 * WHAT THE SERVER SAYS IS THE ONLY SOURCE. useVoiceCall.ts now reads
 * `session.model` off `session.created` and reports it on the ops feed, so the
 * next model (and price) change is visible instead of inferred from a pin.
 */
export const VOICE_RATE_PER_MIN = 0.08;

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
