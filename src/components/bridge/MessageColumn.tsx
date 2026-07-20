"use client";

import { forwardRef, memo, useMemo } from "react";
import { renderMarkdown } from "@/lib/markdown";

export type Msg = { role: "user" | "assistant"; content: string };

/** Blinking magenta streaming caret. Steadied under reduced-motion via CSS. */
const CARET = <span className="stream-caret" aria-hidden />;

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
  const rendered = useMemo(
    () => renderMarkdown(content, streaming ? CARET : undefined),
    [content, streaming],
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
