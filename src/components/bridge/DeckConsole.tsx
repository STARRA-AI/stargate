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
    await new Promise((r) => setTimeout(r, 18));
  }
}

export function DeckConsole({ onMic }: { onMic?: () => void }) {
  const { setHudState, setLastReply, pushLog, hudState, lastReply } =
    useStargate();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [history, streaming]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

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
          signal: ac.signal,
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
        await revealText(full, setStreaming, ac.signal);
        setHistory((h) => [...h, { role: "assistant", content: full }]);
        setLastReply(full);
        setStreaming("");
        setHudState("idle");
        pushLog("[ORACLE] reply landed");
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
    "STARRA >> STARGATE online. Dragon Trader uplink is live, repo is clean, and I have 3 proposals waiting for you, boss.";

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
          🎙
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Speak to STARRA — type, or use the mic..."
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
