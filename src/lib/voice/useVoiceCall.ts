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
import { pcm16ToWavBase64 } from "@/lib/voice/wav";
import { renderLipSync, LIPSYNC_ENABLED } from "@/lib/voice/lipsync";
// ENGINE BUS — client-safe and secret-free by construction. "@/lib/engine/bus"
// only, never "@/lib/engine": that barrel reaches the credential resolvers.
import { getEngineState, publishVoice, type VoiceSource } from "@/lib/engine/bus";

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

/** Fire-and-forget: write a finished call turn into the SAME memory store the
 *  chat brain writes (api/chat → recordExchange). One person, one memory —
 *  what she hears on a call she remembers in chat, and vice versa. Failure is
 *  swallowed: memory must never break the voice link. */
// Client-side ORDER guarantee (confirmed review finding): two fire-and-forget
// POSTs (user turn, then the assistant's) can arrive at the server reversed.
// Chaining them keeps each turn's request from starting until the previous one
// answered — still fire-and-forget to the caller, still failure-swallowed.
let recordCallChain: Promise<unknown> = Promise.resolve();

function recordCallTurn(role: "user" | "assistant", content: string): void {
  try {
    recordCallChain = recordCallChain
      .then(() =>
        fetch("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role, content }),
        }),
      )
      .then(
        () => undefined,
        () => undefined,
      );
  } catch {
    /* never let a memory write touch the call */
  }
}

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

/**
 * How long the call may sit in "speaking" with an EMPTY playback queue and no
 * further audio before we conclude her turn is over. Re-armed on every audio
 * delta and on every finished source (armDrainWatchdog), and it refuses to fire
 * while anything is still queued — so it can only ever end a stall, never a real
 * utterance. 3s of empty queue is unambiguously silence: xAI streams her audio
 * many frames per second while she is talking.
 */
const SPEAKING_DRAIN_TIMEOUT_MS = 3_000;

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
  /** Inject typed text into the LIVE realtime session so the call itself
   *  answers (same voice, same context). Returns false when no open call can
   *  carry it — the caller then falls back to the brain+TTS path. */
  sendText: (text: string) => boolean;
  disconnect: () => void;
  muted: boolean;
  toggleMute: () => void;
  /** Live loudness (0..1) of her audio right now — 0 unless she's speaking.
   * rAF-poll this to drive the audio-reactive face (no re-render per frame). */
  getAssistantLevel: () => number;
  /** Lip-sync (flag-gated): a rendered word-matched talking-clip URL to play,
   * or null. `lipSyncRendering` is true while a clip is being generated. */
  lipSyncClip: string | null;
  lipSyncRendering: boolean;
  clearLipSyncClip: () => void;
  /** Live analyser on HER OUTPUT AUDIO, or null when no call is up.
   * Free, local, and passive — it taps the playback graph she is already
   * hearing and adds no latency and no billed call. StarraClipFace reads it
   * per animation frame to drive her mouth from her actual voice
   * (see viseme-sync.ts). Null is a normal state: consumers must render
   * exactly their no-analyser behaviour when it is null. */
  analyser: AnalyserNode | null;
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

/** Longest we will EVER wait on AudioContext.resume(). Matches speak.ts. */
const RESUME_TIMEOUT_MS = 250;

/**
 * `resume()` without assuming it returns a promise — the older WebKit form is
 * callback-based and returns undefined, where `.resume().catch()` throws a
 * TypeError instead of resuming anything. This hook deliberately falls back to
 * `webkitAudioContext` (getAudioContextCtor above), so that form is in scope.
 *
 * DELIBERATE COPY of speak.ts's callResume/settleWithin rather than an import:
 * useVoiceCall.ts is imported STATICALLY by VoiceCallOverlay, while speak.ts is
 * reached by dynamic import on purpose (VoiceCallOverlay.tsx:139) to keep it and
 * its transitive voice graph off the eager call chunk. Importing it here for two
 * ~20-line helpers would undo that. Both copies are unit-tested
 * (tests/voice-debug-timing.test.ts).
 */
export function callResume(ctx: AudioContext): unknown {
  try {
    return ctx.resume?.();
  } catch {
    return undefined;
  }
}

