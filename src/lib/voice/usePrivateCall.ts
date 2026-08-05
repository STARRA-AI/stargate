"use client";

/**
 * PRIVATE CALL — the whole call, on this Mac.
 *
 * Speak to her and hear her answer with NOTHING leaving the machine. Three legs,
 * three local services, one loopback each:
 *
 *   EARS   the mic, endpointed in this tab, cut into a 16 kHz mono WAV and
 *          POSTed to /api/private-call/transcribe — the deck's own door to
 *          whisper.cpp on 127.0.0.1:8178 (that route's header states why the
 *          hop is server-side and not straight out of the tab).
 *   BRAIN  the transcript goes to POST /api/chat prefixed `private `, which is
 *          the EXISTING private lane: it returns above every outbound call in
 *          that route by construction (src/app/api/chat/route.ts:749-758), it
 *          answers on local Ollama through private-gpt, it writes nothing to
 *          the shared store, and it sends `data: {"private":true}` before the
 *          first character of text. Not one line of that had to be rebuilt.
 *   MOUTH  speakLocalStream (src/lib/voice/local-voice.ts) synthesises Piper in
 *          this tab from model files the deck serves itself. Its header states
 *          the four defences that keep it off the CDNs, and it publishes her
 *          voice on the engine bus so her face reads the real audio.
 *
 * WHAT THIS FILE IS NOT. It is not a fork of useVoiceCall. It imports that
 * module for exactly one thing — the pure, tested endpointer (kimiEndpointStep
 * and its thresholds) — and reimplements nothing else of it. There is no
 * socket here, no token mint, no hosted transcription, no hosted synthesis, and
 * no browser speech API. tests/private-call.test.ts pins that as a property of
 * this file's source, not as a promise in this comment.
 *
 * ONE VOICE. connect() raises the bus's callLive claim, exactly as the overlay
 * does for the normal engine, so the deck's chat TTS is structurally unable to
 * speak over the call (speak.ts:803-825). Her OWN replies pass that gate with
 * `allowDuringCall` — the option local-voice.ts:872-880 exists for.
 *
 * No regex lookbehind anywhere — macOS 12 WebKit.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  KIMI_ENDPOINTER_IDLE,
  kimiEndpointStep,
  type KimiEndpointerState,
  type VoiceCallState,
  type VoiceCallTranscriptLine,
} from "@/lib/voice/useVoiceCall";
import { rms, resampleFloat32, float32ToPCM16 } from "@/lib/voice/pcm-audio";
import { pcm16ToWavBase64 } from "@/lib/voice/wav";
import {
  localAssetsAvailable,
  speakLocalStream,
  stopLocalStream,
} from "@/lib/voice/local-voice";
import { classifyChatFrame } from "@/lib/stargate-context";
import { parsePrivateCommand } from "@/lib/private/commands";
import { publishCallLive, subscribeEngine } from "@/lib/engine/bus";

// ── CONSTANTS (all exported so the tests pin the real values) ───────────────

/** whisper.cpp's reader is fixed at 16 kHz mono 16-bit
 * (vendor/whisper.cpp/examples/common-whisper.cpp:96,167 — WHISPER_SAMPLE_RATE;
 * README.md:98 states 16-bit WAV only). The mic context runs at whatever the OS
 * hands us, so every frame is resampled to this before it is buffered. */
export const WHISPER_SAMPLE_RATE = 16_000;

/** The deck's own loopback door to the ears. Same-origin on purpose. */
export const PRIVATE_TRANSCRIBE_PATH = "/api/private-call/transcribe";

/** The brain. The SAME endpoint the typed deck uses — the prefix is what routes
 * the turn locally, not a different URL. */
export const PRIVATE_CHAT_PATH = "/api/chat";

/** The prefix that makes /api/chat take the private branch. Matches
 * parsePrivateCommand's whitespace form (src/lib/private/commands.ts, pinned by
 * tests/private-lane.test.ts). */
export const PRIVATE_TURN_PREFIX = "private ";

/**
 * BARGE-IN, tuned exactly like the normal call's gate and for the same reasons
 * (useVoiceCall.ts:149-151): a clearly-louder, sustained utterance interrupts
 * her; a lone spike does not; and nothing at all can interrupt during the grace
 * window after she starts, so her own onset and the echo tail cannot cut her
 * off. Restated here rather than imported because the normal call's constants
 * are module-private and because this lane may need to diverge — Piper's output
 * comes out of a plain audio element, not the hosted playback graph.
 */
