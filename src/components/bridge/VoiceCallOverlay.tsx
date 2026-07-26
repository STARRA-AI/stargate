"use client";

import { useEffect, useMemo, useRef } from "react";
import { useVoiceCall, type VoiceCallState } from "@/lib/voice/useVoiceCall";

function statusCopy(state: VoiceCallState): string {
  switch (state) {
    case "listening":
      return "Listening…";
    case "speaking":
      return "STARRA is speaking…";
    case "reconnecting":
      return "Reconnecting…";
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
 * Settings → Link APIs"). The mic-blocked message deliberately says "System
 * Preferences", not "Settings", so it never matches here. */
function pointsToSettings(message: string): boolean {
  return /settings/i.test(message);
}

/**
 * FaceTime-style full-screen voice call with STARRA. Her face fills the screen;
 * it switches clips on call state (idle ⇄ attentive-listening ⇄ talking) and its
 * intensity tracks her live voice amplitude (getAssistantLevel, rAF-polled into
 * the --starra-level CSS var). No transcript — just her, like a real call. All
 * call/audio plumbing lives in useVoiceCall(); this drives connect()/disconnect()
 * off the `open` prop and renders the engine's state.
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
    connect,
    disconnect,
    muted,
    toggleMute,
    getAssistantLevel,
  } = useVoiceCall();

  const panelRef = useRef<HTMLDivElement>(null);
  const endBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const faceStageRef = useRef<HTMLDivElement>(null);
  const idleVideoRef = useRef<HTMLVideoElement>(null);
  const talkVideoRef = useRef<HTMLVideoElement>(null);
  const listenVideoRef = useRef<HTMLVideoElement>(null);
  const ringbackRef = useRef<HTMLAudioElement>(null);

  // Mirror connect/disconnect in refs so the open/close effect reacts only to
  // `open` itself, not to callback identity churn as the engine advances
  // through its states — reacting to that churn would tear the call down.
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

  // Belt-and-suspenders: tear the engine down if this unmounts mid-call.
  useEffect(() => {
    return () => {
      disconnectRef.current();
    };
  }, []);

  // Only decode the clip that's actually on screen — idle always loops; the
  // talking clip plays only while she speaks, the listening clip only while she
  // listens. Keeps two portrait videos from decoding at once on an older Mac.
  useEffect(() => {
    const idle = idleVideoRef.current;
    const talk = talkVideoRef.current;
    const listen = listenVideoRef.current;
    const onScreenClip = state === "speaking" ? "talk" : state === "listening" ? "listen" : "idle";
    // Only the on-screen clip decodes; the other two are paused. Idle is the base
    // layer for connecting/reconnecting/idle/error.
    if (talk) {
      if (onScreenClip === "talk") void talk.play().catch(() => {});
      else talk.pause();
    }
    if (listen) {
      if (onScreenClip === "listen") void listen.play().catch(() => {});
      else listen.pause();
    }
    if (idle) {
      if (onScreenClip === "idle") void idle.play().catch(() => {});
      else idle.pause();
    }
  }, [state]);

  // Ringback: her song plays softly while the line is connecting (like calling a
  // real person), then fades out the moment she picks up (listening/speaking).
  // Muted-video autoplay is always allowed; audio autoplay needs the call-button
  // click's transient activation, which we have. Fails silent if blocked.
  useEffect(() => {
    const a = ringbackRef.current;
    if (!a) return;
    const connecting = state === "connecting" || state === "idle";
    if (connecting) {
      a.volume = 0.35;
      void a.play().catch(() => {});
    } else {
      // fade out over ~600ms, then pause (she's on the line now)
      const start = a.volume;
      const t0 = typeof performance !== "undefined" ? performance.now() : 0;
      const fade = () => {
        const el = ringbackRef.current;
        if (!el) return;
        const p = Math.min(1, ((typeof performance !== "undefined" ? performance.now() : 0) - t0) / 600);
        el.volume = start * (1 - p);
        if (p < 1) requestAnimationFrame(fade);
        else { el.pause(); el.currentTime = 0; }
      };
      requestAnimationFrame(fade);
    }
  }, [state]);

  // Audio-reactive face: push her live loudness (0..1) into a CSS var every
  // animation frame so her glow/scale track what she's actually saying. rAF, no
  // re-render per audio frame. getAssistantLevel is stable, so this runs once
  // per open.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const el = faceStageRef.current;
    // Only drive the reactive var while she's actually speaking — no 60fps DOM
    // writes when she's idle/listening (that's wasted CPU on an older Mac).
    if (state !== "speaking") {
      el?.style.setProperty("--starra-level", "0");
      return;
    }
    let raf = 0;
    const tick = () => {
      faceStageRef.current?.style.setProperty("--starra-level", getAssistantLevel().toFixed(3));
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [open, state, getAssistantLevel]);

  // Focus management: move focus into the call on open, trap Tab, restore on
  // close. aria-modal is only a hint — the browser enforces none of this.
  useEffect(() => {
    if (typeof window === "undefined" || !open) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => {
      (endBtnRef.current ?? panelRef.current)?.focus();
    }, 0);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  const settingsLink = useMemo(
    () => (error && pointsToSettings(error) ? "/settings#link-apis" : null),
    [error],
  );

  if (!open) return null;

  function endCall() {
    disconnect();
    onClose();
  }

  // Which face clip is showing: her talking loop, her attentive-listening face,
  // or the calm idle (connecting / reconnecting / error all fall back to idle).
  const faceMode =
    state === "speaking" ? "speaking" : state === "listening" ? "listening" : "idle";
  const statusText =
    state === "error" && /microphone/i.test(error || "")
      ? "Microphone blocked"
      : statusCopy(state);

  return (
    <div
      className="call-overlay call-facetime"
      role="dialog"
      aria-modal="true"
      aria-label="Voice call with STARRA"
      ref={panelRef}
      tabIndex={-1}
    >
      {/* Her song as the ringback while the line connects (fades out on pickup). */}
      <audio ref={ringbackRef} src="/avatar/starra-ringback.mp3" loop preload="auto" aria-hidden />

      {/* Full-screen face — she's shown head-down (contain), with a soft blurred
          copy of her filling the screen behind (FaceTime/iOS portrait framing),
          so nothing is cropped close and there are no black bars. */}
      <div className={`call-face-stage call-face-${faceMode}`} ref={faceStageRef}>
        <video
          className="call-face-backdrop"
          src="/avatar/starra-idle.mp4"
          autoPlay
          loop
          muted
          playsInline
          aria-hidden
        />
        <video
          ref={idleVideoRef}
          className="call-face-video call-face-idle"
          src="/avatar/starra-idle.mp4"
          autoPlay
          loop
          muted
          playsInline
          aria-hidden
        />
        <video
          ref={listenVideoRef}
          className="call-face-video call-face-listen"
          src="/avatar/starra-listening.mp4"
          loop
          muted
          playsInline
          aria-hidden
        />
        <video
          ref={talkVideoRef}
          className="call-face-video call-face-talk"
          src="/avatar/starra-talking.mp4"
          loop
          muted
          playsInline
          aria-hidden
        />
        {/* speaking glow — intensity rides her live voice (--starra-level) */}
        <div className="call-face-glow" aria-hidden />
        {/* readability scrim behind the top status + bottom controls */}
        <div className="call-face-scrim" aria-hidden />
      </div>

      <div className="call-ft-top">
        <span className="call-kicker">STARRA</span>
        <span
          className={`call-status${state === "error" ? " is-error" : ""}`}
          aria-live="polite"
        >
          {statusText}
        </span>
      </div>

      {state === "error" && error ? (
        <div className="call-error-box call-ft-error" role="alert">
          <span className="call-error-text">{error}</span>
          {settingsLink ? (
            <a className="call-error-link" href={settingsLink}>
              Open Settings → Link APIs
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="call-ft-controls">
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

        <button type="button" className="call-end-btn" onClick={endCall} ref={endBtnRef}>
          END CALL
        </button>
      </div>
    </div>
  );
}
