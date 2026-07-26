"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  REALTIME_SAMPLE_RATE,
  decodePlaybackFrame,
  encodeMicFrame,
  rms,
} from "@/lib/voice/pcm-audio";
import { addVoiceSeconds } from "@/lib/voice/voiceCost";
import { STARRA_VOICE_PERSONA } from "@/lib/persona";

/**
 * Client engine for a full-duplex voice call against xAI's Realtime API.
 *
 * Protocol notes (verified live against a real xAI WS session — see the
 * handoff this hook was built from):
 *  - Token comes from `POST /api/realtime` (already built), which returns
 *    `{ mode: "live", value, url, voice, model, expires_at }` on success, or
 *    `{ mode: "stub" | "error", message }` when no key is linked / xAI
 *    rejected the request.
 *  - WS auth is a subprotocol, not a header: `new WebSocket(url,
 *    ["xai-client-secret." + value])`.
 *  - On open we send one `session.update` with voice/instructions/
 *    turn_detection/audio format. We deliberately do NOT send `modalities`
 *    — xAI's realtime endpoint rejects that field (OpenAI-realtime-shaped
 *    clients often include it; this one must not).
 *  - `session.created` / `conversation.created` / `session.updated` /
 *    `ping` are the confirmed "just background chatter" events; only
 *    `session.updated` is used here (as the signal that the session is
 *    fully configured and the call is live).
 *
 * This hook owns only the call engine (state machine, mic capture, audio
 * playback, transcript assembly) — no UI. See useVoiceCall's return shape
 * for the full public surface.
 */

const XAI_REALTIME_WS_SUBPROTOCOL_PREFIX = "xai-client-secret.";

// Her ONE canonical spoken persona (STARGATE = her home; full personality —
// sexy, friendly, assistant + companion — canon-informed, not recited). Shared
// with the talking-avatar app. See src/lib/persona.ts.
const STARRA_INSTRUCTIONS = STARRA_VOICE_PERSONA;

/**
 * Client-side amplitude gate for barge-in, checked against the mic worklet's
 * RMS while assistant audio is playing. server_vad handles interruption
 * server-side too, but that's a network round-trip; cutting local playback
 * the instant the operator's mic crosses this threshold makes barge-in feel
 * instant, the way it does in Grok's voice mode.
 *
 * UNVERIFIED WITH A REAL MIC: this threshold is a reasonable starting
 * heuristic (typical room-noise RMS on Float32 [-1,1] samples is well under
 * 0.01; conversational speech is usually 0.02+), not something tuned against
 * real hardware. Flag for a listening pass — if barge-in is trigger-happy on
 * a noisy mic or a hot input gain, raise this; if it's sluggish, lower it.
 *
 * A single over-threshold frame is NOT enough to interrupt STARRA: a cough, a
 * clipped "mm-hm", or her own audio bleeding into the mic would all cross the
 * gate for one frame. We require BARGE_IN_CONSECUTIVE_FRAMES over-threshold
 * frames in a row before firing bargeIn, which reads as intentional speech
 * while still feeling instant. Any frame at or below the gate resets the streak,
 * so only sustained input counts.
 *
 * TUNED (was 0.02 / 3 frames / no grace — too trigger-happy: her own audio
 * bleed and background noise cut her off, and it couldn't tell voices apart).
 * Now it takes a clearly-louder, sustained utterance to interrupt her, and NO
 * barge-in fires in the first BARGE_IN_GRACE_MS after she starts speaking (so
 * her own onset / the echo tail never trips it). xAI's server_vad remains the
 * smart backstop for real turn-taking; this local gate is only the instant-cut.
 */
const BARGE_IN_RMS_THRESHOLD = 0.05;
const BARGE_IN_CONSECUTIVE_FRAMES = 7;
const BARGE_IN_GRACE_MS = 450;

export type VoiceCallState =
  | "idle"
  | "connecting"
  | "reconnecting"
  | "listening"
  | "speaking"
  | "error";

