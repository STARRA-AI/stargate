"use client";

import { CHIPS } from "@/lib/deck-demo";
import { useStargate, useStargateStream } from "@/lib/stargate-context";
import { useEffect, useRef, useState } from "react";
import { Composer } from "./Composer";
import { MessageColumn } from "./MessageColumn";

export function DeckConsole({ onMic }: { onMic?: () => void }) {
  // Split on purpose: hudState/lastReply come from the main context (stable
  // outside of real HUD transitions); history/streaming/sendMessage come
  // from the stream-only context, which updates on every SSE token. Only
  // this component (and its MessageColumn child) should feel that churn —
  // see stargate-context.tsx for why.
  const { hudState, lastReply } = useStargate();
  const { history, streaming, sendMessage } = useStargateStream();
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [history, streaming]);

  function submit(text: string) {
    if (!text.trim()) return;
    setInput("");
    void sendMessage(text);
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
              onClick={() => submit(label)}
            >
              {label}
            </button>
          ))}
        </div>

        <Composer
          value={input}
          onChange={setInput}
          onSubmit={() => submit(input)}
          onMic={onMic}
          placeholder='> "GIVE ME THE BRIEF."'
        />
      </div>
    </div>
  );
}