export const PRIVATE_BARGE_RMS = 0.05;
export const PRIVATE_BARGE_FRAMES = 7;
export const PRIVATE_BARGE_GRACE_MS = 450;

/** Frames carried into a turn from BEFORE the endpointer called it speech, so
 * the first consonant is not clipped. ~43 ms each, so this is ~215 ms of lead. */
export const PRIVATE_PREROLL_FRAMES = 5;

/** Hard ceiling on one utterance. At 16 kHz mono that is 30 s — the same cap the
 * transcribe route enforces on its side, so a runaway buffer is refused here
 * before it is refused there. */
export const PRIVATE_MAX_UTTERANCE_SAMPLES = 30 * WHISPER_SAMPLE_RATE;

/** Shorter than this and it was a cough, not a turn. */
export const PRIVATE_MIN_UTTERANCE_SAMPLES = Math.round(0.3 * WHISPER_SAMPLE_RATE);

/**
 * The honesty threshold for the status line. Measured on this machine the
 * private turn does not fit inside it — whisper ~0.6-1.2 s + a warm local brain
 * ~4.5 s + Piper's first sentence — so the slower-lane notice is the DEFAULT and
 * only goes away if a real measured turn comes in under it. Saying "instant" and
 * then taking six seconds is the status line lying, which is the one thing a
 * status line must never do.
 */
export const PRIVATE_SLOW_BUDGET_MS = 5_000;

export const PRIVATE_SLOW_NOTICE = "PRIVATE — local brain, slower";

// ── PURE HELPERS (exported: these are the unit tests, not source patterns) ──

export type PrivateCallState =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

/**
 * The private engine's state, reduced to the union the shared face selector
 * understands (selectFaceMode takes `callState: string` and only reacts to
 * "speaking" and "listening" — StarraClipFace.tsx:63-73). The three states this
 * engine adds are all "she has the turn but is not making sound yet", which
 * reads as listening on her face: attentive, not talking over silence.
 */
export function toCallFaceState(s: PrivateCallState): VoiceCallState {
  if (s === "speaking") return "speaking";
  if (s === "listening" || s === "transcribing" || s === "thinking") {
    return "listening";
  }
  if (s === "error") return "error";
  if (s === "connecting") return "connecting";
  return "idle";
}

/** Operator copy for the private engine's status line. No emojis, no exclamation. */
export function privateStatusCopy(s: PrivateCallState): string {
  switch (s) {
    case "listening":
      return "Listening — local.";
    case "transcribing":
      return "Transcribing on this Mac…";
    case "thinking":
      return "Local brain thinking…";
    case "speaking":
      return "STARRA is speaking — local voice.";
    case "error":
      return "Private lane down.";
    case "connecting":
      return "Opening the private line…";
    case "idle":
    default:
      return "Idle.";
  }
}

/**
 * Does the toggle owe him the slower-lane warning? `null` (nothing measured
 * yet) counts as YES — see PRIVATE_SLOW_BUDGET_MS. Pure so the honesty rule is
 * a test and not an eyeball.
 */
export function privateSlowNotice(lastTurnMs: number | null): string | null {
  if (lastTurnMs === null) return PRIVATE_SLOW_NOTICE;
  return lastTurnMs > PRIVATE_SLOW_BUDGET_MS ? PRIVATE_SLOW_NOTICE : null;
}

/**
 * The one line under the engine selector. Three things it has to get right, in
 * this order of importance:
 *   1. A choice that is NOT the engine the live call is on says so, plainly —
 *      the alternative is a toggle that looks like it did something it did not.
 *   2. On the private lane, tell him it is slower BEFORE he wonders why (see
 *      privateSlowNotice — unmeasured counts as slow).
 *   3. Otherwise, say what private buys, in one clause.
 * Normal returns "" so the hosted call's surface is visually unchanged.
 */
export function callEngineNote(opts: {
  chosen: "normal" | "private";
  active: "normal" | "private";
  callLive: boolean;
  lastTurnMs: number | null;
}): string {
  if (opts.callLive && opts.chosen !== opts.active) return "Applies to the next call.";
  if (opts.chosen !== "private") return "";
  return privateSlowNotice(opts.lastTurnMs) ?? "PRIVATE — nothing leaves this Mac.";
}