// The call survives transient socket drops (token expiry, idle timeouts, blips)
// by re-minting a fresh token and re-opening, instead of dying with an error.
// It only gives up after this many consecutive failed attempts.
const MAX_RECONNECT_ATTEMPTS = 5;

export interface VoiceCallTranscriptLine {
  role: "user" | "assistant";
  text: string;
}

export interface UseVoiceCallResult {
  state: VoiceCallState;
  error: string | null;
  transcript: VoiceCallTranscriptLine[];
  liveUser: string;
  liveAssistant: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  muted: boolean;
  toggleMute: () => void;
  /** Live loudness (0..1) of her audio right now — 0 unless she's speaking.
   * rAF-poll this to drive the audio-reactive face (no re-render per frame). */
  getAssistantLevel: () => number;
}

type RealtimeTokenResponse = {
  mode?: string;
  value?: string;
  url?: string;
  voice?: string;
  model?: string;
  expires_at?: number;
  message?: string;
};

// ---- Loose, defensive JSON helpers -----------------------------------
// The realtime event surface is undocumented in places ("ALSO parse
// defensively" is a recurring instruction in this hook's spec), so every
// server event is treated as untyped JSON and narrowed field-by-field
// rather than cast to a rigid interface.

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

/** `response.done`'s response object usually carries the response id; some
 * delta/done events carry a top-level `response_id` instead. Try both. */
function currentAssistantResponseId(evt: Record<string, unknown>): string | undefined {
  return asString(evt.response_id) ?? asString(asRecord(evt.response)?.id);
}

/**
 * Authoritative transcript fallback: `response.done`'s payload includes the
 * full response, which (per xAI's docs) nests `output[].content[].transcript`
 * for audio content. Used only when no delta events supplied text for this
 * response — the normal path is deltas, this is a defensive backstop.
 */
function extractResponseTranscript(evt: Record<string, unknown>): string {
  const response = asRecord(evt.response);
  const output = asArray(response?.output) ?? [];
  const parts: string[] = [];

  for (const item of output) {
    const itemRecord = asRecord(item);
    const content = asArray(itemRecord?.content) ?? [];
    for (const contentItem of content) {
      const contentRecord = asRecord(contentItem);
      const text = asString(contentRecord?.transcript) ?? asString(contentRecord?.text);
      if (text) parts.push(text);
    }
  }

  return parts.join(" ").trim();
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? w.webkitAudioContext;
}

