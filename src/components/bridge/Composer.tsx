"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";

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

/**
 * Pill composer: one call button (left) + auto-growing textarea + send button.
 * Enter submits, Shift+Enter inserts a newline. There is a SINGLE voice entry —
 * the call button — which opens the full-screen call with her face (`onCall`).
 * The old redundant "mic" launcher was removed (it duplicated the call button).
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onCall,
  recording,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCall?: () => void;
  recording?: boolean;
  placeholder?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [value]);

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
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
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
  );
}