/**
 * The /api/chat body for a private ask. The prefix is applied HERE, once, so no
 * caller can forget it — a turn that reaches the route without it is answered
 * by the hosted brain, which is the leak this whole lane exists to prevent.
 * Single turn by design: the private branch never carries deck history
 * (src/app/api/chat/route.ts:411-413).
 *
 * ── SPEECH IS NOT A COMMAND LINE (fix wave) ────────────────────────────────
 * `private …` is a GRAMMAR, not just a prefix: `private ingest <path>` and
 * `private docs` are SUBCOMMANDS (src/lib/private/commands.ts:12-21), and
 * `ingest` runs a server-side read of any absolute path on this Mac
 * (route.ts:663-671). Typed, that is deliberate. SPOKEN, it is an accident
 * waiting to happen — saying "ingest the quarterly report" would have become
 * `{kind:"ingest"}`, hit the filesystem, pass the private-marker gate, and be
 * read back aloud. His VOICE must only ever be able to ASK.
 *
 * The check is the REAL parser, not a lookalike regex: the candidate line is
 * handed to parsePrivateCommand — the same function the route gates on — and
 * anything that does not come back `kind:"chat"` is quoted, which cannot match
 * either subcommand (both are anchored at the start of the rest, and neither
 * can begin with a quote). Using the parser means a subcommand added later is
 * neutralised here automatically instead of silently reopening this hole.
 */
export function privateAskBody(text: string): {
  messages: { role: "user"; content: string }[];
} {
  const said = text.trim();
  const candidate = `${PRIVATE_TURN_PREFIX}${said}`;
  const content =
    parsePrivateCommand(candidate)?.kind === "chat"
      ? candidate
      : `${PRIVATE_TURN_PREFIX}"${said}"`;
  return { messages: [{ role: "user", content }] };
}

/**
 * Is a failed turn a NETWORK BLIP rather than something he must act on?
 *
 * Deliberately narrow (fix wave). Only a fetch that never reached the deck at
 * all counts — the browser's own transport failure, whose message is engine
 * text ("Failed to fetch" in Chrome, "Load failed" in the WebKit this deck also
 * runs in). Those are worth swallowing: the deck is on the same machine, the
 * next utterance retries in seconds, and forcing him to press RETRY over one
 * dropped request is friction with no information in it.
 *
 * EVERYTHING ELSE STAYS A VISIBLE ERROR — a whisper 503, a private lane that
 * did not answer, a reply with no private marker, missing voice assets. Every
 * one of those has a fix he has to run, and a call that quietly went back to
 * "listening" after one would leave him talking into a lane that is down. The
 * unit test asserts that NONE of this module's own thrown messages classify as
 * transient, so the narrow rule cannot widen by accident.
 */
export function isTransientTurnFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  const m = msg.toLowerCase();
  return (
    m.includes("failed to fetch") ||
    m.includes("load failed") ||
    m.includes("networkerror") ||
    m.includes("network request failed")
  );
}

/**
 * Split an SSE read buffer into COMPLETE frame payloads plus the unfinished
 * tail, exactly as the deck's own reader does (stargate-context.tsx:516-521):
 * frames are separated by a blank line, and only `data:` lines carry payload.
 *
 * Pure and exported so the framing is a real test rather than a second
 * hand-copied read loop in a test file — the residual this project already
 * carries once (progress.md, "driveChatStream is a hand-copied mirror") and
 * should not carry twice.
 */
export function takeSsePayloads(buffer: string): {
  payloads: string[];
  rest: string;
} {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const payloads: string[] = [];
  for (const part of parts) {
    const line = part.trim();
    if (!line.startsWith("data:")) continue;
    payloads.push(line.slice(5).trim());
  }
  return { payloads, rest };
}

/** Everything a private reply accumulates as its frames arrive. */
export interface PrivateReplyAcc {
  text: string;
  /** True once `data: {"private":true}` has been seen. The route guarantees it
   * arrives BEFORE any text (src/app/api/chat/route.ts:594-596), so a reply
   * that ends without it did not take the private branch — and is refused
   * rather than spoken. */
  markedPrivate: boolean;
}

export const PRIVATE_REPLY_EMPTY: PrivateReplyAcc = {
  text: "",
  markedPrivate: false,
};