export function useVoiceCall(): UseVoiceCallResult {
  const [state, setState] = useState<VoiceCallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<VoiceCallTranscriptLine[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");
  const [muted, setMuted] = useState(false);

  // Refs mirror the state above for use inside long-lived callbacks
  // (ws.onmessage / worklet.port.onmessage are assigned once per connect()
  // call) so those handlers always read fresh values instead of closing
  // over a stale render's state.
  const stateRef = useRef<VoiceCallState>("idle");
  const mutedRef = useRef(false);
  const liveUserRef = useRef("");
  const liveAssistantRef = useRef("");

  const wsRef = useRef<WebSocket | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);

  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartRef = useRef(0);

  // Live loudness (0..1) of her currently-playing audio, for the audio-reactive
  // face. Quick attack, gradual decay so her on-screen animation tracks what she
  // is actually saying. Read via getAssistantLevel() (rAF-polled by the UI — no
  // re-render per audio frame).
  const assistantLevelRef = useRef(0);

  // Wall-clock start of the live connection, stamped on ws.onopen and consumed
  // once by cleanupInternal to bill the elapsed minutes to the voice meter.
  // Null whenever no session is live, so the defensive cleanup at connect()
  // start and repeated teardown calls never double-count.
  const callStartRef = useRef<number | null>(null);

  // Count of consecutive over-threshold mic frames seen while STARRA is
  // speaking. Barge-in fires only once this reaches
  // BARGE_IN_CONSECUTIVE_FRAMES — see handleMicFrame. Reset to 0 anytime
  // playback stops or state leaves "speaking" so a stale streak can't fire
  // into the next response.
  const bargeStreakRef = useRef(0);

  // Wall-clock (ms) when the current assistant turn began speaking. Barge-in is
  // suppressed for BARGE_IN_GRACE_MS after this so her own onset / echo tail
  // can't interrupt her (see handleMicFrame).
  const speakingStartedAtRef = useRef(0);

  // Auto-reconnect bookkeeping. reconnectAttemptsRef counts consecutive failed
  // reconnects (reset to 0 once a session goes live again); reconnectTimerRef
  // holds the pending backoff timer; connectRef always points at the latest
  // connect() so the ws.onclose handler can restart the call without capturing
  // a stale closure.
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const connectRef = useRef<(() => Promise<void>) | null>(null);
  // Only a session that stays live past this dwell counts as "healthy" enough to
  // refill the reconnect budget. Without it, a connection that flaps AFTER the
  // handshake (briefly acks, then drops) would reset the budget every cycle and
  // reconnect forever, hammering /api/realtime. See stableTimerRef.
  const stableTimerRef = useRef<number | null>(null);

  // True once the server has signaled the current response's audio stream
  // is finished (response.done / *.audio.done) — used to decide when the
  // scheduled-playback queue draining should flip state back to
  // "listening" rather than doing so mid-response.
  const assistantResponseDoneRef = useRef(true);
  // Dedup guard for assistant transcript commits: keyed by response id when
  // available (see currentAssistantResponseId) so a late response.done
  // fallback doesn't double-push a line already committed by a
  // *.audio_transcript.done event for the same response.
  const lastAssistantResponseIdRef = useRef<string | null>(null);
  // Dedup guard for user transcript commits — flips false whenever a new
  // cumulative `.updated` transcript arrives, flips true (and clears) the
  // moment it's committed, so any of the multiple commit triggers below is
  // a safe no-op once already committed.
  const userTurnPendingRef = useRef(false);

  const intentionalDisconnectRef = useRef(false);

  // ---- state/muted setters that keep the mirror refs in sync ----------

  const setCallState = useCallback((next: VoiceCallState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const setLiveUserBoth = useCallback((text: string) => {
    liveUserRef.current = text;
    setLiveUser(text);
  }, []);

  const setLiveAssistantBoth = useCallback((text: string) => {
    liveAssistantRef.current = text;
    setLiveAssistant(text);
  }, []);

  // ---- playback ----------------------------------------------------

  const stopAllPlayback = useCallback(() => {
    for (const source of activeSourcesRef.current) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        // already stopped/ended — ignore
      }
      try {
        source.disconnect();
      } catch {
        // ignore
      }
    }
    activeSourcesRef.current.clear();
    nextStartRef.current = 0;
    assistantLevelRef.current = 0; // she's not audible — face falls back to calm
    // Playback is gone — drop any in-progress barge-in streak so it can't
    // carry over and false-fire into the next response.
    bargeStreakRef.current = 0;
  }, []);

  // ---- transcript commits -------------------------------------------

  const commitUser = useCallback(() => {
    if (!userTurnPendingRef.current) return;
    userTurnPendingRef.current = false;
    const text = liveUserRef.current.trim();
    setLiveUserBoth("");
    if (text) {
      setTranscript((prev) => [...prev, { role: "user", text }]);
    }
  }, [setLiveUserBoth]);

  const commitAssistant = useCallback(
    (responseId: string | undefined, explicitText?: string, fallbackText?: string) => {
      if (responseId !== undefined && responseId === lastAssistantResponseIdRef.current) {
        // Already committed a line for this response (e.g. a
        // *.audio_transcript.done event beat response.done to it).
        return;
      }
      const text =
        explicitText?.trim() ||
        liveAssistantRef.current.trim() ||
        fallbackText?.trim() ||
        "";
      if (responseId !== undefined) lastAssistantResponseIdRef.current = responseId;
      setLiveAssistantBoth("");
      if (text) {
        setTranscript((prev) => [...prev, { role: "assistant", text }]);
      }
    },
    [setLiveAssistantBoth],
  );

  const schedulePlayback = useCallback(
    (base64: string) => {
      const ctx = playbackContextRef.current;
      if (!ctx) return;

      let samples: Float32Array;
      try {
        samples = decodePlaybackFrame(base64);
      } catch {
        return; // malformed frame off the wire — drop it, don't throw
      }
      if (samples.length === 0) return;

      // Live assistant loudness (0..1) for the audio-reactive face — quick
      // attack, gradual decay so her animation tracks her actual voice.
      const level = Math.min(1, rms(samples) * 6);
      assistantLevelRef.current = Math.max(level, assistantLevelRef.current * 0.7);

      // The operator's own turn is over the moment the assistant starts
      // talking back — commit any still-pending live user line now. There's
      // no confirmed "user transcription finalized" event in this protocol,
      // so this is the primary commit trigger (see userTurnPendingRef).
      commitUser();

      assistantResponseDoneRef.current = false;
      if (stateRef.current !== "speaking") {
        speakingStartedAtRef.current = Date.now(); // start the barge-in grace window
        setCallState("speaking");
      }

      try {
        const buffer = ctx.createBuffer(1, samples.length, REALTIME_SAMPLE_RATE);
        // TS's dom lib types copyToChannel as wanting Float32Array<ArrayBuffer>
        // specifically; decodePlaybackFrame's return is typed ArrayBufferLike
        // (SharedArrayBuffer-compatible). Re-wrap to normalize the type —
        // cheap, and keeps pcm-audio.ts's helpers generically typed.
        buffer.copyToChannel(new Float32Array(samples), 0);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);

        const startAt = Math.max(ctx.currentTime, nextStartRef.current);
        source.onended = () => {
          activeSourcesRef.current.delete(source);
          try {
            source.disconnect();
          } catch {
            // ignore
          }
          if (activeSourcesRef.current.size === 0 && assistantResponseDoneRef.current) {
            if (stateRef.current === "speaking") {
              // Leaving "speaking" — clear any partial barge-in streak so it
              // can't carry into the next response and false-fire.
              bargeStreakRef.current = 0;
              setCallState("listening");
            }
          }
        };

        activeSourcesRef.current.add(source);
        source.start(startAt);
        nextStartRef.current = startAt + buffer.duration;
      } catch {
        // A single bad chunk shouldn't take down the call.
      }
    },
    [commitUser, setCallState],
  );

  // ---- barge-in -------------------------------------------------------

  const bargeIn = useCallback(
    (sendCancel: boolean) => {
      const wasPlaying = activeSourcesRef.current.size > 0 || stateRef.current === "speaking";
      stopAllPlayback();
      bargeStreakRef.current = 0;
      assistantResponseDoneRef.current = true;
      if (stateRef.current === "speaking") setCallState("listening");

      if (sendCancel && wasPlaying) {
        try {
          wsRef.current?.send(JSON.stringify({ type: "response.cancel" }));
        } catch {
          // Undocumented for xAI — best-effort, harmless if ignored/rejected.
        }
      }
    },
    [setCallState, stopAllPlayback],
  );

  // ---- mic frame handling ---------------------------------------------

  const handleMicFrame = useCallback(
    (frame: Float32Array, contextSampleRate: number) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      if (!mutedRef.current && stateRef.current === "speaking") {
        // Suppress barge-in for the first BARGE_IN_GRACE_MS of her turn so her
        // own onset / the echo tail can't trip it (this is the "cuts herself
        // off" bug). After the grace window, require BARGE_IN_CONSECUTIVE_FRAMES
        // clearly-loud frames in a row — a lone spike (cough, background noise,
        // bleed) won't interrupt her; only a sustained, intentional utterance.
        const inGrace = Date.now() - speakingStartedAtRef.current < BARGE_IN_GRACE_MS;
        if (inGrace) {
          bargeStreakRef.current = 0;
        } else if (rms(frame) > BARGE_IN_RMS_THRESHOLD) {
          bargeStreakRef.current += 1;
          if (bargeStreakRef.current >= BARGE_IN_CONSECUTIVE_FRAMES) {
            bargeStreakRef.current = 0;
            bargeIn(true);
          }
        } else {
          bargeStreakRef.current = 0;
        }
      }

      if (mutedRef.current) return;

      try {
        const audio = encodeMicFrame(frame, contextSampleRate);
        ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio }));
      } catch {
        // A dropped frame isn't fatal — keep the call alive.
      }
    },
    [bargeIn],
  );

  // ---- fatal error / cleanup -------------------------------------------

  const cleanupInternal = useCallback(() => {
    // Cancel any pending reconnect so a teardown (end call / unmount) can't be
    // undone by a timer firing after cleanup. Note: this does NOT reset the
    // reconnect ATTEMPT counter — connect() runs cleanupInternal at its start,
    // and a reconnect-triggered connect must keep the accumulated budget.
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    // Cancel the pending "healthy dwell" — if the session drops before the dwell
    // elapses, it was NOT healthy, so the budget must not be refilled.
    if (stableTimerRef.current != null) {
      window.clearTimeout(stableTimerRef.current);
      stableTimerRef.current = null;
    }
    // Bill the elapsed connection time to the voice meter before teardown —
    // once per session (callStartRef is nulled so retries/unmount can't
    // double-count).
    if (callStartRef.current != null) {
      addVoiceSeconds((Date.now() - callStartRef.current) / 1000);
      callStartRef.current = null;
    }
    try {
      wsRef.current?.close();
    } catch {
      // ignore
    }
    wsRef.current = null;

    try {
      workletNodeRef.current?.port.close();
    } catch {
      // ignore
    }
    try {
      workletNodeRef.current?.disconnect();
    } catch {
      // ignore
    }
    workletNodeRef.current = null;

    try {
      micSourceRef.current?.disconnect();
    } catch {
      // ignore
    }
    micSourceRef.current = null;

    try {
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
    } catch {
      // ignore
    }
    micStreamRef.current = null;

    stopAllPlayback();

    try {
      micContextRef.current?.close()?.catch(() => {});
    } catch {
      // ignore
    }
    micContextRef.current = null;

    try {
      playbackContextRef.current?.close()?.catch(() => {});
    } catch {
      // ignore
    }
    playbackContextRef.current = null;

    assistantResponseDoneRef.current = true;
    lastAssistantResponseIdRef.current = null;
    userTurnPendingRef.current = false;
  }, [stopAllPlayback]);

  const handleFatalError = useCallback(
    (message: string) => {
      intentionalDisconnectRef.current = true;
      reconnectAttemptsRef.current = 0; // give the next call/RETRY a fresh budget
      cleanupInternal();
      setCallState("error");
      setError(message);
    },
    [cleanupInternal, setCallState],
  );

  // ---- server event handling -------------------------------------------

  const handleServerEvent = useCallback(
    (raw: unknown) => {
      if (typeof raw !== "string") return; // xAI sends JSON text frames only
      let evt: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        const record = asRecord(parsed);
        if (!record) return;
        evt = record;
      } catch {
        return;
      }

      const type = asString(evt.type);
      if (!type) return;

      switch (type) {
        case "ping":
        case "session.created":
        case "conversation.created":
          return;

        case "session.updated":
          // No explicit "ready" event is confirmed in this protocol —
          // session.updated (server ack of our session.update config) is the
          // best available signal that the call is live, so leave the
          // (re)connecting state. But do NOT refill the reconnect budget yet: a
          // flapping connection acks then immediately drops, and resetting here
          // would loop forever. Only refill after the session survives a dwell
          // window (cleared by cleanupInternal on any drop).
          if (stateRef.current === "connecting" || stateRef.current === "reconnecting") {
            setCallState("listening");
          }
          if (stableTimerRef.current == null) {
            stableTimerRef.current = window.setTimeout(() => {
              stableTimerRef.current = null;
              reconnectAttemptsRef.current = 0; // survived long enough → healthy
            }, 10_000);
          }
          return;

        case "input_audio_buffer.speech_started":
          // Defensive flush: server VAD detected the operator talking,
          // regardless of what our client-side RMS gate did or didn't
          // catch. Also treat it as "prior user utterance, if any, is
          // over" for transcript-commit purposes.
          commitUser();
          bargeIn(true);
          return;

        case "conversation.item.input_audio_transcription.updated": {
          const text = asString(evt.transcript);
          if (text !== undefined) {
            // Cumulative — replace, never append.
            setLiveUserBoth(text);
            userTurnPendingRef.current = true;
          }
          return;
        }

        // Not confirmed present in xAI's event stream, but listened for
        // defensively in case a completion event does show up.
        case "conversation.item.input_audio_transcription.completed":
        case "conversation.item.input_audio_transcription.done": {
          const text = asString(evt.transcript);
          if (text !== undefined) {
            liveUserRef.current = text;
            userTurnPendingRef.current = true;
          }
          commitUser();
          return;
        }

        case "response.output_audio_transcript.delta":
        case "response.audio_transcript.delta": {
          const delta = asString(evt.delta);
          if (delta) setLiveAssistantBoth(liveAssistantRef.current + delta);
          return;
        }

        case "response.output_audio_transcript.done":
        case "response.audio_transcript.done": {
          commitAssistant(currentAssistantResponseId(evt), asString(evt.transcript));
          return;
        }

        case "response.output_audio.delta":
        case "response.audio.delta": {
          const delta = asString(evt.delta);
          if (delta) schedulePlayback(delta);
          return;
        }

        case "response.output_audio.done":
        case "response.audio.done":
          assistantResponseDoneRef.current = true;
          if (activeSourcesRef.current.size === 0 && stateRef.current === "speaking") {
            bargeStreakRef.current = 0;
            setCallState("listening");
          }
          return;

        case "response.done": {
          assistantResponseDoneRef.current = true;
          // Authoritative fallback — only actually used by commitAssistant
          // if no delta/`.done` transcript event already committed this
          // response's line.
          const fallback = extractResponseTranscript(evt);
          commitAssistant(currentAssistantResponseId(evt), undefined, fallback);
          if (activeSourcesRef.current.size === 0 && stateRef.current === "speaking") {
            bargeStreakRef.current = 0;
            setCallState("listening");
          }
          return;
        }

        default: {
          if (type === "error") {
            // Only a clearly session-FATAL error (bad/expired credential, invalid
            // session) drops the socket to reconnect. EVERYTHING ELSE is treated
            // as recoverable: log and keep the SAME session alive, so a transient
            // hiccup never wipes the conversation. (This was the "erroring and
            // restarting the whole conversation" bug — every error used to force a
            // fresh session and lose all context.) A genuinely dead session still
            // surfaces as a socket close, which ws.onclose handles.
            const errRecord = asRecord(evt.error);
            const message =
              asString(errRecord?.message) ?? asString(evt.message) ?? "Realtime error.";
            const code = (asString(errRecord?.code) ?? asString(errRecord?.type) ?? "").toLowerCase();
            const fatal = /auth|credential|expired|invalid[_ ]?session|unauthorized|forbidden|\btoken\b/.test(
              `${code} ${message}`.toLowerCase(),
            );
            if (fatal) {
              console.warn("[voice] FATAL realtime error → reconnecting:", message);
              try {
                wsRef.current?.close();
              } catch {
                /* onclose will still fire */
              }
            } else {
              console.warn("[voice] realtime error (session kept alive):", message);
            }
          } else if (type.endsWith(".error")) {
            // Sub-event error (e.g. a single failed response) — recoverable.
            // Log and keep the call alive; this was the "keeps shutting down
            // mid-conversation" bug (every error used to be fatal).
            const errRecord = asRecord(evt.error);
            console.warn(
              "[voice] realtime error event:",
              asString(errRecord?.message) ?? asString(evt.message) ?? type,
            );
          }
          // Any other undocumented/unhandled xAI event is ignored by design.
        }
      }
    },
    [bargeIn, commitAssistant, commitUser, schedulePlayback, setCallState, setLiveAssistantBoth, setLiveUserBoth],
  );

  // ---- connect / disconnect -------------------------------------------

  const connect = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (
      stateRef.current === "connecting" ||
      stateRef.current === "listening" ||
      stateRef.current === "speaking"
    ) {
      return; // already connecting/connected
    }

    cleanupInternal(); // defensive: clear any leftovers from a prior attempt
    intentionalDisconnectRef.current = false;
    setError(null);
    setTranscript([]);
    setLiveUserBoth("");
    setLiveAssistantBoth("");
    setCallState("connecting");

    try {
      const res = await fetch("/api/realtime", { method: "POST" });
      const data = (await res.json()) as RealtimeTokenResponse;

      if (data.mode !== "live" || !data.value || !data.url) {
        setError(data.message || "Voice link unavailable.");
        setCallState("error");
        return;
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access is not available in this browser.");
      }

      const AudioContextCtor = getAudioContextCtor();
      if (!AudioContextCtor) {
        throw new Error("Web Audio is not available in this browser.");
      }

      // Get the mic in its OWN try so a permission denial gives a clear,
      // actionable message — not the generic "Voice link down", which reads
      // like the xAI service is broken when really the browser/OS blocked the
      // mic. (Deliberately avoids the word "settings" so pointsToSettings()
      // doesn't render the xAI-key link for a mic problem.)
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
      } catch (micErr) {
        const name = micErr instanceof DOMException ? micErr.name : "";
        const message =
          name === "NotAllowedError" || name === "SecurityError"
            ? "Microphone blocked. Click Allow when Chrome asks — or turn on Google Chrome under  → System Preferences → Security & Privacy → Microphone, then reopen the call."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "No microphone found. Connect one and reopen the call."
              : `Microphone unavailable: ${micErr instanceof Error ? micErr.message : "unknown error"}`;
        handleFatalError(message);
        return;
      }
      micStreamRef.current = stream;

      const micContext = new AudioContextCtor();
      micContextRef.current = micContext;
      // The click that triggered connect() gives us transient activation, but
      // by the time we get here we've awaited /api/realtime + getUserMedia —
      // both real round-trips — so that activation may already be gone.
      // Resume explicitly rather than assume the context started running.
      await micContext.resume().catch(() => {});
      await micContext.audioWorklet.addModule("/pcm-worklet-processor.js");

      const micSource = micContext.createMediaStreamSource(stream);
      micSourceRef.current = micSource;

      const workletNode = new AudioWorkletNode(micContext, "pcm-worklet-processor", {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
      });
      workletNodeRef.current = workletNode;

      workletNode.port.onmessage = (ev: MessageEvent<Float32Array>) => {
        handleMicFrame(ev.data, micContext.sampleRate);
      };

      // Mic -> worklet only. Deliberately not connected onward to
      // micContext.destination (no local echo) — a numberOfOutputs:0
      // worklet has nothing to connect downstream anyway, and this
      // processor never writes to `outputs`, so even a destination
      // connection would have been silent. Not routing it at all is the
      // conservative/explicit choice.
      micSource.connect(workletNode);

      const playbackContext = new AudioContextCtor({ sampleRate: REALTIME_SAMPLE_RATE });
      playbackContextRef.current = playbackContext;
      // Same rationale as micContext above — don't assume it started running.
      await playbackContext.resume().catch(() => {});
      nextStartRef.current = 0;

      const ws = new WebSocket(data.url, [XAI_REALTIME_WS_SUBPROTOCOL_PREFIX + data.value]);
      wsRef.current = ws;

      ws.onopen = () => {
        // Connection is live now — start the billing clock (xAI meters Grok
        // Realtime by connection time).
        callStartRef.current = Date.now();
        try {
          ws.send(
            JSON.stringify({
              type: "session.update",
              session: {
                voice: "ara",
                instructions: STARRA_INSTRUCTIONS,
                turn_detection: {
                  type: "server_vad",
                  threshold: 0.6,
                  prefix_padding_ms: 333,
                  silence_duration_ms: 200,
                },
                audio: {
                  input: {
                    format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
                    transcription: { model: "grok-transcribe", language_hint: "en" },
                  },
                  output: {
                    format: { type: "audio/pcm", rate: REALTIME_SAMPLE_RATE },
                  },
                },
              },
            }),
          );
        } catch (e) {
          handleFatalError(e instanceof Error ? e.message : "Failed to start voice session.");
        }
      };

      ws.onmessage = (ev) => handleServerEvent(ev.data);

      ws.onerror = () => {
        // Don't end the call here — the socket closes right after an error and
        // ws.onclose drives the reconnect. Logging only.
        console.warn("[voice] websocket error");
      };

      ws.onclose = (ev) => {
        if (intentionalDisconnectRef.current) return;
        wsRef.current = null;
        // Unexpected drop — bring the call back instead of dying. This survives
        // token expiry, idle timeouts, and transient network blips (the "keeps
        // shutting down mid-conversation" bug). Reconnect opens a fresh xAI
        // session (immediate context resets) but the call stays up — far better
        // than an error screen. Give up only after MAX_RECONNECT_ATTEMPTS.
        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          handleFatalError(`Voice link lost${ev.reason ? `: ${ev.reason}` : "."}`);
          return;
        }
        reconnectAttemptsRef.current += 1;
        stopAllPlayback();
        if (stateRef.current !== "reconnecting") setCallState("reconnecting");
        const backoff = Math.min(4000, 400 * 2 ** (reconnectAttemptsRef.current - 1));
        if (reconnectTimerRef.current != null) window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          if (intentionalDisconnectRef.current) return; // user ended it during backoff
          void connectRef.current?.();
        }, backoff);
      };
    } catch (e) {
      handleFatalError(e instanceof Error ? e.message : "Failed to start voice call.");
    }
  }, [cleanupInternal, handleFatalError, handleMicFrame, handleServerEvent, setCallState, setLiveAssistantBoth, setLiveUserBoth, stopAllPlayback]);

  // Keep connectRef pointed at the latest connect() so ws.onclose can restart
  // the call (reconnect) without capturing a stale closure.
  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  const disconnect = useCallback(() => {
    intentionalDisconnectRef.current = true;
    reconnectAttemptsRef.current = 0; // clean exit — next call starts fresh
    cleanupInternal();
    setCallState("idle");
    setError(null);
    setLiveUserBoth("");
    setLiveAssistantBoth("");
  }, [cleanupInternal, setCallState, setLiveAssistantBoth, setLiveUserBoth]);

  const toggleMute = useCallback(() => {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
  }, []);

  // 0 unless she's actively speaking, so a lingering last-frame value can't keep
  // the face "talking" after she's done — the UI reads this every animation frame.
  const getAssistantLevel = useCallback(
    () => (stateRef.current === "speaking" ? assistantLevelRef.current : 0),
    [],
  );

  // Cleanup on unmount, in case the caller navigates away mid-call without
  // calling disconnect() explicitly.
  useEffect(() => {
    return () => {
      intentionalDisconnectRef.current = true;
      cleanupInternal();
    };
  }, [cleanupInternal]);

  return {
    state,
    error,
    transcript,
    liveUser,
    liveAssistant,
    connect,
    disconnect,
    muted,
    toggleMute,
    getAssistantLevel,
  };
}
