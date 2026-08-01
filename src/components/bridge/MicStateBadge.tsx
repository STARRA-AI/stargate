"use client";

/**
 * Three-way mic-state control + persistent OPEN MIC indicator (G4).
 *
 * Reads/writes Agent A's `@/lib/voice/mic-state` (SHARED CONTRACT §1) via
 * the same dynamic-import idiom as WakeWordToggle
 * (src/app/settings/page.tsx:65-96) — this component never holds the mode
 * as its own truth, it only mirrors mic-state's module-scope variable and
 * calls its setter. It never touches localStorage itself: mic-state.ts is
 * the only place "open" is allowed to live, and only in memory, so a reload
 * always comes back to WAKE WORD.
 *
 * Mounted by Composer.tsx, inside `.composer-dock` — a fixed, non-scrolling
 * region on both the desktop console and the mobile console — so the OPEN
 * MIC banner below stays on screen for as long as the mode is armed.
 *
 * Arming OPEN MIC is a deliberate two-step action: the ARM button reveals an
 * inline CONFIRM/CANCEL pair; nothing sets "open" on a single click. Once
 * armed, the persistent banner carries its own DISARM control so the
 * operator never has to hunt for a way back down.
 */
import { useEffect, useRef, useState } from "react";

type MicMode = "muted" | "wake" | "open";

type MicStateModule = {
  getMicMode: () => MicMode;
  setMicMode: (m: MicMode) => void;
  subscribeMicMode: (fn: (m: MicMode) => void) => () => void;
};

export function MicStateBadge() {
  const [mode, setModeState] = useState<MicMode>("wake");
  const [confirming, setConfirming] = useState(false);
  const modRef = useRef<MicStateModule | null>(null);

  useEffect(() => {
    let mounted = true;
    let unsubscribe: (() => void) | undefined;
    void import("@/lib/voice/mic-state").then((mod) => {
      if (!mounted) return;
      modRef.current = mod;
      setModeState(mod.getMicMode());
      unsubscribe = mod.subscribeMicMode((m: MicMode) => setModeState(m));
    });
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  function apply(next: MicMode) {
    modRef.current?.setMicMode(next);
    setModeState(next);
    setConfirming(false);
  }

  return (
    <div className="mic-state">
      <div className="mic-state-row" role="group" aria-label="Microphone mode">
        <button
          type="button"
          className="mic-mode-btn"
          aria-pressed={mode === "muted"}
          onClick={() => apply("muted")}
        >
          MUTED
        </button>
        <button
          type="button"
          className="mic-mode-btn"
          aria-pressed={mode === "wake"}
          onClick={() => apply("wake")}
        >
          WAKE WORD
        </button>
        {mode === "open" ? (
          <button
            type="button"
            className="mic-mode-btn mic-mode-open on"
            aria-pressed
            onClick={() => apply("wake")}
          >
            DISARM OPEN MIC
          </button>
        ) : confirming ? (
          <span className="mic-confirm">
            <span className="mic-confirm-copy">
              Arm open mic — always listening, resets to wake word on reload?
            </span>
            <button
              type="button"
              className="mic-mode-btn mic-confirm-yes"
              onClick={() => apply("open")}
            >
              CONFIRM ARM
            </button>
            <button
              type="button"
              className="mic-mode-btn"
              onClick={() => setConfirming(false)}
            >
              CANCEL
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="mic-mode-btn mic-mode-open"
            aria-pressed={false}
            onClick={() => setConfirming(true)}
          >
            ARM OPEN MIC…
          </button>
        )}
      </div>
      {mode === "open" ? (
        <div className="mic-open-banner" role="status">
          <span className="mic-open-dot" aria-hidden />
          OPEN MIC ARMED — LISTENING CONTINUOUSLY
        </div>
      ) : null}
    </div>
  );
}
