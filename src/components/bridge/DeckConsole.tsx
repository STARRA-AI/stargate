"use client";

import { CHIPS } from "@/lib/deck-demo";
import { useStargate, useStargateStream } from "@/lib/stargate-context";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Composer } from "./Composer";
import { ConsoleDrop } from "./ConsoleDrop";
import { MessageColumn } from "./MessageColumn";

/** Head waveform bar count — 14 spans, each with its own animation duration. */
const WAVE_BARS = 14;

export function DeckConsole({
  onCall,
  callActive,
}: {
  onCall?: () => void;
  callActive?: boolean;
}) {
  // Split on purpose: hudState/lastReply come from the main context (stable
  // outside of real HUD transitions); history/streaming/sendMessage come
  // from the stream-only context, which updates on every SSE token. Only
  // this component (and its MessageColumn child) should feel that churn —
  // see stargate-context.tsx for why.
  const { hudState, lastReply } = useStargate();
  const { history, streaming, sendMessage } = useStargateStream();
  const logRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);
  const userScrolledRef = useRef(false);
  // ★ THE FIRST SCROLL IS UNCONDITIONAL (2026-09-30). On first paint scrollTop
  // is 0 and the column is taller than the box, so the proximity check below
  // was false and the deck opened on the OLDEST messages — he typed, she
  // answered, and the reply landed below the fold with nothing moving.
  const didInitialScrollRef = useRef(false);

  // ★ THE DRAFT TEXT IS NOT HELD HERE (2026-09-22). It used to be
  // `useState("")` passed down as Composer's `value`, so every character typed
  // re-rendered this component: the head, WAVE_BARS spans each with a fresh
  // inline style object, the whole chip row, and Composer. MessageColumn was
  // already safe (it is `memo`'d, and its props did not change), but nothing
  // else was. Composer owns its own uncontrolled textarea now and hands the
  // text up once, at submit — see the header comment there before changing it
  // back to a controlled input.

  // Track user scroll position to avoid yanking them back to bottom
  useEffect(() => {
    const el = logRef.current;
    if (!el) return;

    const onScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      // Within 50px of bottom = still following along
      userScrolledRef.current = scrollHeight - scrollTop - clientHeight > 50;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  // Smart auto-scroll: only if user hasn't scrolled up, batched via RAF
  useEffect(() => {
    if (userScrolledRef.current) return; // user is reading history
    if (scrollRafRef.current !== null) return; // already queued

    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = logRef.current;
      if (!el) return;
      // FIRST TIME: go to the bottom whatever the measurement says.
      if (!didInitialScrollRef.current) {
        didInitialScrollRef.current = true;
        el.scrollTo({ top: el.scrollHeight });
        return;
      }
      // Afterwards, userScrolledRef (set from a real scroll event, above) is
      // already the answer. The re-measurement that used to sit here fought it:
      // it ran at the one moment new content had just changed scrollHeight, so
      // a reply longer than 50px read as "he scrolled away" and the log froze.
      el.scrollTo({ top: el.scrollHeight });
    });
  }, [history, streaming]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current);
      }
    };
  }, []);

  const submit = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      // Reset scroll tracking on new message - user wants to see the reply
      userScrolledRef.current = false;
      void sendMessage(text);
    },
    [sendMessage],
  );

  const waveLive =
    hudState === "listening" ||
    hudState === "wake" ||
    hudState === "speaking" ||
    hudState === "streaming" ||
    hudState === "thinking";

  // Rebuilt only when the wave actually changes state. `streaming` updates on
  // every SSE token, which re-renders this component many times a second while
  // she replies; without this the 14 spans and their inline style objects were
  // re-created on each token for a bar array that had not changed.
  const waveBars = useMemo(
    () => (
      <div className="wave-bars" aria-hidden>
        {Array.from({ length: WAVE_BARS }).map((_, i) => (
          <span
            key={i}
            className={`wave-bar${waveLive ? " live speaking" : ""}`}
            style={
              waveLive ? { animationDuration: `${0.4 + (i % 5) * 0.12}s` } : undefined
            }
          />
        ))}
      </div>
    ),
    [waveLive],
  );

  // CHIPS is a module constant and `submit` is stable, so this is built once.
  const chipRow = useMemo(
    () => (
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
    ),
    [submit],
  );

  const standingBy = "STANDING BY. ASK FOR THE BRIEF.";

  return (
    <div className="console">
      <div className="console-head">
        <span className="panel-title">OPERATOR CONSOLE</span>
        <div className="spacer" />
        {waveBars}
      </div>

      <MessageColumn
        ref={logRef}
        history={history}
        streaming={streaming}
        resting={lastReply || standingBy}
      />

      <div className="composer-dock">
        {chipRow}
        <ConsoleDrop />
        <Composer
          onSubmit={submit}
          onCall={onCall}
          recording={callActive}
          placeholder='> "GIVE ME THE BRIEF."'
        />
      </div>
    </div>
  );
}
