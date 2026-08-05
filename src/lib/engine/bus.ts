/**
 * STARRA ENGINE — STATE BUS. The one CLIENT-SAFE module in the engine.
 *
 * "Everything working in conjunction" lives here: one store holding the live
 * truth so the mouth, the HUD, the call overlay and the Options panel stop
 * guessing separately. This is exactly the failure that was filmed — the header
 * said "STARRA is speaking..." for 8+ seconds while her mouth stayed shut in all
 * 32 sampled frames, because the TTS audio never reached an AnalyserNode and
 * nothing shared one truth.
 *
 * ── TWO NON-NEGOTIABLES ────────────────────────────────────────────────────
 * 1. NO SECRETS, EVER. This module holds provider IDs and booleans. It has no
 *    import path to config/providers/router/health, which is what keeps those
 *    modules out of the client bundle.
 * 2. HER VOICE OUTRANKS THE BUS. Publishing is synchronous, allocation-light,
 *    fully wrapped in try/catch, and NEVER awaits. A subscriber that throws
 *    cannot break — or even slow — the audio path that published to it. Nothing
 *    in here may block, delay or wedge playback.
 */

import { useSyncExternalStore } from "react";
import type { HudState } from "@/lib/tokens";
import { safeErrorMessage } from "./redact";

/** Where her voice is coming from right now. Matches speak.ts + useVoiceCall. */
export type VoiceSource = "ara" | "piper" | "webspeech" | "realtime" | null;

export interface EngineAffect {
  /** -1 … 1 */
  valence: number;
  /** 0 … 1 */
  arousal: number;
  /** Short label, e.g. "steady", "locked in". */
  state: string;
  /** Why she feels that way — one clause, for the HUD. */
  because: string;
}

export interface EngineBusError {
  at: number;
  where: string;
  /** Already redacted on the way in. */
  message: string;
}

export interface EngineBusState {
  /** True only while sound is ACTUALLY being produced (audio events, not text). */
  speaking: boolean;
  source: VoiceSource;
  /** The live analyser on her voice — the mouth's only honest input. */
  analyser: AnalyserNode | null;
  /**
   * True while the live call owns her voice — from summon (overlay open) to
   * call end, not merely while sound is flowing. While set, the chat TTS
   * stack (speak.ts) must not make a sound: ONE VOICE, the call's (Classic's
   * order, 2026-08-04 — two voices reached him at once).
   */
  callLive: boolean;
  hudState: HudState;
  affect: EngineAffect;
  /** capability → provider id, as resolved by the server router. */
  activeProviders: Record<string, string>;
  lastError: EngineBusError | null;
  updatedAt: number;
}

function initialState(): EngineBusState {
  return {
    speaking: false,
    source: null,
    analyser: null,
    callLive: false,
    hudState: "idle",
    affect: { valence: 0, arousal: 0.2, state: "steady", because: "" },
    activeProviders: {},
    lastError: null,
    updatedAt: 0,
  };
}

let state: EngineBusState = initialState();
const listeners = new Set<(s: EngineBusState) => void>();

/** Current truth. Identity is stable until something actually changes, which is
 * what makes it safe for useSyncExternalStore. */
export function getEngineState(): EngineBusState {
  return state;
}

/** Subscribe to changes. Returns an unsubscribe that is safe to call twice. */
export function subscribeEngine(fn: (s: EngineBusState) => void): () => void {
  try {
    listeners.add(fn);
  } catch {
    /* never let a bad subscriber break a caller */
  }
  return () => {
    try {
      listeners.delete(fn);
    } catch {
      /* idempotent */
    }
  };
}

function notify(): void {
  // Snapshot the set: a subscriber may unsubscribe (or subscribe) mid-notify.
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch {
      // A broken subscriber must never break her voice. Swallow, keep going.
    }
  }
}

