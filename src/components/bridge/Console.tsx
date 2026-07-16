"use client";

import { COPY } from "@/lib/copy";
import { useStargate } from "@/lib/stargate-context";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
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

export function Console({ onMic }: { onMic?: () => void }) {
  const {
    setHudState,
    setLastReply,
    pushLog,
    lastReply,
  } = useStargate();
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Msg[]>([]);
  const [streaming, setStreaming] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, streaming, lastReply]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      const nextHistory: Msg[] = [...history, { role: "user", content: trimmed }];
      setHistory(nextHistory);
      setInput("");
      setStreaming("");
      setHudState("thinking");
      pushLog(`cmd: ${trimmed.slice(0, 48)}`);

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
          pushLog("link degraded");
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
              /* ignore malformed chunk */
            }
          }
        }

        const revealAc = new AbortController();
        setHudState("speaking");
        await revealText(full, setStreaming, revealAc.signal);
        setHistory((h) => [...h, { role: "assistant", content: full }]);
        setLastReply(full);
        setStreaming("");
        setHudState("idle");
        pushLog("reply landed");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setHudState("error");
        setLastReply(COPY.error);
        pushLog("link degraded");
      }
    },
    [history, pushLog, setHudState, setLastReply],
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void send(input);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  }

  const display =
    streaming ||
    lastReply ||
    "Standing by. Ask for the brief when ready.";

  return (
    <section className="panel-etch flex flex-col gap-3 p-3 md:p-4">
      <div className="max-h-36 min-h-[4.5rem] overflow-y-auto font-[family-name:var(--font-mono)] text-sm leading-relaxed text-[var(--chrome)] md:max-h-44">
        {history.slice(-4).map((m, i) => (
          <p key={`${m.role}-${i}`} className="mb-2">
            <span className="text-[var(--purple)]">
              {m.role === "user" ? ">" : "◆"}{" "}
            </span>
            {m.content}
          </p>
        ))}
        {streaming ? (
          <p>
            <span className="text-[var(--magenta)]">◆ </span>
            {streaming}
            <span className="animate-pulse">▌</span>
          </p>
        ) : history.length === 0 ? (
          <p>
            <span className="text-[var(--magenta)]">◆ </span>
            {display}
          </p>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={onSubmit}
        className="flex items-center gap-2 border-t border-[var(--border-soft)] pt-3"
      >
        <button
          type="button"
          aria-label="Microphone"
          onClick={onMic}
          className="focus-magenta shrink-0 border border-[var(--border)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.2em] text-[var(--magenta)] uppercase"
        >
          {COPY.mic}
        </button>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder='> "Give me the brief."'
          className="focus-magenta min-w-0 flex-1 bg-transparent px-2 py-2 font-[family-name:var(--font-mono)] text-sm text-[var(--chrome)] outline-none placeholder:text-[color-mix(in_oklab,var(--chrome)_35%,transparent)]"
          aria-label="Console input"
        />
        <button
          type="submit"
          className="focus-magenta shrink-0 border border-[var(--purple)] bg-[color-mix(in_oklab,var(--purple)_18%,transparent)] px-4 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] text-[var(--chrome)] uppercase"
        >
          {COPY.send}
        </button>
      </form>
    </section>
  );
}
