"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { renderMarkdown } from "@/lib/markdown";
import type { CallLogSession } from "@/lib/memory/call-log";
import styles from "./StarraCallChat.module.css";

/** How long the "Copied" acknowledgement stays lit on a copy control (ms). */
const COPIED_MS = 1200;

/** Write `text` to the clipboard, swallowing rejections (permission/insecure
 * context). Returns whether the write is believed to have succeeded. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A small copy control that flashes a "Copied" state on success. */
function CopyButton({
  value,
  label,
  className,
  copiedClassName,
  idleText,
}: {
  value: string;
  label: string;
  className: string;
  copiedClassName: string;
  idleText: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onClick = useCallback(async () => {
    const ok = await copyText(value);
    if (!ok) return;
    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, COPIED_MS);
  }, [value]);

  return (
    <button
      type="button"
      className={copied ? `${className} ${copiedClassName}` : className}
      aria-label={copied ? "Copied to clipboard" : label}
      onClick={onClick}
    >
      {copied ? "Copied" : idleText}
    </button>
  );
}

/** Read a picked file for sending. Text-like files return their contents so she
 * can actually read them; anything else returns just a note with the name. */
async function readAttachment(file: File): Promise<string> {
  const textish =
    /^text\//.test(file.type) ||
    /\.(txt|md|markdown|json|csv|log|ts|tsx|js|jsx|py|css|html|yml|yaml)$/i.test(file.name);
  if (textish && file.size <= 200_000) {
    try {
      const body = await file.text();
      return `[attached file: ${file.name}]\n\n${body}`;
    } catch {
      return `[attached file: ${file.name}]`;
    }
  }
  return `[attached file: ${file.name} (${Math.round(file.size / 1024)} KB) — not shown inline]`;
}

/** Human-readable stamp for a past-conversation row. Falls back to the raw
 * string rather than throwing on a malformed timestamp. */
function formatSessionDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** One-line preview of a past conversation for the browse list. */
function sessionPreview(s: CallLogSession): string {
  return s.turns[0]?.text.trim() || "(empty call)";
}

/** Grok-style transcript panel for STARRA's voice call: committed turns plus
 * in-progress partials, with per-reply and whole-transcript copy. When `onSend`
 * is provided it also renders a composer so Classic can type to her and attach
 * files; `busy` disables send while she's replying. */