/**
 * Fold one SSE payload into the reply (pure, total, tested). The whole
 * semantics of "what did the private lane actually say, and did it really come
 * from the private lane" lives here, so the hook's read loop is nothing but
 * I/O — there is no branch in it that a test cannot reach.
 */
export function privateReplyStep(
  acc: PrivateReplyAcc,
  payload: string,
): PrivateReplyAcc {
  const frame = classifyChatFrame(payload);
  if (frame.kind === "private") {
    return acc.markedPrivate ? acc : { ...acc, markedPrivate: true };
  }
  if (frame.kind === "text") {
    return { ...acc, text: acc.text + frame.text };
  }
  return acc;
}

/**
 * One barge-in step per mic frame (pure, tested). Mirrors the normal call's gate
 * shape: the streak resets during the grace window and on any quiet frame, and
 * fires exactly once when PRIVATE_BARGE_FRAMES loud frames land in a row.
 */
export function privateBargeStep(
  streak: number,
  loud: boolean,
  inGrace: boolean,
): { streak: number; barge: boolean } {
  if (inGrace) return { streak: 0, barge: false };
  if (!loud) return { streak: 0, barge: false };
  const next = streak + 1;
  if (next >= PRIVATE_BARGE_FRAMES) return { streak: 0, barge: true };
  return { streak: next, barge: false };
}

/**
 * Concatenate the buffered mono frames and wrap them as a 16 kHz WAV.
 *
 * Reuses pcm16ToWavBase64 (wav.ts, already unit-tested) rather than writing a
 * second RIFF header — the base64 hop costs one pass over ~160 KB for a 5 s
 * turn and buys the guarantee that both callers emit byte-identical containers.
 * Pure, and returns bytes because the transcribe route takes a raw body.
 */
export function wavBytesFromFrames(
  frames: Float32Array[],
  sampleRate: number = WHISPER_SAMPLE_RATE,
): Uint8Array {
  let total = 0;
  for (const f of frames) total += f.length;
  const merged = new Float32Array(total);
  let at = 0;
  for (const f of frames) {
    merged.set(f, at);
    at += f.length;
  }
  const base64 = pcm16ToWavBase64(float32ToPCM16(merged), sampleRate);
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ── THE HOOK ───────────────────────────────────────────────────────────────

export interface UsePrivateCallResult {
  state: PrivateCallState;
  error: string | null;
  transcript: VoiceCallTranscriptLine[];
  liveUser: string;
  liveAssistant: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  muted: boolean;
  toggleMute: () => void;
  /** Her live output analyser, taken from the engine bus (speakLocalStream
   * publishes it with source "piper"). Null whenever she is not sounding —
   * a normal state every consumer already renders for. */
  analyser: AnalyserNode | null;
  /** Measured end-of-utterance → first audio for the last completed turn, in ms.
   * Null until one turn has completed. Drives the slower-lane notice. */
  lastTurnMs: number | null;
}

function getAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as Window & { webkitAudioContext?: typeof AudioContext };
  return window.AudioContext ?? w.webkitAudioContext;
}

