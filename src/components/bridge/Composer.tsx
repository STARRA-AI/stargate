"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";

function MicIcon() {
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
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
    </svg>
  );
}

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

/**
 * Pill composer: mic button + auto-growing textarea + send button.
 * Enter submits, Shift+Enter inserts a newline. Presentation only — `onSubmit`
 * and `onMic` carry the existing DeckConsole behavior.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onMic,
  recording,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onMic?: () => void;
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
        className={`mic-btn${recording ? " recording" : ""}`}
        title="Voice input"
        onClick={onMic}
        aria-label="Microphone"
      >
        <MicIcon />
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