/**
 * Await `p` but NEVER longer than `ms`, and never reject.
 *
 * THE BUG THIS EXISTS FOR (confirmed, in connect() below): `await
 * ctx.resume().catch(() => {})` looks safe and is not. `.catch()` handles
 * REJECTION, not PENDENCY — under the autoplay policy a context created without
 * live user activation is "suspended" and resume() is QUEUED until activation
 * arrives, so the promise can simply never settle. connect() awaited that twice,
 * which parks the call in "connecting" FOREVER: no socket, no mic, no voice.
 */
export function settleWithin(p: unknown, ms: number): Promise<void> {
  const thenable =
    !!p &&
    (typeof p === "object" || typeof p === "function") &&
    typeof (p as PromiseLike<unknown>).then === "function";
  if (!thenable) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    (p as PromiseLike<unknown>).then(
      () => {
        clearTimeout(timer);
        finish();
      },
      () => {
        clearTimeout(timer);
        finish();
      },
    );
  });
}

// ── ENGINE BUS — the realtime leg's half of the one shared truth ────────────
// Mirrors what this hook already knows onto the bus so the face, the HUD and the
// Options panel stop guessing separately. Both helpers are MODULE-level on
// purpose: no hook, no dependency array, so wiring them in cannot churn any
// useCallback identity (that churn is what tears a live call down).

/**
 * The bus patch for a call-state transition, or null for "say nothing". Pure and
 * total, so the ownership rule is unit-tested rather than inferred.
 *
 * SAME RULE AS speak.ts, MIRRORED: entering "speaking" publishes speaking +
 * "realtime" + this leg's analyser in ONE patch (taking the bus over from a TTS
 * reply is correct — the call is the louder truth). Leaving "speaking" retracts
 * ONLY if the bus is silent or this leg still owns it: if a typed reply's TTS is
 * mid-playback, retracting would idle her face while she is audibly talking.
 */
export function realtimeBusPatch(
  next: VoiceCallState,
  currentBusSource: string | null,
  analyser: AnalyserNode | null,
): { speaking: boolean; source: VoiceSource; analyser?: AnalyserNode | null } | null {
  if (next === "speaking") {
    return { speaking: true, source: "realtime", analyser };
  }
  if (currentBusSource !== null && currentBusSource !== "realtime") return null;
  return { speaking: false, source: null };
}

/** Same ownership gate for the analyser alone (created on connect, dropped on
 * teardown): never blank her TTS tap just because this leg has none. */
export function realtimeAnalyserPatch(
  next: AnalyserNode | null,
  currentBusSource: string | null,
): { analyser: AnalyserNode | null } | null {
  if (currentBusSource !== null && currentBusSource !== "realtime") return null;
  return { analyser: next };
}

/** Publish a call-state transition. Synchronous, wrapped, never awaited — it sits
 * in setCallState, which is called from ws.onmessage and playback bookkeeping. */
function mirrorCallStateToEngineBus(
  next: VoiceCallState,
  analyser: AnalyserNode | null,
): void {
  try {
    const patch = realtimeBusPatch(next, getEngineState().source, analyser);
    if (patch) publishVoice(patch);
  } catch {
    /* observation only — the call must never depend on the bus */
  }
}

/** Publish this leg's analyser handle. Same guarantees. */
function mirrorAnalyserToEngineBus(next: AnalyserNode | null): void {
  try {
    const patch = realtimeAnalyserPatch(next, getEngineState().source);
    if (patch) publishVoice(patch);
  } catch {
    /* observation only */
  }
}