export function StarraCallChat({
  messages,
  liveUser,
  liveAssistant,
  onSend,
  busy,
}: {
  messages: { role: "user" | "assistant"; text: string }[];
  liveUser?: string | null;
  liveAssistant?: string | null;
  onSend?: (text: string) => void;
  busy?: boolean;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState("");

  // PAST CONVERSATIONS (Bug 3) — browsing old calls never touches the live
  // transcript; it is a read-only overlay on top of the same panel. "live" is
  // the call in progress (default, unchanged behavior); "list" is the fetched
  // session index; "session" is one full session opened read-only.
  const [pastMode, setPastMode] = useState<"live" | "list" | "session">("live");
  const [sessions, setSessions] = useState<CallLogSession[]>([]);
  const [sessionsStatus, setSessionsStatus] = useState<"idle" | "loading" | "error">("idle");
  const [openSession, setOpenSession] = useState<CallLogSession | null>(null);
  const [sessionStatus, setSessionStatus] = useState<"idle" | "loading" | "error">("idle");

  const openPastList = useCallback(async () => {
    setPastMode("list");
    setSessionsStatus("loading");
    try {
      const r = await fetch("/api/calls");
      if (!r.ok) {
        setSessionsStatus("error");
        return;
      }
      const j = (await r.json()) as { sessions?: CallLogSession[] };
      setSessions(Array.isArray(j.sessions) ? j.sessions : []);
      setSessionsStatus("idle");
    } catch {
      setSessionsStatus("error");
    }
  }, []);

  const openPastSession = useCallback(async (id: string) => {
    setPastMode("session");
    setSessionStatus("loading");
    try {
      const r = await fetch(`/api/calls?id=${encodeURIComponent(id)}`);
      if (!r.ok) {
        setSessionStatus("error");
        return;
      }
      const j = (await r.json()) as CallLogSession;
      if (!Array.isArray(j.turns)) {
        setSessionStatus("error");
        return;
      }
      setOpenSession(j);
      setSessionStatus("idle");
    } catch {
      setSessionStatus("error");
    }
  }, []);

  const backToLive = useCallback(() => {
    setPastMode("live");
    setOpenSession(null);
  }, []);

  const submit = useCallback(() => {
    const t = input.trim();
    if (!t || busy || !onSend) return;
    onSend(t);
    setInput("");
  }, [input, busy, onSend]);

  const onPickFile = useCallback(
    async (file: File | undefined) => {
      if (!file || !onSend) return;
      const payload = await readAttachment(file);
      const note = input.trim();
      onSend(note ? `${note}\n\n${payload}` : payload);
      setInput("");
    },
    [input, onSend],
  );

  const liveU = pastMode === "live" && liveUser?.trim() ? liveUser : "";
  const liveA = pastMode === "live" && liveAssistant?.trim() ? liveAssistant : "";
  // In "session" mode the displayed turns are the opened past call, read-only;
  // otherwise (live) they are this call's own messages (Bug 2 — never deck
  // history, see composeCallChatMessages in VoiceCallOverlay.tsx).
  const displayMessages = useMemo(
    () =>
      pastMode === "session"
        ? (openSession?.turns.map((t) => ({ role: t.role, text: t.text })) ?? [])
        : messages,
    [pastMode, openSession, messages],
  );
  const isEmpty = pastMode === "live" && messages.length === 0 && !liveU && !liveA;

  // Auto-scroll: newest row on the live/session transcript; the browse list
  // stays pinned to its top (already newest-first from the API).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = pastMode === "list" ? 0 : el.scrollHeight;
  }, [pastMode, displayMessages, liveU, liveA, sessions]);

  const transcript = displayMessages
    .map((m) => `${m.role === "user" ? "You" : "STARRA"}: ${m.text}`)
    .join("\n");

  return (
    <div className={styles.chat}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>
          {pastMode === "live"
            ? "TRANSCRIPT"
            : pastMode === "list"
              ? "PAST CONVERSATIONS"
              : "PAST CONVERSATION"}
        </span>
        <div className={styles.headerActions}>
          {pastMode === "live" && displayMessages.length > 0 ? (
            <CopyButton
              value={transcript}
              label="Copy the whole transcript"
              className={styles.copyAll}
              copiedClassName={styles.copyAllCopied}
              idleText="Copy all"
            />
          ) : null}
          {pastMode === "live" ? (
            <button
              type="button"
              className={styles.pastToggleBtn}
              onClick={() => void openPastList()}
            >
              Past conversations
            </button>
          ) : (
            <button type="button" className={styles.pastToggleBtn} onClick={backToLive}>
              Back to live call
            </button>
          )}
        </div>
      </div>

      {pastMode === "list" ? (
        <div className={styles.list} ref={scrollRef}>
          {sessionsStatus === "loading" ? (
            <p className={styles.empty}>Loading…</p>
          ) : sessionsStatus === "error" ? (
            <p className={styles.empty}>Couldn&apos;t load past conversations.</p>
          ) : sessions.length === 0 ? (
            <p className={styles.empty}>No past conversations yet.</p>
          ) : (
            sessions.map((s) => (
              <button
                key={s.id}
                type="button"
                className={styles.sessionRow}
                onClick={() => void openPastSession(s.id)}
              >
                <span className={styles.sessionDate}>{formatSessionDate(s.startedAt)}</span>
                <span className={styles.sessionPreview}>{sessionPreview(s)}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div className={styles.list} ref={scrollRef}>
          {isEmpty ? (
            <p className={styles.empty}>Your conversation will show here.</p>
          ) : null}
          {pastMode === "session" && sessionStatus === "loading" ? (
            <p className={styles.empty}>Loading…</p>
          ) : null}
          {pastMode === "session" && sessionStatus === "error" ? (
            <p className={styles.empty}>Couldn&apos;t load this conversation.</p>
          ) : null}

          {displayMessages.map((m, i) =>
            m.role === "user" ? (
              <div key={`u-${i}`} className={styles.userTurn}>
                <span className={styles.roleLabel}>YOU</span>
                <div className={styles.userText}>{m.text}</div>
              </div>
            ) : (
              <div key={`a-${i}`} className={styles.assistantTurn}>
                <span className={styles.roleLabel}>STARRA</span>
                <div className={`${styles.assistantText} ${styles.assistantMd} md`}>
                  {renderMarkdown(m.text)}
                </div>
                <CopyButton
                  value={m.text}
                  label="Copy this message from STARRA"
                  className={styles.copyBtn}
                  copiedClassName={styles.copyBtnCopied}
                  idleText="Copy"
                />
              </div>
            ),
          )}

          {liveU || liveA ? (
            <div className={styles.liveBlock} aria-live="polite">
              {liveU ? (
                <div className={`${styles.userTurn} ${styles.live}`}>
                  <span className={styles.roleLabel}>YOU</span>
                  <div className={styles.userText}>{liveU}</div>
                </div>
              ) : null}
              {liveA ? (
                <div className={`${styles.assistantTurn} ${styles.live}`}>
                  <span className={styles.roleLabel}>STARRA</span>
                  <div className={`${styles.assistantText} ${styles.assistantMd} md`}>
                    {renderMarkdown(liveA)}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      )}

      {pastMode === "live" && onSend ? (
        <form
          className={styles.composer}
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={fileRef}
            type="file"
            hidden
            onChange={(e) => {
              void onPickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className={styles.attachBtn}
            aria-label="Attach a file to send STARRA"
            onClick={() => fileRef.current?.click()}
          >
            +
          </button>
          <textarea
            className={styles.composerInput}
            value={input}
            rows={1}
            placeholder="Type to STARRA…"
            aria-label="Type a message to STARRA"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
          />
          <button
            type="submit"
            className={styles.sendBtn}
            disabled={!input.trim() || busy}
            aria-label="Send"
          >
            {busy ? "…" : "SEND"}
          </button>
        </form>
      ) : null}
    </div>
  );
}
