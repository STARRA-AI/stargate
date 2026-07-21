"use client";

import { useEffect, useMemo, useRef } from "react";
import { useVoiceCall, type VoiceCallState } from "@/lib/voice/useVoiceCall";

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      aria-hidden
    >
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

function statusCopy(state: VoiceCallState): string {
  switch (state) {
    case "listening":
      return "Listening…";
    case "speaking":
      return "STARRA is speaking…";
    case "error":
      return "Voice link down.";
    case "connecting":
    case "idle":
    default:
      return "Connecting…";
  }
}

/** True when connect()'s surfaced error is the "no xAI key linked" stub-mode
 * message from /api/realtime (its stub copy reads "...link the xAI key in
 * Settings → Link APIs") — used to show a direct link instead of a bare
 * error string. */
function pointsToSettings(message: string): boolean {
  return /settings/i.test(message);
}

/**
 * Grok-style full-duplex voice call overlay. Presentation only — all call
 * state/audio plumbing lives in useVoiceCall(); this component just drives
 * connect()/disconnect() off the `open` prop and renders the engine's state.
 */
export function VoiceCallOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    state,
    error,
    transcript,
    liveUser,
    liveAssistant,
    connect,
    disconnect,
    muted,
    toggleMute,
  } = useVoiceCall();

  // Mirror connect/disconnect in refs so the open/close effect below reacts
  // only to `open` itself, not to callback identity churn as the engine
  // advances through connecting -> listening -> speaking — reacting to that
  // churn would tear the call down mid-conversation.
  const connectRef = useRef(connect);
  const disconnectRef = useRef(disconnect);
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);
  useEffect(() => {
    disconnectRef.current = disconnect;
  }, [disconnect]);

  useEffect(() => {
    if (typeof window === "undefined") return; // SSR: nothing to connect to
    if (open) {
      void connectRef.current();
    } else {
      disconnectRef.current();
    }
  }, [open]);

  // Belt-and-suspenders: tear the engine down if this ever unmounts while a
  // call is live (e.g. the deck itself unmounts mid-call).
  useEffect(() => {
    return () => {
      disconnectRef.current();
    };
  }, []);

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
  }, [transcript, liveUser, liveAssistant]);

  const settingsLink = useMemo(
    () => (error && pointsToSettings(error) ? "/settings#link-apis" : null),
    [error],
  );

  if (!open) return null;

  function endCall() {
    disconnect();
    onClose();
  }

  const orbState = state === "idle" ? "connecting" : state;
  const isEmpty = transcript.length === 0 && !liveUser && !liveAssistant;

  return (
    <div
      className="call-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Voice call with STARRA"
    >
      <div className="call-panel">
        <button
          type="button"
          className="call-close-btn"
          onClick={endCall}
          aria-label="End call and close"
          title="Close"
        >
          <CloseIcon />
        </button>

        <div className="call-head">
          <span className="call-kicker">STARRA VOICE LINK</span>
          <span
            className={`call-status${state === "error" ? " is-error" : ""}`}
            aria-live="polite"
          >
            {statusCopy(state)}
          </span>
        </div>

        <div className="call-orb-stage">
          <div className={`call-orb call-orb-${orbState}`} aria-hidden />
        </div>

        {state === "error" && error ? (
          <div className="call-error-box" role="alert">
            <span className="call-error-text">{error}</span>
            {settingsLink ? (
              <a className="call-error-link" href={settingsLink}>
                Open Settings → Link APIs
              </a>
            ) : null}
          </div>
        ) : null}

        <div className="call-transcript" ref={transcriptRef}>
          {isEmpty ? (
            <span className="call-transcript-empty">
              {state === "error"
                ? "No line yet."
                : state === "connecting" || state === "idle"
                  ? "Opening the line…"
                  : "Say something — STARRA is on the line."}
            </span>
          ) : (
            <>
              {transcript.map((line, i) => (
                <div key={`${line.role}-${i}`} className={`call-turn call-turn-${line.role}`}>
                  <span className="call-turn-label">
                    {line.role === "user" ? "YOU" : "STARRA"}
                  </span>
                  {line.role === "user" ? (
                    <span className="call-bubble-user">{line.text}</span>
                  ) : (
                    <span className="call-line-assistant">{line.text}</span>
                  )}
                </div>
              ))}
              {liveUser ? (
                <div className="call-turn call-turn-user">
                  <span className="call-turn-label">YOU</span>
                  <span className="call-bubble-user is-live">{liveUser}</span>
                </div>
              ) : null}
              {liveAssistant ? (
                <div className="call-turn call-turn-assistant">
                  <span className="call-turn-label">STARRA</span>
                  <span className="call-line-assistant is-live">{liveAssistant}</span>
                </div>
              ) : null}
            </>
          )}
        </div>

        <div className="call-controls">
          <button
            type="button"
            className={`call-mute-btn${muted ? " is-muted" : ""}`}
            onClick={toggleMute}
            aria-pressed={muted}
          >
            {muted ? "UNMUTE" : "MUTE"}
          </button>

          {state === "error" ? (
            <button type="button" className="call-retry-btn" onClick={() => void connect()}>
              RETRY
            </button>
          ) : null}

          <button type="button" className="call-end-btn" onClick={endCall}>
            END CALL
          </button>
        </div>
      </div>
    </div>
  );
}
