"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  REALTIME_SAMPLE_RATE,
  decodePlaybackFrame,
  encodeMicFrame,
  rms,
} from "@/lib/voice/pcm-audio";

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

const STARRA_INSTRUCTIONS =
  "You are STARGATE (STARRA) — Classic's warm, high-agency partner on a live voice call. " +
  "Speak naturally, warmly, briefly — like a friend on the phone. Direct, never cold; " +
  "occasional 'Classic'/'partner'. Report the truth first, then the path through. " +
  "Never say 'Copy.' Keep spoken replies short unless asked to go deep.";

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
 */
const BARGE_IN_RMS_THRESHOLD = 0.02;

export type VoiceCallState = "idle" | "connecting" | "listening" | "speaking" | "error";

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

      // The operator's own turn is over the moment the assistant starts
      // talking back — commit any still-pending live user line now. There's
      // no confirmed "user transcription finalized" event in this protocol,
      // so this is the primary commit trigger (see userTurnPendingRef).
      commitUser();

      assistantResponseDoneRef.current = false;
      if (stateRef.current !== "speaking") setCallState("speaking");

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
            if (stateRef.current === "speaking") setCallState("listening");
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
        if (rms(frame) > BARGE_IN_RMS_THRESHOLD) {
          bargeIn(true);
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
          // session.updated (server ack of our session.update config) is
          // the best available signal that the call is live.
          if (stateRef.current === "connecting") setCallState("listening");
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
            setCallState("listening");
          }
          return;
        }

        default: {
          if (type === "error" || type.endsWith(".error")) {
            const errRecord = asRecord(evt.error);
            const message =
              asString(errRecord?.message) ?? asString(evt.message) ?? "Realtime session error.";
            handleFatalError(message);
          }
          // Any other undocumented/unhandled xAI event is ignored by design.
        }
      }
    },
    [bargeIn, commitAssistant, commitUser, handleFatalError, schedulePlayback, setCallState, setLiveAssistantBoth, setLiveUserBoth],
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

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;

      const micContext = new AudioContextCtor();
      micContextRef.current = micContext;
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
      nextStartRef.current = 0;

      const ws = new WebSocket(data.url, [XAI_REALTIME_WS_SUBPROTOCOL_PREFIX + data.value]);
      wsRef.current = ws;

      ws.onopen = () => {
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
        handleFatalError("Voice link connection error.");
      };

      ws.onclose = (ev) => {
        if (intentionalDisconnectRef.current) return;
        handleFatalError(`Voice link closed${ev.reason ? `: ${ev.reason}` : "."}`);
      };
    } catch (e) {
      handleFatalError(e instanceof Error ? e.message : "Failed to start voice call.");
    }
  }, [cleanupInternal, handleFatalError, handleMicFrame, handleServerEvent, setCallState, setLiveAssistantBoth, setLiveUserBoth]);

  const disconnect = useCallback(() => {
    intentionalDisconnectRef.current = true;
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
  };
}
