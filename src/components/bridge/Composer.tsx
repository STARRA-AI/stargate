"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent } from "react";
import { MicStateBadge } from "./MicStateBadge";

function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <line x1="12" y1="19" x2="12" y2="5" />
      <path d="M6 11l6-6 6 6" />
    </svg>
  );
}

/** Waveform-bars glyph for the voice-call button — distinct from the dictation
 * mic icon. Five vertical bars, center-weighted heights, Grok-style. */
function CallWaveIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="2" y1="9" x2="2" y2="15" />
      <line x1="7" y1="5" x2="7" y2="19" />
      <line x1="12" y1="2" x2="12" y2="22" />
      <line x1="17" y1="5" x2="17" y2="19" />
      <line x1="22" y1="9" x2="22" y2="15" />
    </svg>
  );
}

/** Matches `.composer-input { max-height: 160px }` in deck.css. */
const MAX_PILL_HEIGHT = 160;

/**
 * Pill composer: one call button (left) + auto-growing textarea + send button.
 * Enter submits, Shift+Enter inserts a newline. There is a SINGLE voice entry —
 * the call button — which opens the full-screen call with her face (`onCall`).
 *
 * MicStateBadge (G4) sits above the pill, still inside `.composer-dock`, so
 * it stays alongside the composer without disturbing the call button.
 *
 * ★ THE TEXTAREA IS UNCONTROLLED, AND THAT IS THE WHOLE POINT (2026-09-22).
 * It used to be `value={value} onChange={onChange}` with the draft held in
 * DeckConsole's `useState`. Every single character therefore re-rendered
 * DeckConsole — which rebuilds 14 `.wave-bar` spans (each with a fresh inline
 * style object) and the whole chip row on every keystroke, then re-runs an
 * effect that measures `scrollHeight`. React bailed out of MessageColumn via
 * `memo`, so the history was safe, but the head, the chips and this component
 * were not.
 *
 * Now the DOM owns the draft: typing fires NO React render anywhere in the
 * tree. The value is read once, imperatively, at submit. The only per-keystroke
 * work left is `autosize`, which is coalesced to one measurement per frame and
 * skips the style write unless the height actually changed — i.e. it does
 * nothing at all except on the characters that wrap a new line.
 *
 * Consequence to respect: nothing outside can set the draft text. Nothing did
 * (the chips call `submit(label)` directly, never through the box). If a future
 * caller needs to prefill it, expose an imperative handle — do NOT restore the
 * controlled prop, which is the regression this comment exists to prevent.
 */
export function Composer({
  onSubmit,
  onCall,
  recording,
  placeholder,
}: {
  /** Receives the draft text. Composer clears itself; the caller must not. */
  onSubmit: (text: string) => void;
  onCall?: () => void;
  recording?: boolean;
  placeholder?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const lastHeight = useRef(0);
  const rafRef = useRef<number | null>(null);

  /**
   * Grow the pill to fit its content. Writing `height: auto` and then READING
   * `scrollHeight` forces a synchronous layout — the browser cannot defer it,
   * because the read needs a settled box. So it happens at most once per frame,
   * and the early return makes every keystroke after the first in that frame
   * free rather than merely cheaper.
   */
  const autosize = useCallback(() => {
    if (rafRef.current !== null) return; // a measurement is already queued
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const ta = taRef.current;
      if (!ta) return;
      const prev = ta.style.height;
      ta.style.height = "auto";
      const next = Math.min(ta.scrollHeight, MAX_PILL_HEIGHT);
      if (next === lastHeight.current) {
        ta.style.height = prev; // put it back; nothing to change
        return;
      }
      lastHeight.current = next;
      ta.style.height = `${next}px`;
    });
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  /** Read the draft off the DOM, hand it up, and reset the box. */
  const send = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    const text = ta.value;
    if (!text.trim()) return;
    ta.value = "";
    lastHeight.current = 0; // force the shrink back to one row
    autosize();
    onSubmit(text);
  }, [autosize, onSubmit]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      <MicStateBadge />
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <button
          type="button"
          className={`call-btn${recording ? " recording" : ""}`}
          title="Call STARRA"
          onClick={onCall}
          aria-label="Call STARRA"
        >
          <CallWaveIcon />
        </button>
        <textarea
          ref={taRef}
          className="composer-input"
          defaultValue=""
          onInput={autosize}
          onKeyDown={onKeyDown}
          rows={1}
          placeholder={placeholder}
          autoComplete="off"
          aria-label="Console input"
        />
        <button type="submit" className="send-btn" aria-label="Send">
          <SendIcon />
        </button>
      </form>
    </>
  );
}
