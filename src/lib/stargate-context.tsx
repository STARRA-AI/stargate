"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { HudState } from "@/lib/tokens";
import { COPY, statusForState } from "@/lib/copy";
import {
  getBootGreeting,
  getBootGreetingMuted,
  getSyncReplies,
} from "@/lib/voice/deck-prefs";

/**
 * G3 — SYNC REPLIES. Why the reply text is allowed to wait for her voice.
 *
 * Default OFF, and OFF is byte-for-byte today's behaviour: the read loop calls
 * setStreaming per chunk and the text races ahead of the audio. That is the
 * right default — for a long answer, reading ahead is a feature.
 *
 * ON holds the whole reveal until her voice ACTUALLY starts, so the words land
 * with the sound instead of finishing thirty seconds before it.
 */
export type RevealReason =
  /** Sync is off — text flows as it streams, exactly as it always has. */
  | "stream"
  /** The TTS bus reported real audio (`playing: true`). The happy path. */
  | "audio"
  /** Nothing ever started making noise. Show the text anyway. */
  | "timeout"
  /** Barge-in or a newer turn killed this one. */
  | "abort"
  /** speakStarra finished/failed without ever playing (e.g. engine "none"). */
  | "silent";

/**
 * How long the reveal may wait on audio that never arrives.
 *
 * 2.5s is chosen against the actual TTS path, not picked round: speakStarra
 * fetches synthesized audio from /api/tts (a network round trip to xAI) and
 * only then does the element fire `playing`. A healthy synth lands well inside
 * this; a wedged one does not, and past ~2.5s a reader has stopped believing
 * the answer is coming.
 *
 * THIS TIMEOUT IS A SAFETY NET, NOT A TUNING KNOB. Its whole job is that a
 * silent TTS failure can never leave Classic staring at a blank reply that
 * already arrived. Every other exit (abort, engine "none", speakStarra
 * resolving early) releases immediately and does not wait for it.
 */
export const SYNC_REPLY_RELEASE_TIMEOUT_MS = 2500;

export interface ReplyRevealGate {
  /** Feed the FULL accumulated text so far. Reveals immediately when not holding. */
  push(full: string): void;
  /** Release the held text. First call wins; later calls are ignored. */
  release(reason: RevealReason): void;
  /** True while text is being withheld. */
  held(): boolean;
  /** What released it, or null if it is still held / never held. */
  reason(): RevealReason | null;
}

/**
 * The gate, as a pure unit with no React and no browser in it — so
 * tests/sync-replies-gate.test.ts can drive every path (chunk, audio, timeout,
 * abort) directly instead of trying to fake an audio element.
 */
export function createReplyRevealGate(opts: {
  syncReplies: boolean;
  reveal: (text: string) => void;
}): ReplyRevealGate {
  let latest = "";
  // Sync OFF starts already-open: nothing is ever withheld, so push() reveals.
  let holding = opts.syncReplies;
  let released: RevealReason | null = null;

  return {
    push(full: string) {
      latest = full;
      if (!holding) opts.reveal(full);
    },
    release(reason: RevealReason) {
      if (released !== null) return; // exactly-once
      released = reason;
      holding = false;
      opts.reveal(latest);
    },
    held: () => holding,
    reason: () => released,
  };
}

export type ActionLogEntry = {
  id: string;
  time: string;
  text: string;
};

/** One chat turn. Structurally identical to MessageColumn's `Msg` — shared
 * conversation state lives here so both typed chat (DeckConsole) and voice
 * (useVoiceLoop) read/write the same transcript. */
export type Msg = { role: "user" | "assistant"; content: string };

export type ConnectorStatus = "connected" | "available" | "error";

export type Connector = {
  id: string;
  name: string;
  status: ConnectorStatus;
};

export type SnapStats = {
  mrrLabel: string;
  tasksDue: number;
  pipelineOpen: number;
  working: number;
  summaries: number;
  archival: number;
};

