"use client";

import { forwardRef, memo, useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";

export type Msg = { role: "user" | "assistant"; content: string };

/** Blinking magenta streaming caret. Steadied under reduced-motion via CSS. */
const CARET = <span className="stream-caret" aria-hidden />;

/** Coalesce streaming markdown re-parses to roughly this cadence (ms). SSE
 * chunks can arrive many times a second; re-parsing the whole reply's
 * markdown on every chunk is O(n^2) over a long reply. ~260ms gives ~3-4
 * re-renders/sec, which reads as smooth continuous text without redoing the
 * parse on every token. */
const STREAM_THROTTLE_MS = 260;

/**
 * Throttled mirror of `value`: while `active`, updates to `display` are
 * coalesced to at most once per `intervalMs` (leading edge fires
 * immediately so the first chunk of a reply appears without delay; a
 * trailing timeout guarantees the latest value is always eventually
 * flushed). While inactive, `display` tracks `value` immediately — used so
 * a finished/historical turn always renders its full, final text with no
 * throttle lag.
 */
function useThrottledStreamText(
  value: string,
  active: boolean,
  intervalMs: number,
) {
  const [display, setDisplay] = useState(value);
  const latestRef = useRef(value);
  const timerRef = useRef<number | null>(null);
  const lastFlushRef = useRef(0);
  latestRef.current = value;

  useEffect(() => {
    if (!active) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      lastFlushRef.current = Date.now();
      setDisplay(value);
      return;
    }

    const now = Date.now();
    const elapsed = now - lastFlushRef.current;
    if (elapsed >= intervalMs) {
      lastFlushRef.current = now;
      setDisplay(value);
    } else if (timerRef.current === null) {
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        lastFlushRef.current = Date.now();
        setDisplay(latestRef.current);
      }, intervalMs - elapsed);
    }
  }, [value, active, intervalMs]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  return display;
}

// Memoized so unrelated re-renders (e.g. composer keystrokes bubbling
// through DeckConsole) don't force every historical message to re-parse its
// markdown — only turns whose own props actually changed re-render.
const AssistantTurn = memo(function AssistantTurn({
  content,
  streaming,
}: {
  content: string;
  streaming?: boolean;
}) {
  // Throttle the markdown re-parse cadence while this turn is actively
  // streaming; historical/finished turns (streaming falsy) always render
  // `content` immediately and in full.
  const displayContent = useThrottledStreamText(
    content,
    Boolean(streaming),
    STREAM_THROTTLE_MS,
  );
  const rendered = useMemo(
    () => renderMarkdown(displayContent, streaming ? CARET : undefined),
    [displayContent, streaming],
  );
  return (
    <div className="turn turn-assistant">
      <div className="turn-label">
        <span className="turn-dot" aria-hidden />
        STARRA
      </div>
      <div className="md">{rendered}</div>
    </div>
  );
});

const UserTurn = memo(function UserTurn({ content }: { content: string }) {
  return (
    <div className="turn turn-user">
      <div className="turn-label">YOU</div>
      <div className="bubble-user">{content}</div>
    </div>
  );
});

const MessageTurn = memo(function MessageTurn({ role, content }: Msg) {
  return role === "user" ? (
    <UserTurn content={content} />
  ) : (
    <AssistantTurn content={content} />
  );
});

export const MessageColumn = memo(
  forwardRef<
    HTMLDivElement,
    {
      history: Msg[];
      streaming: string;
      /** shown as a resting STARRA turn when the conversation is empty */
      resting: string;
    }
  >(function MessageColumn({ history, streaming, resting }, ref) {
    const empty = history.length === 0 && !streaming;

    return (
      <div className="chat-log" ref={ref}>
        <div className="msg-col">
          {empty ? <AssistantTurn content={resting} /> : null}
          {history.map((m, i) => (
            <MessageTurn key={`${m.role}-${i}`} role={m.role} content={m.content} />
          ))}
          {streaming ? (
            <AssistantTurn content={streaming} streaming />
          ) : null}
        </div>
      </div>
    );
  }),
);
