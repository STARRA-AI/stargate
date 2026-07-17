"use client";

import { COPY } from "@/lib/copy";
import { CHIPS } from "@/lib/deck-demo";
import { useStargate } from "@/lib/stargate-context";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";

type Msg = { role: "user" | "assistant"; content: string };

function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

async function revealText(
  full: string,
  onTick: (partial: string) => void,
  signal: AbortSignal,
) {
  if (prefersReducedMotion()) {
    onTick(full);
    return;
  }
  let out = "";
  for (const ch of full) {
    if (signal.aborted) return;
    out += ch;
    onTick(out);
    await new Promise((r) => setTimeout(r, 30));
  }
}

export function DeckConsole({ onMic }: { onMic?: () => void }) {
  const { setHudState, setLastReply, pushLog, hudState, lastReply } =
    useStargate();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState("");
  const fetchAbortRef = useRef<AbortController | null>(null);
  const revealAbortRef = useRef<AbortController | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  function abortInFlight() {
    fetchAbortRef.current?.abort();
    revealAbortRef.current?.abort();
    ttsAbortRef.current?.abort();
    fetchAbortRef.current = null;
    revealAbortRef.current = null;
    ttsAbortRef.current = null;
  }

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [history, streaming]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      abortInFlight();
      const fetchAc = new AbortController();
      const revealAc = new AbortController();
      const ttsAc = new AbortController();
      fetchAbortRef.current = fetchAc;
      revealAbortRef.current = revealAc;
      ttsAbortRef.current = ttsAc;

      // Prime Web Speech during user gesture — async fetch loses activation otherwise.
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.resume();
        window.speechSynthesis.getVoices();
      }

      // #region agent log
      fetch(
        "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Debug-Session-Id": "f8c9f7",
          },
          body: JSON.stringify({
            sessionId: "f8c9f7",
            location: "DeckConsole.tsx:send-start",
            message: "console send started",
            data: {
              chars: trimmed.length,
              viewportW: window.innerWidth,
              speechPaused: window.speechSynthesis?.paused ?? null,
              voiceCount: window.speechSynthesis?.getVoices().length ?? 0,
            },
            timestamp: Date.now(),
            hypothesisId: "H-A",
            runId: "post-fix-3",
          }),
        },
      ).catch(() => {});
      // #endregion

      const nextHistory: Msg[] = [
        ...history,
        { role: "user", content: trimmed },
      ];
      setHistory(nextHistory);
      setInput("");
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
                setStreaming(full);
              }
            } catch {
              /* ignore */
            }
          }
        }

        setHudState("speaking");
        setLastReply(full);
        // Speak immediately — do not wait for typewriter reveal (was blocking TTS 8s+).
        const { speakStarra, getLastSpeakEngine } = await import(
          "@/lib/voice/speak"
        );
        const speakPromise = speakStarra(full, ttsAc.signal);
        await revealText(full, setStreaming, revealAc.signal);
        setHistory((h) => [...h, { role: "assistant", content: full }]);
        const engine = await speakPromise;
        // #region agent log
        fetch(
          "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Debug-Session-Id": "f8c9f7",
            },
            body: JSON.stringify({
              sessionId: "f8c9f7",
              location: "DeckConsole.tsx:send",
              message: "console reply + TTS",
              data: {
                replyChars: full.length,
                copyOnly: /^copy\.?\s*$/i.test(full.trim()),
                engine,
                lastEngine: getLastSpeakEngine(),
                preview: full.slice(0, 120),
              },
              timestamp: Date.now(),
              hypothesisId: "H-A",
              runId: "post-fix-3",
            }),
          },
        ).catch(() => {});
        // #endregion
        setStreaming("");
        setHudState("idle");
        pushLog(`[ORACLE] reply landed · voice ${engine}`);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setHudState("error");
        setLastReply(COPY.error);
        pushLog("[SYS] link degraded");
      }
    },
    [history, pushLog, setHudState, setLastReply],
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  const waveLive =
    hudState === "listening" ||
    hudState === "wake" ||
    hudState === "speaking" ||
    hudState === "streaming" ||
    hudState === "thinking";

  const standingBy =
    "STANDING BY. ASK FOR THE BRIEF.";

  return (
    <div className="console">
      <div className="console-head">
        <span className="panel-title">OPERATOR CONSOLE</span>
        <div className="spacer" />
        <div className="wave-bars" aria-hidden>
          {Array.from({ length: 14 }).map((_, i) => (
            <span
              key={i}
              className={`wave-bar${waveLive ? " live speaking" : ""}`}
              style={
                waveLive
                  ? { animationDuration: `${0.4 + (i % 5) * 0.12}s` }
                  : undefined
              }
            />
          ))}
        </div>
      </div>

      <div className="chat-log" ref={logRef}>
        {history.length === 0 && !streaming ? (
          <div className="chat-line">
            <span className="chat-who starra">STARRA</span>{" "}
            <span className="chat-text">{lastReply || standingBy}</span>
          </div>
        ) : null}
        {history.map((m, i) => (
          <div className="chat-line" key={`${m.role}-${i}`}>
            <span className={`chat-who ${m.role === "user" ? "you" : "starra"}`}>
              {m.role === "user" ? "YOU" : "STARRA"}
            </span>{" "}
            <span className="chat-text">{m.content}</span>
          </div>
        ))}
        {streaming ? (
          <div className="chat-line pending">
            <span className="chat-who starra">STARRA</span>{" "}
            <span className="chat-text">{streaming}</span>
          </div>
        ) : null}
      </div>

      <div className="chip-row">
        {CHIPS.map((label) => (
          <button
            key={label}
            type="button"
            className="chip"
            onClick={() => void send(label)}
          >
            {label}
          </button>
        ))}
      </div>

      <form className="chat-input-row" onSubmit={onSubmit}>
        <button
          type="button"
          className="mic-btn"
          title="Voice input"
          onClick={onMic}
          aria-label="Microphone"
        >
          MIC
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='> "GIVE ME THE BRIEF."'
          autoComplete="off"
          aria-label="Console input"
        />
        <button type="submit" className="send-btn">
          SEND
        </button>
      </form>
    </div>
  );
}