type StargateContextValue = {
  hudState: HudState;
  setHudState: (s: HudState) => void;
  statusLine: string;
  lastReply: string;
  setLastReply: (t: string) => void;
  actionLog: ActionLogEntry[];
  pushLog: (text: string) => void;
  connectors: Connector[];
  snap: SnapStats;
  setSnap: (s: SnapStats | ((prev: SnapStats) => SnapStats)) => void;
  toolName?: string;
  setToolName: (n?: string) => void;
  bootDone: boolean;
  setBootDone: (v: boolean) => void;
  /**
   * Single entry point for a chat turn: streams /api/chat with prior
   * `history` as context, commits user+assistant turns to `history`, and
   * speaks the reply via speakStarra. Used by both DeckConsole (typed) and
   * useVoiceLoop (voice) so there is exactly one conversation + HUD state
   * machine.
   *
   * Also re-exposed (identical function, not a copy) on
   * `StargateStreamContext` below — kept here too, on the main context,
   * purely so `useVoiceLoop`'s existing `useStargate()` destructure keeps
   * compiling unchanged. Its identity is stable across renders (see the
   * `useCallback` deps in `StargateProvider`), so including it here never
   * invalidates the main context's memo.
   */
  sendMessage: (text: string) => Promise<void>;
  /**
   * Barge-in primitive: aborts any in-flight sendMessage turn (fetch + TTS)
   * and kills any currently playing audio. Does NOT touch HUD state — the
   * caller (e.g. useVoiceLoop's wake()) owns the coherent state transition
   * that follows, so a stale turn resolving later can never clobber it.
   * Same stable-identity note as `sendMessage` above.
   */
  stopSpeaking: () => void;
};

/**
 * Perf-motivated split from `StargateContextValue`: `history` and
 * `streaming` change on every SSE token during a reply. Bundling them into
 * the main context (as before) meant every consumer of `useStargate()` —
 * effectively all of `Bridge`'s ~900-line tree — re-rendered on every
 * streamed character. Consumers that only need hud/snap/connectors/etc.
 * should use `useStargate()`; only the chat surface (`DeckConsole`,
 * `MessageColumn`) should use `useStargateStream()`.
 */
type StargateStreamContextValue = {
  /** Shared conversation transcript — committed turns (typed chat + voice). */
  history: Msg[];
  /** In-progress assistant text for the currently streaming turn, if any. */
  streaming: string;
  sendMessage: (text: string) => Promise<void>;
  stopSpeaking: () => void;
  /** Fold turns from the shared memory store into the visible history (e.g.
   *  call turns after a call ends). Appends only entries not already shown. */
  resyncHistory: () => Promise<void>;
};

const StargateContext = createContext<StargateContextValue | null>(null);
const StargateStreamContext = createContext<StargateStreamContextValue | null>(
  null,
);