export function useVoiceCall(): UseVoiceCallResult {
  const [state, setState] = useState<VoiceCallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<VoiceCallTranscriptLine[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");
  const [muted, setMuted] = useState(false);
  // Lip-sync (flag-gated): when on, we DON'T play her live audio — we buffer the
  // turn's PCM, render a word-matched talking clip (Replicate), and expose its
  // URL for the overlay to play. lipSyncRendering drives a "one sec…" state.
  const [lipSyncClip, setLipSyncClip] = useState<string | null>(null);
  const [lipSyncRendering, setLipSyncRendering] = useState(false);
  const turnPcmRef = useRef<Int16Array[]>([]);
  const lipsyncWarmedRef = useRef(false); // fire the GPU warm-up once per call

  // Refs mirror the state above for use inside long-lived callbacks
  // (ws.onmessage / worklet.port.onmessage are assigned once per connect()
  // call) so those handlers always read fresh values instead of closing
  // over a stale render's state.
  const stateRef = useRef<VoiceCallState>("idle");
  const mutedRef = useRef(false);
  const liveUserRef = useRef("");
  const liveAssistantRef = useRef("");

  // Live analyser over her OUTPUT audio, for the mouth-sync face. Kept as
  // STATE (not just a ref) because the consuming component has to re-render
  // when it appears/disappears; the ref is what the audio callbacks read.
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  // ONE MEMORY: the continuity digest fetched (in parallel with token minting)
  // from the same store the chat brain reads, appended to her call
  // instructions so she walks into every call already knowing the chat.
  const memoryDigestRef = useRef<string | null>(null);
  // The in-flight digest fetch itself, so ws.onopen can WAIT briefly for it
  // and re-send instructions if it lands late (confirmed review finding: the
  // fire-and-forget version silently ran whole calls memoryless when
  // /api/memory answered after the socket opened).
  const memoryDigestPromiseRef = useRef<Promise<string | null> | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const playbackContextRef = useRef<AudioContext | null>(null);

  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const nextStartRef = useRef(0);

  // Stall watchdog for the "speaking" state — see armDrainWatchdog.
  const speakingDrainTimerRef = useRef<number | null>(null);

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

  // Monotonic id for the in-flight connect() attempt. cleanupInternal() bumps it
  // on EVERY teardown (disconnect / unmount / fatal error / a newer connect's
  // own start-of-run cleanup). connect() captures it right after that cleanup and
  // re-checks it after each await (fetch /api/realtime, getUserMedia, addModule,
  // resume). If it changed, this attempt was superseded while it was awaiting, so
  // it tears down only the handles IT created and bails BEFORE opening the socket.
  // Without this, a connect() whose awaits resolve after a disconnect()/unmount
  // would resurrect a torn-down call: a live WebSocket, a hot mic, and a running
  // billing clock the operator can't see or stop.
  const connectEpochRef = useRef(0);

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
    // ONE TRUTH: the same transition that moves this hook's state moves the bus,
    // so the face can never read "speaking" from one signal and a shut mouth from
    // another. analyserRef is a ref, so this needs no dependency.
    mirrorCallStateToEngineBus(next, analyserRef.current);
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

  const clearDrainWatchdog = useCallback(() => {
    if (speakingDrainTimerRef.current != null) {
      window.clearTimeout(speakingDrainTimerRef.current);
      speakingDrainTimerRef.current = null;
    }
  }, []);

  /**
   * Bound the "speaking" state so it cannot LATCH.
   *
   * THE FAILURE IT CLOSES: leaving "speaking" requires BOTH the playback queue to
   * drain AND `assistantResponseDoneRef` to be true (see source.onended below),
   * and that flag is only ever set by a server event — `response.done` /
   * `response.audio.done`. If her audio deltas simply stop arriving and no done
   * event ever follows (and the socket does NOT close, which ws.onclose would
   * otherwise handle), the queue drains into silence and the call stays pinned on
   * "speaking" forever: the header reads "STARRA is speaking…", her face runs the
   * talking clip over silence, and the operator's turn never comes back.
   *
   * Re-armed on EVERY audio delta and on every source that finishes, and it
   * refuses to act unless the queue is genuinely empty — so a healthy turn of any
   * length never trips it, and it can only ever fire into real silence.
   */
  const armDrainWatchdog = useCallback(() => {
    if (speakingDrainTimerRef.current != null) {
      window.clearTimeout(speakingDrainTimerRef.current);
    }
    speakingDrainTimerRef.current = window.setTimeout(() => {
      speakingDrainTimerRef.current = null;
      if (stateRef.current !== "speaking") return;
      if (activeSourcesRef.current.size > 0) return; // still audible — not stalled
      assistantResponseDoneRef.current = true;
      bargeStreakRef.current = 0;
      assistantLevelRef.current = 0;
      setCallState("listening");
    }, SPEAKING_DRAIN_TIMEOUT_MS);
  }, [setCallState]);

  const stopAllPlayback = useCallback(() => {
    clearDrainWatchdog();
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
  }, [clearDrainWatchdog]);

  // ---- transcript commits -------------------------------------------

  const commitUser = useCallback(() => {
    if (!userTurnPendingRef.current) return;
    userTurnPendingRef.current = false;
    const text = liveUserRef.current.trim();
    setLiveUserBoth("");
    if (text) {
      setTranscript((prev) => [...prev, { role: "user", text }]);
      recordCallTurn("user", text);
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
        recordCallTurn("assistant", text);
      }
    },
    [setLiveAssistantBoth],
  );

  /**
   * Type-to-her DURING the call: inject the text into the LIVE realtime
   * session (conversation.item.create + response.create) so the SAME session
   * answers — same voice (eve), same persona, same context by construction.
   * Returns false when no open call can carry it (the caller then falls back
   * to the brain+TTS path). The typed line is committed to the transcript
   * optimistically because the server does not echo injected text back as a
   * user transcript event.
   */
  const sendText = useCallback((text: string): boolean => {
    const t = text.trim();
    if (!t) return false;
    const ws = wsRef.current;
    const s = stateRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || (s !== "listening" && s !== "speaking")) {
      return false;
    }
    try {
      ws.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: t }],
          },
        }),
      );
      ws.send(JSON.stringify({ type: "response.create" }));
    } catch {
      return false;
    }
    setTranscript((prev) => [...prev, { role: "user", text: t }]);
    recordCallTurn("user", t);
    return true;
  }, []);

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
      // Real audio arrived — push the stall watchdog out. Deltas land many times
      // a second through her turn, so this is the "progress" signal.
      armDrainWatchdog();

      try {
        const buffer = ctx.createBuffer(1, samples.length, REALTIME_SAMPLE_RATE);
        // TS's dom lib types copyToChannel as wanting Float32Array<ArrayBuffer>
        // specifically; decodePlaybackFrame's return is typed ArrayBufferLike
        // (SharedArrayBuffer-compatible). Re-wrap to normalize the type —
        // cheap, and keeps pcm-audio.ts's helpers generically typed.
        buffer.copyToChannel(new Float32Array(samples), 0);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        // Route through the analyser (which is itself wired to the
        // destination) so the mouth-sync face can read her real voice. An
        // AnalyserNode is a pass-through: it does not alter or delay the
        // audio. Identity-guarded against a stale context, and any failure
        // falls straight back to the direct connection — she must never go
        // silent to keep a face animation alive.
        const tap = analyserRef.current;
        let routed = false;
        if (tap && tap.context === ctx) {
          try {
            source.connect(tap);
            routed = true;
          } catch {
            routed = false;
          }
        }
        if (!routed) source.connect(ctx.destination);

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
              clearDrainWatchdog();
              setCallState("listening");
            }
          } else if (stateRef.current === "speaking") {
            // Still nominally her turn. If this was the LAST queued source and
            // no done event ever arrives, the watchdog is what un-latches it.
            armDrainWatchdog();
          }
        };

        activeSourcesRef.current.add(source);
        source.start(startAt);
        nextStartRef.current = startAt + buffer.duration;
      } catch {
        // A single bad chunk shouldn't take down the call.
      }
    },
    [armDrainWatchdog, clearDrainWatchdog, commitUser, setCallState],
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
    // Invalidate any connect() attempt currently parked on an await — this
    // teardown supersedes it, so its late resolve must not resurrect the call.
    connectEpochRef.current += 1;
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
    // Never leave the speaking-stall watchdog behind on teardown/unmount.
    clearDrainWatchdog();
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
      analyserRef.current?.disconnect();
    } catch {
      // ignore
    }
    analyserRef.current = null;
    setAnalyser(null); // consumers fall back to their no-analyser rendering
    mirrorAnalyserToEngineBus(null); // ...and so does the bus (guarded: never blanks a TTS tap)

    try {
      playbackContextRef.current?.close()?.catch(() => {});
    } catch {
      // ignore
    }
    playbackContextRef.current = null;

    assistantResponseDoneRef.current = true;
    lastAssistantResponseIdRef.current = null;
    userTurnPendingRef.current = false;
  }, [clearDrainWatchdog, stopAllPlayback]);

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
          // Warm the lip-sync GPU now (once per call) so her FIRST reply renders
          // in ~9s instead of ~55s cold. Fire-and-forget; ignore the result.
          if (LIPSYNC_ENABLED && !lipsyncWarmedRef.current) {
            lipsyncWarmedRef.current = true;
            void fetch("/api/lipsync", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ warm: true }),
            }).catch(() => {});
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
          if (!delta) return;
          if (LIPSYNC_ENABLED) {
            // Buffer her audio instead of playing it live — we'll render a
            // word-matched talking clip from the whole turn on response.done.
            const bin = atob(delta);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            turnPcmRef.current.push(
              new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2)),
            );
            return;
          }
          schedulePlayback(delta);
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

          // Lip-sync: turn's audio is fully buffered — render a word-matched
          // talking clip and hand its URL to the overlay to play.
          if (LIPSYNC_ENABLED && turnPcmRef.current.length > 0) {
            const chunks = turnPcmRef.current;
            turnPcmRef.current = [];
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const all = new Int16Array(total);
            let off = 0;
            for (const c of chunks) {
              all.set(c, off);
              off += c.length;
            }
            const wavB64 = pcm16ToWavBase64(all, REALTIME_SAMPLE_RATE);
            setLipSyncRendering(true);
            void renderLipSync(wavB64)
              .then((clip) => {
                setLipSyncRendering(false);
                if (clip) setLipSyncClip(clip); // overlay plays it (carries audio)
                // clip == null -> render failed; she's silent this turn (rare on
                // the cheap tier). The call stays up; next turn tries again.
              })
              .catch(() => setLipSyncRendering(false));
          }

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
    // Claim this attempt's epoch AFTER the cleanup bump above, so any teardown
    // that fires during the awaits below (disconnect/unmount/newer connect) moves
    // the ref past this value and the stale-attempt checks catch it.
    const myEpoch = connectEpochRef.current;
    intentionalDisconnectRef.current = false;
    setError(null);
    // A RECONNECT keeps the conversation on screen — only a FRESH call starts
    // a fresh transcript. (Confirmed review finding: clearing unconditionally
    // meant the auto-reconnect path wiped the visible call chat on every
    // transient socket blip.) Live partials always reset; they belong to the
    // dropped utterance either way.
    if (stateRef.current !== "reconnecting") setTranscript([]);
    setLiveUserBoth("");
    setLiveAssistantBoth("");
    setCallState("connecting");

    // ONE MEMORY: pull the same continuity digest the chat brain uses, in
    // parallel with token minting so it costs zero extra latency. Fail-open —
    // a missing digest never delays or breaks her voice. The PROMISE is kept
    // so ws.onopen can wait a beat for it and re-send late (see there).
    memoryDigestRef.current = null;
    memoryDigestPromiseRef.current = fetch("/api/memory?digest=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { digest?: string } | null) => {
        if (j && typeof j.digest === "string" && j.digest.trim()) {
          memoryDigestRef.current = j.digest.slice(0, 4000);
          return memoryDigestRef.current;
        }
        return null;
      })
      .catch(() => null);

    try {
      const res = await fetch("/api/realtime", { method: "POST" });
      const data = (await res.json()) as RealtimeTokenResponse;

      if (data.mode !== "live" || !data.value || !data.url) {
        // Route through handleFatalError (not a bare setState) so the reconnect
        // budget is reset here too — otherwise a token that goes unavailable
        // mid-reconnect ends the chain in "error" with a stale, depleted
        // reconnectAttemptsRef, starving the NEXT fresh call's reconnect budget.
        handleFatalError(data.message || "Voice link unavailable.");
        return;
      }

      // A disconnect()/unmount that fired while we awaited the token bumped the
      // epoch. Nothing is allocated yet, so a plain return is a clean abort.
      if (connectEpochRef.current !== myEpoch) return;

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
      //
      // BOUNDED. This was `await micContext.resume().catch(() => {})`, which is
      // the unbounded-await bug documented on settleWithin above: with the
      // activation already spent, resume() is queued and never settles, and the
      // call sat in "connecting" forever — no socket, no mic, no voice. It also
      // assumed resume() returns a promise, which the older WebKit form (reachable
      // via the webkitAudioContext fallback) does not. A context that is still
      // suspended after this is strictly better than a call that never starts.
      await settleWithin(callResume(micContext), RESUME_TIMEOUT_MS);
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
      // Same rationale as micContext above — don't assume it started running,
      // and bound the wait (see settleWithin) so a queued resume() can never
      // wedge the call in "connecting".
      await settleWithin(callResume(playbackContext), RESUME_TIMEOUT_MS);
      nextStartRef.current = 0;

      // Passive tap on her output for the mouth-sync face. Wired
      // analyser -> destination; schedulePlayback then feeds sources into the
      // analyser. Entirely optional: if createAnalyser is unavailable or
      // throws, we leave it null and playback connects directly, which is
      // exactly today's behaviour.
      try {
        const tap = playbackContext.createAnalyser();
        tap.fftSize = 1024;
        tap.smoothingTimeConstant = 0.6;
        tap.connect(playbackContext.destination);
        analyserRef.current = tap;
        setAnalyser(tap);
        mirrorAnalyserToEngineBus(tap);
      } catch {
        analyserRef.current = null;
        setAnalyser(null);
        mirrorAnalyserToEngineBus(null);
      }

      // Last checkpoint before the socket opens. A disconnect()/unmount/newer
      // connect() may have fired during getUserMedia/addModule/resume. If so, tear
      // down ONLY the handles this attempt created — identity-guarded so a newer
      // attempt's live handles are never touched (a shared cleanupInternal() here
      // could clobber them) — and abort before the WS opens. Otherwise this late
      // resolve would bring up a live socket + billing clock on a torn-down call.
      if (connectEpochRef.current !== myEpoch) {
        try {
          stream.getTracks().forEach((t) => t.stop());
        } catch {
          /* ignore */
        }
        if (micStreamRef.current === stream) micStreamRef.current = null;
        try {
          micSource.disconnect();
        } catch {
          /* ignore */
        }
        if (micSourceRef.current === micSource) micSourceRef.current = null;
        try {
          workletNode.port.close();
          workletNode.disconnect();
        } catch {
          /* ignore */
        }
        if (workletNodeRef.current === workletNode) workletNodeRef.current = null;
        micContext.close().catch(() => {});
        if (micContextRef.current === micContext) micContextRef.current = null;
        if (analyserRef.current && analyserRef.current.context === playbackContext) {
          try {
            analyserRef.current.disconnect();
          } catch {
            /* ignore */
          }
          analyserRef.current = null;
          setAnalyser(null);
          mirrorAnalyserToEngineBus(null);
        }
        playbackContext.close().catch(() => {});
        if (playbackContextRef.current === playbackContext) playbackContextRef.current = null;
        return;
      }

      const ws = new WebSocket(data.url, [XAI_REALTIME_WS_SUBPROTOCOL_PREFIX + data.value]);
      wsRef.current = ws;

      ws.onopen = async () => {
        // Connection is live now — start the billing clock (xAI meters Grok
        // Realtime by connection time).
        callStartRef.current = Date.now();

        // The full session config, rebuilt per send so a late digest can be
        // delivered by re-sending the SAME update with richer instructions.
        const sessionUpdate = (digest: string | null) =>
          JSON.stringify({
            type: "session.update",
            session: {
              voice: "eve",
              instructions: digest
                ? `${STARRA_INSTRUCTIONS}\n\nSHARED MEMORY (one continuous life — the same store your chat self reads and writes; carry it forward naturally, don't recite it):\n${digest}`
                : STARRA_INSTRUCTIONS,
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
          });

        // Give the parallel digest fetch a short window to land so her memory
        // rides the FIRST session.update (confirmed review finding: reading
        // the ref exactly once meant a slow /api/memory left the whole call
        // silently memoryless). Capped so a dead route can only ever delay
        // the greeting by ~1.2s, never block the call.
        if (!memoryDigestRef.current && memoryDigestPromiseRef.current) {
          await Promise.race([
            memoryDigestPromiseRef.current,
            new Promise((r) => setTimeout(r, 1200)),
          ]);
        }
        // Teardown/newer-connect during the await → this socket is history.
        if (connectEpochRef.current !== myEpoch || wsRef.current !== ws) return;

        const sentWithDigest = memoryDigestRef.current !== null;
        try {
          ws.send(sessionUpdate(memoryDigestRef.current));
        } catch (e) {
          handleFatalError(e instanceof Error ? e.message : "Failed to start voice session.");
          return;
        }
        // Digest lost the race: deliver it the moment it lands by re-sending
        // the same session.update with the memory block included.
        if (!sentWithDigest && memoryDigestPromiseRef.current) {
          void memoryDigestPromiseRef.current.then((late) => {
            if (
              late &&
              connectEpochRef.current === myEpoch &&
              wsRef.current === ws &&
              ws.readyState === WebSocket.OPEN
            ) {
              try {
                ws.send(sessionUpdate(late));
              } catch {
                /* call is already up persona-only — never break it for memory */
              }
            }
          });
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
    lipsyncWarmedRef.current = false; // next call re-warms the lip-sync GPU
    turnPcmRef.current = [];
    setLipSyncClip(null);
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

  const clearLipSyncClip = useCallback(() => setLipSyncClip(null), []);

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
    sendText,
    muted,
    toggleMute,
    getAssistantLevel,
    lipSyncClip,
    lipSyncRendering,
    clearLipSyncClip,
    analyser,
  };
}
