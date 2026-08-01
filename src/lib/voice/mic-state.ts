/**
 * MIC STATE — the one source of truth for what the microphone is allowed to do
 * (G4, SHARED CONTRACT §1).
 *
 * Three explicit states, one outer machine:
 *
 *   MUTED  — no recognizer runs at all. Nothing is listening.
 *   WAKE   — today's behaviour, unchanged: the wake-word listener runs while
 *            idle and only a wake phrase opens a turn. THE DEFAULT.
 *   OPEN   — continuous transcription; every final result is sent as input.
 *
 * WHY THIS MODULE EXISTS SEPARATELY FROM wake-word.ts: `wake-word.ts` is a
 * persisted user PREFERENCE ("do I want the wake word on?", localStorage
 * `stargate.wakeWord`, default ON). It stays exactly that — the sub-preference
 * that applies while this machine is in WAKE. This module is the outer state,
 * and it is deliberately NOT a preference.
 *
 * ============================ THE HARD RULE ============================
 * OPEN MIC IS IN-MEMORY ONLY. Never localStorage, never sessionStorage, never
 * a cookie. It must never be the initial value and must never survive a
 * reload.
 *
 * WHY, plainly: OPEN MIC means the microphone is live and transcribing with no
 * wake phrase in front of it. A persisted "open" would mean Classic opens the
 * deck one morning and it is already listening to the room because of a button
 * he pressed days ago. An always-listening mic must be re-armed by a person,
 * every session, on purpose — so the only safe storage is the kind that dies
 * with the page. That is why the state lives in a module-scope variable and
 * this file imports no storage API at all: there is nothing here to misuse.
 *
 * The reload path is therefore not a bug to be worked around — it IS the
 * safety property. tests/mic-state.test.ts asserts no storage write happens.
 * =======================================================================
 */

export type MicMode = "muted" | "wake" | "open";

/** CustomEvent<{ mode: MicMode }> dispatched on window after every change. */
export const MIC_MODE_EVENT = "stargate-mic-mode";

/**
 * THE state. Module scope, in memory, gone on reload — see the hard rule above.
 * Starts at "wake" so a fresh page is always in the safe, wake-gated mode.
 */
let micMode: MicMode = "wake";

/**
 * In-process subscribers. Kept alongside the window event rather than instead
 * of it: the event lets any component react without importing this module,
 * while direct subscribers work in a test/SSR context where `window` is absent.
 */
const listeners = new Set<(m: MicMode) => void>();

export function getMicMode(): MicMode {
  return micMode;
}

/**
 * Set the mode and tell everyone. No-ops when the mode is unchanged so a
 * component that re-applies its current mode cannot cause a notify loop.
 *
 * NOTE ON "open": this setter does not gate it, because the gate belongs to the
 * UI — arming is a deliberate two-step operator action (see MicStateBadge's
 * ARM/CONFIRM pair). What this module guarantees is narrower and more
 * important: "open" is never the INITIAL value and is never written anywhere
 * that outlives the page.
 */
export function setMicMode(m: MicMode): void {
  if (m === micMode) return;
  micMode = m;
  for (const fn of [...listeners]) {
    try {
      fn(m);
    } catch {
      /* one bad subscriber must not stop the others, or the mic UI desyncs */
    }
  }
  if (typeof window !== "undefined") {
    try {
      window.dispatchEvent(new CustomEvent(MIC_MODE_EVENT, { detail: { mode: m } }));
    } catch {
      /* event dispatch is notification only — never the source of truth */
    }
  }
}

/** Subscribe to mode changes. Returns an unsubscribe. Does NOT fire on subscribe. */
export function subscribeMicMode(fn: (m: MicMode) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * TEST-ONLY reset back to the initial state. Exported because each test needs a
 * clean module, and a module-scope variable would otherwise leak between them.
 * Not used by app code.
 */
export function __resetMicModeForTests(): void {
  micMode = "wake";
  listeners.clear();
}