function nowStamp() {
  const d = new Date();
  return d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

const DEFAULT_CONNECTORS: Connector[] = [
  { id: "ollama", name: "Ollama R1", status: "connected" },
  { id: "repomix", name: "Repomix", status: "connected" },
  { id: "openmontage", name: "OpenMontage", status: "available" },
  { id: "prompts", name: "Prompt Structure", status: "connected" },
  { id: "calendar", name: "Calendar", status: "available" },
  { id: "gmail", name: "Gmail", status: "available" },
];

const DEFAULT_SNAP: SnapStats = {
  mrrLabel: "—",
  tasksDue: 0,
  pipelineOpen: 0,
  working: 0,
  summaries: 0,
  archival: 0,
};

export function StargateProvider({ children }: { children: ReactNode }) {
  const [hudState, setHudState] = useState<HudState>("idle");
  const [lastReply, setLastReply] = useState("");
  const [actionLog, setActionLog] = useState<ActionLogEntry[]>([
    { id: "1", time: nowStamp(), text: "[SCAN] Dragon Tradar uplink handshake OK" },
    { id: "2", time: nowStamp(), text: "[ORACLE] Think Tank consensus refreshed — 4/4 LONG" },
    { id: "3", time: nowStamp(), text: "[THNK] Proposal queue: 3 awaiting operator" },
    { id: "4", time: nowStamp(), text: "[EXEC] STARGATE kernel online — standing by" },
    { id: "5", time: nowStamp(), text: "[REPO] Working tree clean" },
  ]);
  const [connectors] = useState<Connector[]>(DEFAULT_CONNECTORS);
  const [snap, setSnap] = useState<SnapStats>(DEFAULT_SNAP);
  const [toolName, setToolName] = useState<string | undefined>();
  const [bootDone, setBootDone] = useState(false);
  const [history, setHistory] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState("");
  const fetchAbortRef = useRef<AbortController | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  // Mirrors `history` so sendMessage can read the latest committed history
  // synchronously when building the fetch body, without assigning to an
  // outer variable from inside the setHistory updater (which must stay pure
  // — React may invoke it more than once, e.g. under StrictMode).
  const historyRef = useRef<Msg[]>(history);
  historyRef.current = history;

  /**
   * G2 — SPOKEN BOOT GREETING. She says one line once the deck finishes
   * booting.
   *
   * FIRED FROM HERE, NOT FROM Bridge/DeckBoot, ON PURPOSE. `bootDone` is
   * already the boot-complete signal in this provider (DeckBoot's `onDone`
   * sets it), so an effect on it needs ZERO change to DeckBoot's
   * `{ onDone: () => void }` prop and ZERO change to Bridge — the greeting
   * costs no edit to anyone else's file.
   *
   * FIRES EXACTLY ONCE PER PAGE LOAD. The ref guard is not belt-and-braces:
   * React StrictMode double-invokes effects in development, and without it she
   * would greet him twice, over herself, every single boot.
   *
   * MUTED MEANS NEVER SYNTHESIZED — the check happens before the dynamic
   * import, so a muted greeting does not even load the TTS module, let alone
   * make a request to /api/tts.
   *
   * AND IT CAN NEVER BLOCK THE DECK: the whole thing is fire-and-forget behind
   * a catch. If TTS is down, boot completes in silence and nothing else knows.
   */
  const bootGreetedRef = useRef(false);
  useEffect(() => {
    if (!bootDone || bootGreetedRef.current) return;
    bootGreetedRef.current = true;
    if (getBootGreetingMuted()) return;
    const line = getBootGreeting().trim();
    if (!line) return;
    void (async () => {
      try {
        const { speakStarra } = await import("@/lib/voice/speak");
        await speakStarra(line);
      } catch {
        /* a boot greeting is never worth a broken boot */
      }
    })();
  }, [bootDone]);

  // ONE MEMORY: seed the visible conversation from the shared store on boot,
  // so a reload resumes the same continuous conversation the brain and the
  // call already remember (api/chat and the call leg both write it). Seeds
  // ONLY an empty history — it never clobbers a conversation in progress.
  // Fail-open: a failed or empty read just leaves today's empty start.
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/memory")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { working?: Array<{ role?: string; content?: string }> } | null) => {
        if (cancelled || !j || !Array.isArray(j.working) || j.working.length === 0) return;
        const seed: Msg[] = j.working
          .filter(
            (e): e is { role: "user" | "assistant"; content: string } =>
              (e.role === "user" || e.role === "assistant") &&
              typeof e.content === "string" &&
              e.content.trim().length > 0,
          )
          .map((e) => ({ role: e.role, content: e.content }));
        if (seed.length === 0) return;
        setHistory((prev) => (prev.length === 0 ? seed : prev));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const pushLog = useCallback((text: string) => {
    setActionLog((prev) => [
      { id: `${Date.now()}`, time: nowStamp(), text },
      ...prev,
    ].slice(0, 40));
  }, []);

  const statusLine = useMemo(
    () => statusForState(hudState, toolName),
    [hudState, toolName],
  );

  /** Abort whatever turn (fetch and/or TTS) is currently in flight. */
  const abortTurn = useCallback(() => {
    fetchAbortRef.current?.abort();
    ttsAbortRef.current?.abort();
    fetchAbortRef.current = null;
    ttsAbortRef.current = null;
  }, []);

  const stopSpeaking = useCallback(() => {
    abortTurn();
    void import("@/lib/voice/speak").then(({ stopAllSpeech }) => stopAllSpeech());
  }, [abortTurn]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      abortTurn();
      const fetchAc = new AbortController();
      const ttsAc = new AbortController();
      fetchAbortRef.current = fetchAc;
      ttsAbortRef.current = ttsAc;

      // Prime Web Speech during the triggering gesture — async fetch loses
      // activation otherwise.
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.resume();
        window.speechSynthesis.getVoices();
      }

      const nextHistory: Msg[] = [...historyRef.current, { role: "user", content: trimmed }];
      setHistory(nextHistory);
      setStreaming("");
      setHudState("thinking");
      pushLog(`[EXEC] ${trimmed.slice(0, 48)}`);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: nextHistory }),
          signal: fetchAc.signal,
        });

        if (!res.ok || !res.body) {
          setHudState("error");
          setLastReply(COPY.error);
          pushLog("[SYS] link degraded");
          return;
        }

        setHudState("streaming");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";

        // G3. Read the pref ONCE per turn: flipping the toggle mid-reply must
        // not strand half a reveal in a state neither branch expects.
        const syncReplies = getSyncReplies();
        const gate = createReplyRevealGate({
          syncReplies,
          reveal: (t) => setStreaming(t),
        });

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload) as { text?: string };
              if (json.text) {
                full += json.text;
                // OFF: reveals now, identical to the old setStreaming(full).
                // ON: buffered — released below once her voice is real.
                gate.push(full);
              }
            } catch {
              /* ignore */
            }
          }
        }

        setHudState("speaking");
        setLastReply(full);
        // Speak immediately. With sync OFF, `full` already rendered live during
        // the read loop, so commit straight to history instead of re-typing it
        // character-by-character.
        const { speakStarra, subscribeTtsAudio, getTtsAudio } = await import(
          "@/lib/voice/speak"
        );
        const speakPromise = speakStarra(full, ttsAc.signal);

        // G3 ON: the reply is still buffered. Hold the commit until her voice
        // is genuinely audible, then release everything at once.
        //
        // The commit below is what actually puts the reply on screen (the
        // streaming mirror is cleared right after it), so holding the reveal
        // means holding THIS, not just the mirror — releasing the mirror alone
        // would be pointless because the commit two lines later would reveal
        // the text anyway.
        if (gate.held()) {
          await new Promise<void>((resolve) => {
            let settled = false;
            let unsubscribe: (() => void) | null = null;
            let timer: ReturnType<typeof setTimeout> | null = null;

            const finish = (reason: RevealReason) => {
              if (settled) return;
              settled = true;
              if (timer !== null) clearTimeout(timer);
              unsubscribe?.();
              ttsAc.signal.removeEventListener("abort", onAbort);
              gate.release(reason);
              resolve();
            };

            function onAbort() {
              finish("abort");
            }

            // Barge-in during the hold must show the text immediately — an
            // interrupted turn still said something worth reading.
            if (ttsAc.signal.aborted) return finish("abort");
            ttsAc.signal.addEventListener("abort", onAbort, { once: true });

            // `playing` (not `play`) is the event behind this flag — it means
            // sound is actually coming out. See speak.ts.
            if (getTtsAudio().playing) return finish("audio");
            unsubscribe = subscribeTtsAudio((s) => {
              if (s.playing) finish("audio");
            });

            // speakStarra resolving without ever playing means there was no
            // audio to sync to — engine "none", a failed synth, an empty
            // utterance. Release at once rather than serving out the timeout.
            void speakPromise.then(() => finish("silent")).catch(() => finish("silent"));

            timer = setTimeout(() => finish("timeout"), SYNC_REPLY_RELEASE_TIMEOUT_MS);
          });
        }

        setHistory((h) => [...h, { role: "assistant", content: full }]);
        // Turn is committed to history now — clear the streaming mirror
        // immediately so MessageColumn doesn't render the reply twice for
        // the duration of TTS playback below.
        setStreaming("");
        const engine = await speakPromise;
        if (ttsAc.signal.aborted) {
          // Barge-in (or a newer turn) already interrupted this one and owns
          // whatever HUD state comes next — don't clobber it.
          return;
        }
        setHudState("idle");
        pushLog(`[ORACLE] reply landed · voice ${engine}`);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setHudState("error");
        setLastReply(COPY.error);
        pushLog("[SYS] link degraded");
      } finally {
        if (fetchAbortRef.current === fetchAc) fetchAbortRef.current = null;
        if (ttsAbortRef.current === ttsAc) ttsAbortRef.current = null;
      }
    },
    [abortTurn, pushLog, setHudState],
  );

  // Deliberately does NOT depend on `history`/`streaming` — those live only
  // in `streamValue` below. sendMessage/stopSpeaking have stable identity
  // (see their useCallback deps above), so this object only changes on real
  // hud/snap/connector/etc. transitions, not on every streamed token. That
  // stability is what stops a chat reply from re-rendering all of Bridge.
  const value = useMemo(
    () => ({
      hudState,
      setHudState,
      statusLine,
      lastReply,
      setLastReply,
      actionLog,
      pushLog,
      connectors,
      snap,
      setSnap,
      toolName,
      setToolName,
      bootDone,
      setBootDone,
      sendMessage,
      stopSpeaking,
    }),
    [
      hudState,
      statusLine,
      lastReply,
      actionLog,
      pushLog,
      connectors,
      snap,
      toolName,
      bootDone,
      sendMessage,
      stopSpeaking,
    ],
  );

  // ONE TRANSCRIPT: fold store turns the UI hasn't shown yet into the visible
  // history — the call leg records its turns into the shared store, and this
  // is how they appear in the deck chat the moment a call ends, no reload.
  // Append-only and deduped against what's already on screen; never touches
  // an in-flight streaming turn.
  const resyncHistory = useCallback(async () => {
    try {
      const r = await fetch("/api/memory");
      if (!r.ok) return;
      const j = (await r.json()) as {
        working?: Array<{ role?: string; content?: string }>;
      } | null;
      if (!j || !Array.isArray(j.working)) return;
      const incoming: Msg[] = j.working
        .filter(
          (e): e is { role: "user" | "assistant"; content: string } =>
            (e.role === "user" || e.role === "assistant") &&
            typeof e.content === "string" &&
            e.content.trim().length > 0,
        )
        .map((e) => ({ role: e.role, content: e.content }));
      if (incoming.length === 0) return;
      setHistory((prev) => {
        const seen = new Set(prev.map((m) => `${m.role}\u0000${m.content}`));
        const fresh = incoming.filter(
          (m) => !seen.has(`${m.role}\u0000${m.content}`),
        );
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
    } catch {
      /* fail-open — the visible history just stays as it was */
    }
  }, []);

  const streamValue = useMemo(
    () => ({ history, streaming, sendMessage, stopSpeaking, resyncHistory }),
    [history, streaming, sendMessage, stopSpeaking, resyncHistory],
  );

  return (
    <StargateContext.Provider value={value}>
      <StargateStreamContext.Provider value={streamValue}>
        {children}
      </StargateStreamContext.Provider>
    </StargateContext.Provider>
  );
}

export function useStargate() {
  const ctx = useContext(StargateContext);
  if (!ctx) throw new Error("useStargate must be used within StargateProvider");
  return ctx;
}

/**
 * Conversation-only context: `history`, `streaming`, and the two chat
 * entry points. Consume this (not `useStargate()`) from anything that needs
 * to react to in-progress streaming text — currently `DeckConsole` and, via
 * its props, `MessageColumn`. Keeping this separate from `useStargate()` is
 * the fix for Bridge re-rendering its whole tree on every SSE token.
 */
export function useStargateStream() {
  const ctx = useContext(StargateStreamContext);
  if (!ctx) {
    throw new Error("useStargateStream must be used within StargateProvider");
  }
  return ctx;
}