export function usePrivateCall(): UsePrivateCallResult {
  const [state, setState] = useState<PrivateCallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<VoiceCallTranscriptLine[]>([]);
  const [liveUser, setLiveUser] = useState("");
  const [liveAssistant, setLiveAssistant] = useState("");
  const [muted, setMuted] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [lastTurnMs, setLastTurnMs] = useState<number | null>(null);

  const stateRef = useRef<PrivateCallState>("idle");
  const mutedRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micContextRef = useRef<AudioContext | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);

  /** Bumped by every connect() and disconnect(). Any await that resolves under
   * a stale epoch abandons its work — the same guard useVoiceCall uses so a
   * late getUserMedia cannot resurrect a torn-down call. */
  const epochRef = useRef(0);

  const endpointerRef = useRef<KimiEndpointerState>(KIMI_ENDPOINTER_IDLE);
  const bufferRef = useRef<Float32Array[]>([]);
  const bufferSamplesRef = useRef(0);
  const prerollRef = useRef<Float32Array[]>([]);
  const bargeStreakRef = useRef(0);
  const speakingStartedAtRef = useRef(0);
  const turnAbortRef = useRef<AbortController | null>(null);
  /** True while a turn is in flight, so a second commit cannot start one. */
  const turnBusyRef = useRef(false);

  const setCallState = useCallback((s: PrivateCallState) => {
    stateRef.current = s;
    setState(s);
  }, []);

  // Her face's input comes from whoever is actually sounding. speakLocalStream
  // publishes { speaking, source: "piper", analyser } from the audio element's
  // own events (local-voice.ts:659-661), so mirroring the bus here is reading
  // audio truth rather than guessing it from this hook's state machine.
  useEffect(() => {
    return subscribeEngine((s) => {
      setAnalyser(s.speaking ? s.analyser : null);
    });
  }, []);

  // ── the three legs ───────────────────────────────────────────────────────

  /** EARS. Raw WAV in, one clean line out. Throws with an operator-readable
   * message; never returns a partial or a guess. */
  const transcribe = useCallback(
    async (wav: Uint8Array, signal: AbortSignal): Promise<string> => {
      const res = await fetch(PRIVATE_TRANSCRIBE_PATH, {
        method: "POST",
        headers: { "Content-Type": "audio/wav" },
        // Copy into a fresh ArrayBuffer: a Uint8Array view is a legal BodyInit,
        // but only its own bytes may be sent, and being explicit costs nothing.
        body: wav.slice().buffer as ArrayBuffer,
        signal,
      });
      const payload = (await res.json().catch(() => null)) as
        | { text?: unknown; error?: unknown }
        | null;
      if (!res.ok) {
        const msg =
          typeof payload?.error === "string"
            ? payload.error
            : `Local ears returned HTTP ${res.status}`;
        throw new Error(msg);
      }
      return typeof payload?.text === "string" ? payload.text : "";
    },
    [],
  );

  /** BRAIN. The private lane, streamed. Text is revealed as it arrives so the
   * column is alive during the local model's think time. */
  const askPrivateBrain = useCallback(
    async (text: string, signal: AbortSignal): Promise<string> => {
      const res = await fetch(PRIVATE_CHAT_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(privateAskBody(text)),
        signal,
      });
      if (!res.ok || !res.body) {
        throw new Error("Private lane did not answer. Run: scripts/private-gpt-up.sh");
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let acc = PRIVATE_REPLY_EMPTY;
      // PURE CORE, I/O SHELL: every decision about what this reply is lives in
      // privateReplyStep. This loop only reads bytes, cuts frames and paints.
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const cut = takeSsePayloads(buffer);
          buffer = cut.rest;
          for (const payload of cut.payloads) acc = privateReplyStep(acc, payload);
          if (acc.text) setLiveAssistant(acc.text);
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          /* stream already finished or the socket is gone */
        }
      }
      if (!acc.markedPrivate) {
        // The route never sent the private marker, which means this turn did not
        // take the private branch. Refuse it rather than speak it: an answer
        // from the hosted brain is exactly what this lane must never produce.
        throw new Error(
          "Refused: that reply did not come from the private lane. Nothing was spoken.",
        );
      }
      return acc.text;
    },
    [],
  );

  /** MOUTH. Resolves when her voice has finished (or been cut off), and reports
   * how long the FIRST audio took — measured from the element's own `playing`
   * event via the bus, not from when synthesis was requested. */
  const speak = useCallback(
    async (reply: string, signal: AbortSignal, sinceMs: number): Promise<void> => {
      let firstAudioAt: number | null = null;
      const unsubscribe = subscribeEngine((s) => {
        if (firstAudioAt === null && s.speaking && s.source === "piper") {
          firstAudioAt = Date.now();
        }
      });
      try {
        await speakLocalStream(reply, signal, { allowDuringCall: true });
      } finally {
        unsubscribe();
      }
      if (firstAudioAt !== null) setLastTurnMs(firstAudioAt - sinceMs);
    },
    [],
  );

  // ── the turn ─────────────────────────────────────────────────────────────

  const runTurn = useCallback(
    async (frames: Float32Array[], myEpoch: number) => {
      const ac = new AbortController();
      turnAbortRef.current = ac;
      const utteranceEndedAt = Date.now();
      try {
        setCallState("transcribing");
        setLiveUser("…");
        const wav = wavBytesFromFrames(frames);
        const said = await transcribe(wav, ac.signal);
        if (epochRef.current !== myEpoch || ac.signal.aborted) return;
        if (!said) {
          // Silence, or whisper heard nothing it would commit to. Not an error —
          // go back to listening without putting an empty turn on screen.
          setLiveUser("");
          setCallState("listening");
          return;
        }

        setLiveUser("");
        setTranscript((t) => [...t, { role: "user", text: said }]);
        setCallState("thinking");
        setLiveAssistant("");

        const reply = await askPrivateBrain(said, ac.signal);
        if (epochRef.current !== myEpoch || ac.signal.aborted) return;

        if (reply.trim()) {
          setTranscript((t) => [...t, { role: "assistant", text: reply }]);
          setLiveAssistant("");
          bargeStreakRef.current = 0;
          speakingStartedAtRef.current = Date.now();
          setCallState("speaking");
          await speak(reply, ac.signal, utteranceEndedAt);
        }
        if (epochRef.current !== myEpoch) return;
        setCallState("listening");
      } catch (err) {
        if (epochRef.current !== myEpoch) return;
        if (ac.signal.aborted) {
          // A barge-in or a hang-up. Not a failure — just the end of this turn.
          setLiveUser("");
          setLiveAssistant("");
          if (stateRef.current !== "idle") setCallState("listening");
          return;
        }
        setLiveUser("");
        setLiveAssistant("");
        if (isTransientTurnFailure(err)) {
          // A dropped request, not a lane that is down. Say nothing and listen
          // again — the next utterance retries in seconds. See the function's
          // header for why this is kept this narrow.
          setError(null);
          setCallState("listening");
          return;
        }
        setError(err instanceof Error ? err.message : "Private call failed.");
        setCallState("error");
      } finally {
        if (turnAbortRef.current === ac) turnAbortRef.current = null;
        turnBusyRef.current = false;
      }
    },
    [askPrivateBrain, setCallState, speak, transcribe],
  );

  /** Cut her off: kill the queue, the element and the in-flight request. */
  const bargeIn = useCallback(() => {
    stopLocalStream();
    turnAbortRef.current?.abort();
  }, []);

  // ── mic ──────────────────────────────────────────────────────────────────

  const handleMicFrame = useCallback(
    (frame: Float32Array, contextSampleRate: number) => {
      if (mutedRef.current) return;
      const loud = rms(frame) > PRIVATE_BARGE_RMS;

      if (stateRef.current === "speaking") {
        // BARGE-IN. Her own audio is coming out of the speakers, so this window
        // is exactly where a naive endpointer would record her and answer
        // herself — nothing is buffered here, only the interrupt is evaluated.
        const inGrace =
          Date.now() - speakingStartedAtRef.current < PRIVATE_BARGE_GRACE_MS;
        const step = privateBargeStep(bargeStreakRef.current, loud, inGrace);
        bargeStreakRef.current = step.streak;
        if (step.barge) bargeIn();
        return;
      }

      // While the ears or the brain have the turn, his audio is dropped rather
      // than queued: a half-turn stitched onto the next one is worse than a
      // repeat, and V1 does not overlap turns.
      if (stateRef.current !== "listening") return;
      if (turnBusyRef.current) return;

      const chunk = resampleFloat32(frame, contextSampleRate, WHISPER_SAMPLE_RATE);
      const wasInSpeech = endpointerRef.current.inSpeech;
      const step = kimiEndpointStep(endpointerRef.current, loud);
      endpointerRef.current = step.next;

      if (!wasInSpeech && step.next.inSpeech) {
        // Speech just started — carry the pre-roll in, so the first consonant
        // is in the WAV rather than in the discarded quiet before it.
        bufferRef.current = prerollRef.current.slice();
        bufferSamplesRef.current = 0;
        for (const f of bufferRef.current) bufferSamplesRef.current += f.length;
        prerollRef.current = [];
      }

      if (wasInSpeech || step.next.inSpeech) {
        bufferRef.current.push(chunk);
        bufferSamplesRef.current += chunk.length;
      } else {
        prerollRef.current.push(chunk);
        if (prerollRef.current.length > PRIVATE_PREROLL_FRAMES) {
          prerollRef.current.shift();
        }
      }

      const overCap = bufferSamplesRef.current >= PRIVATE_MAX_UTTERANCE_SAMPLES;
      if (!step.commit && !overCap) return;

      const frames = bufferRef.current;
      const samples = bufferSamplesRef.current;
      bufferRef.current = [];
      bufferSamplesRef.current = 0;
      prerollRef.current = [];
      endpointerRef.current = KIMI_ENDPOINTER_IDLE;
      if (samples < PRIVATE_MIN_UTTERANCE_SAMPLES) return;
      turnBusyRef.current = true;
      void runTurn(frames, epochRef.current);
    },
    [bargeIn, runTurn],
  );

  // ── lifecycle ────────────────────────────────────────────────────────────

  const teardown = useCallback(() => {
    epochRef.current += 1;
    turnAbortRef.current?.abort();
    turnAbortRef.current = null;
    turnBusyRef.current = false;
    stopLocalStream();
    try {
      workletNodeRef.current?.port.close();
    } catch {
      /* already closed */
    }
    try {
      workletNodeRef.current?.disconnect();
    } catch {
      /* already detached */
    }
    workletNodeRef.current = null;
    try {
      micSourceRef.current?.disconnect();
    } catch {
      /* already detached */
    }
    micSourceRef.current = null;
    try {
      micStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* already stopped */
    }
    micStreamRef.current = null;
    try {
      void micContextRef.current?.close();
    } catch {
      /* already closed */
    }
    micContextRef.current = null;
    endpointerRef.current = KIMI_ENDPOINTER_IDLE;
    bufferRef.current = [];
    bufferSamplesRef.current = 0;
    prerollRef.current = [];
    bargeStreakRef.current = 0;
  }, []);

  const disconnect = useCallback(() => {
    teardown();
    publishCallLive(false);
    setLiveUser("");
    setLiveAssistant("");
    setCallState("idle");
  }, [setCallState, teardown]);

  const connect = useCallback(async () => {
    if (typeof window === "undefined") return;
    teardown();
    const myEpoch = epochRef.current;
    setError(null);
    setTranscript([]);
    setLiveUser("");
    setLiveAssistant("");
    setCallState("connecting");

    // ONE VOICE — claim her voice for the call before anything opens, the same
    // claim VoiceCallOverlay raises for the normal engine. From here until
    // disconnect no chat-side engine can make a sound (speak.ts:803-825).
    publishCallLive(true);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access is not available in this browser.");
      }
      const AudioContextCtor = getAudioContextCtor();
      if (!AudioContextCtor) {
        throw new Error("Web Audio is not available in this browser.");
      }

      // The local mouth's assets are a hard prerequisite, and their absence is
      // SILENCE by design (local-voice.ts:420-434) — so say so up front with the
      // command that fixes it, rather than letting him talk to a mute call.
      if (!(await localAssetsAvailable())) {
        throw new Error(
          "Her local voice has no model files. Run: scripts/bootstrap-piper-assets.sh",
        );
      }
      if (epochRef.current !== myEpoch) return;

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
        throw new Error(
          name === "NotAllowedError" || name === "SecurityError"
            ? "Microphone blocked. Click Allow when Chrome asks — or turn on Google Chrome under  → System Preferences → Security & Privacy → Microphone, then reopen the call."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "No microphone found. Connect one and reopen the call."
              : `Microphone unavailable: ${micErr instanceof Error ? micErr.message : "unknown error"}`,
        );
      }
      if (epochRef.current !== myEpoch) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      micStreamRef.current = stream;

      const micContext = new AudioContextCtor();
      micContextRef.current = micContext;
      try {
        await micContext.resume?.();
      } catch {
        /* a suspended context still delivers frames once the OS starts it */
      }
      await micContext.audioWorklet.addModule("/pcm-worklet-processor.js");
      if (epochRef.current !== myEpoch) return;

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
        if (epochRef.current !== myEpoch) return;
        handleMicFrame(ev.data, micContext.sampleRate);
      };
      // Mic -> worklet only, never onward to the destination: routing it to the
      // speakers would put his own voice in his ears at a delay.
      micSource.connect(workletNode);

      setCallState("listening");
    } catch (err) {
      if (epochRef.current !== myEpoch) return;
      teardown();
      publishCallLive(false);
      setError(err instanceof Error ? err.message : "Private call failed to open.");
      setCallState("error");
    }
  }, [handleMicFrame, setCallState, teardown]);

  const toggleMute = useCallback(() => {
    setMuted((m) => {
      const next = !m;
      mutedRef.current = next;
      return next;
    });
  }, []);

  // Never leave a mic, a context or a voice claim behind on unmount.
  useEffect(() => {
    return () => {
      teardown();
      publishCallLive(false);
    };
  }, [teardown]);

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
    analyser,
    lastTurnMs,
  };
}
