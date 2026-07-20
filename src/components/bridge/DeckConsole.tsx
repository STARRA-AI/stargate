"use client";

import { COPY } from "@/lib/copy";
import { CHIPS } from "@/lib/deck-demo";
import { useStargate } from "@/lib/stargate-context";
import { useCallback, useEffect, useRef, useState } from "react";
import { Composer } from "./Composer";
import { MessageColumn, type Msg } from "./MessageColumn";

export function DeckConsole({ onMic }: { onMic?: () => void }) {
  const { setHudState, setLastReply, pushLog, hudState, lastReply } =
    useStargate();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState("");
  const fetchAbortRef = useRef<AbortController | null>(null);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  function abortInFlight() {
    fetchAbortRef.current?.abort();
    ttsAbortRef.current?.abort();
    fetchAbortRef.current = null;
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
      const ttsAc = new AbortController();
      fetchAbortRef.current = fetchAc;
      ttsAbortRef.current = ttsAc;

      // Prime Web Speech during user gesture — async fetch loses activation otherwise.
      if (typeof window !== "undefined" && window.speechSynthesis) {
        window.speechSynthesis.resume();
        window.speechSynthesis.getVoices();
      }


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
        // Speak immediately. `full` already rendered live via setStreaming()
        // above during the read loop, so commit straight to history instead
        // of re-typing it character-by-character (was re-parsing markdown
        // on every char after the text had already appeared).
        const { speakStarra } = await import("@/lib/voice/speak");
        const speakPromise = speakStarra(full, ttsAc.signal);
        setHistory((h) => [...h, { role: "assistant", content: full }]);
        const engine = await speakPromise;
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

      <MessageColumn
        ref={logRef}
        history={history}
        streaming={streaming}
        resting={lastReply || standingBy}
      />

      <div className="composer-dock">
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

        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => void send(input)}
          onMic={onMic}
          placeholder='> "GIVE ME THE BRIEF."'
        />
      </div>
    </div>
  );
}
