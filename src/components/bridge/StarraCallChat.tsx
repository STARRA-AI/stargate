"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

  const liveU = liveUser?.trim() ? liveUser : "";
  const liveA = liveAssistant?.trim() ? liveAssistant : "";
  const isEmpty = messages.length === 0 && !liveU && !liveA;

  // Auto-scroll to newest whenever committed or live content changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, liveU, liveA]);

  const transcript = messages
    .map((m) => `${m.role === "user" ? "You" : "STARRA"}: ${m.text}`)
    .join("\n");

  return (
    <div className={styles.chat}>
      <div className={styles.header}>
        <span className={styles.headerLabel}>TRANSCRIPT</span>
        {messages.length > 0 ? (
          <CopyButton
            value={transcript}
            label="Copy the whole transcript"
            className={styles.copyAll}
            copiedClassName={styles.copyAllCopied}
            idleText="Copy all"
          />
        ) : null}
      </div>

      <div className={styles.list} ref={scrollRef}>
        {isEmpty ? (
          <p className={styles.empty}>Your conversation will show here.</p>
        ) : null}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={`u-${i}`} className={styles.userTurn}>
              <span className={styles.roleLabel}>YOU</span>
              <div className={styles.userText}>{m.text}</div>
            </div>
          ) : (
            <div key={`a-${i}`} className={styles.assistantTurn}>
              <span className={styles.roleLabel}>STARRA</span>
              <div className={styles.assistantText}>{m.text}</div>
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
                <div className={styles.assistantText}>{liveA}</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {onSend ? (
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
