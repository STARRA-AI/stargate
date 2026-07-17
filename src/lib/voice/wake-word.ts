/** Desktop wake-word helpers — Book 1 §7 optional wake word. */

const STORAGE_KEY = "stargate.wakeWord";

/** Default on — Classic wants to say "starra" and wake her. */
export function getWakeWordEnabled(): boolean {
  if (typeof window === "undefined") return true;
  const v = localStorage.getItem(STORAGE_KEY);
  if (v === null) return true;
  return v === "1";
}

export function setWakeWordEnabled(on: boolean) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, on ? "1" : "0");
  window.dispatchEvent(
    new CustomEvent("stargate-wake-word", { detail: { on } }),
  );
}

/**
 * True if transcript is a wake (optionally followed by a command).
 * Matches: starra, hey starra, okay starra.
 */
export function matchWakeWord(transcript: string): {
  woke: boolean;
  command: string;
} {
  const t = transcript.trim();
  if (!t) return { woke: false, command: "" };
  const re = /^(?:hey\s+|ok(?:ay)?\s+)?starra[\s,.!?]*(.*)$/i;
  const m = t.match(re);
  if (!m) return { woke: false, command: "" };
  return { woke: true, command: (m[1] ?? "").trim() };
}