/**
 * Merge a patch into the bus. Synchronous, total, never throws, returns nothing
 * to await. A patch that changes nothing keeps snapshot identity and notifies
 * no one (so React does not re-render for a no-op).
 */
export function publishEngineState(patch: Partial<EngineBusState>): void {
  try {
    if (!patch || typeof patch !== "object") return;
    let changed = false;
    for (const key of Object.keys(patch) as Array<keyof EngineBusState>) {
      if (key === "updatedAt") continue;
      if (!Object.is(state[key], patch[key])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    state = { ...state, ...patch, updatedAt: Date.now() };
    notify();
  } catch {
    /* the bus is best-effort observation — it fails silently, on purpose */
  }
}

/**
 * VOICE TRUTH — published by speak.ts from the audio element's own events and by
 * useVoiceCall for the realtime leg. Passing the analyser through the same call
 * is the point: "speaking" and "the thing that drives the mouth" can never drift.
 */
export function publishVoice(patch: {
  speaking?: boolean;
  source?: VoiceSource;
  analyser?: AnalyserNode | null;
}): void {
  try {
    const next: Partial<EngineBusState> = {};
    if (typeof patch?.speaking === "boolean") next.speaking = patch.speaking;
    if (patch && "source" in patch) next.source = patch.source ?? null;
    if (patch && "analyser" in patch) next.analyser = patch.analyser ?? null;
    publishEngineState(next);
  } catch {
    /* never throw inside an audio path */
  }
}

/**
 * CALL OWNERSHIP of her voice. Published by VoiceCallOverlay on open/close —
 * the whole call lifecycle, not just while sound is flowing — so speakStarra
 * can refuse to start a second voice at the source. Strict `=== true` on
 * purpose: only a deliberate claim may silence her chat voice.
 */
export function publishCallLive(live: boolean): void {
  publishEngineState({ callLive: live === true });
}

/** HUD state, for anything that renders her core. */
export function publishHudState(hudState: HudState): void {
  publishEngineState({ hudState });
}

/** Her affect, for the HUD copy. */
export function publishAffect(affect: Partial<EngineAffect>): void {
  try {
    const merged = { ...state.affect, ...(affect ?? {}) };
    const same =
      merged.valence === state.affect.valence &&
      merged.arousal === state.affect.arousal &&
      merged.state === state.affect.state &&
      merged.because === state.affect.because;
    if (same) return;
    publishEngineState({ affect: merged });
  } catch {
    /* best-effort */
  }
}

/** capability → provider id. Merges, so one capability update cannot blank the rest. */
export function publishActiveProviders(map: Record<string, string>): void {
  try {
    if (!map || typeof map !== "object") return;
    const merged = { ...state.activeProviders, ...map };
    const keys = new Set([...Object.keys(merged), ...Object.keys(state.activeProviders)]);
    let changed = false;
    for (const k of keys) {
      if (merged[k] !== state.activeProviders[k]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    publishEngineState({ activeProviders: merged });
  } catch {
    /* best-effort */
  }
}

/**
 * Last error, REDACTED on the way in — the client bus is rendered, so a raw
 * message here would be a credential on screen.
 */
export function publishEngineError(where: string, err: unknown): void {
  try {
    publishEngineState({
      lastError: {
        at: Date.now(),
        where: typeof where === "string" && where ? where : "unknown",
        message: safeErrorMessage(err),
      },
    });
  } catch {
    /* best-effort */
  }
}

export function clearEngineError(): void {
  publishEngineState({ lastError: null });
}

/** Test / hot-reload hook: drop all state and all subscribers. */
export function resetEngineBus(): void {
  state = initialState();
  listeners.clear();
}

/**
 * React binding. useSyncExternalStore is React 18+/19 and is already the idiom
 * this repo targets; the server snapshot is the same object, so SSR renders the
 * silent initial state instead of hydration-mismatching.
 */
export function useEngineBus(): EngineBusState {
  return useSyncExternalStore(subscribeEngine, getEngineState, getEngineState);
}
