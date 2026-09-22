"use client";

import { useCallback, useRef, useState } from "react";
import {
  checkDroppedFile,
  fmtBytes,
  ingestedLabel,
  uploadFailure,
} from "@/lib/vault/drop";

/**
 * Drop box in the operator console: drag files onto it (or click to browse) and
 * they go into her vault, which the next chat turn already reads.
 *
 * ★ IT REUSES `/api/vault/upload`. That route already caps the body, ingests
 * text/md/csv/pdf, redacts, extracts facts and writes the raw file to disk
 * (src/lib/vault/store.ts:61). `/api/chat` already pulls the vault into the
 * prompt (`getVault()` in its opening Promise.all). So nothing new had to be
 * built on the server for a dropped file to be something she can answer from —
 * and no second ingest path exists to drift from the first.
 *
 * ★ ALL STATE IS LOCAL, ON PURPOSE. This sits inside `.composer-dock` next to
 * the composer. If its rows lived in DeckConsole, an upload would re-render the
 * console — the exact coupling that made typing cost a full subtree render. It
 * renders when a file moves and at no other time.
 *
 * ★ DRAGLEAVE IS COUNTED, NOT TOGGLED. dragleave fires when the pointer crosses
 * into a CHILD element, so a plain `setArmed(false)` makes the highlight flicker
 * off while the file is still over the box. The depth counter is the fix.
 */

type Row = {
  key: string;
  name: string;
  size: number;
  state: "busy" | "done" | "fail";
  detail: string;
};

/** Enough to read a batch back without the dock growing without bound. */
const MAX_ROWS = 6;

export function ConsoleDrop() {
  const [armed, setArmed] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const depth = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const patch = useCallback((key: string, next: Partial<Row>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...next } : r)));
  }, []);

  const ingest = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const fresh: Row[] = files.map((f) => ({
        key: `drop-${seq.current++}`,
        name: f.name,
        size: f.size,
        state: "busy",
        detail: "READING",
      }));
      setRows((prev) => [...fresh, ...prev].slice(0, MAX_ROWS));

      // Sequential, not Promise.all: the route writes the vault file and saves
      // the whole store on each call (store.ts unshift + saveVault), so two
      // concurrent ingests race the same JSON. One at a time is also why the
      // rows settle in the order he dropped them.
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const row = fresh[i];

        const verdict = checkDroppedFile(file);
        if (!verdict.ok) {
          patch(row.key, { state: "fail", detail: verdict.why });
          continue;
        }

        try {
          const fd = new FormData();
          fd.append("file", file);
          const res = await fetch("/api/vault/upload", { method: "POST", body: fd });
          if (!res.ok) {
            const body = await res.json().catch(() => null);
            patch(row.key, { state: "fail", detail: uploadFailure(res.status, body) });
            continue;
          }
          const doc = (await res.json()) as { facts?: unknown[]; text?: string };
          patch(row.key, { state: "done", detail: ingestedLabel(doc) });
        } catch {
          patch(row.key, { state: "fail", detail: "the deck didn't answer — is it still up?" });
        }
      }
    },
    [patch],
  );

  return (
    <div
      className={`drop-zone${armed ? " armed" : ""}`}
      onDragEnter={(e) => {
        e.preventDefault();
        depth.current += 1;
        setArmed(true);
      }}
      onDragOver={(e) => {
        e.preventDefault(); // without this the browser navigates to the file
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        e.preventDefault();
        depth.current -= 1;
        if (depth.current <= 0) {
          depth.current = 0;
          setArmed(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        depth.current = 0;
        setArmed(false);
        void ingest(Array.from(e.dataTransfer.files));
      }}
    >
      <button
        type="button"
        className="drop-cta"
        onClick={() => inputRef.current?.click()}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M12 16V4" />
          <path d="M7 9l5-5 5 5" />
          <path d="M4 16v3a1 1 0 001 1h14a1 1 0 001-1v-3" />
        </svg>
        <span>{armed ? "RELEASE TO INGEST" : "DROP FILES — PDF · MD · TXT · CSV · CODE"}</span>
      </button>

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void ingest(Array.from(e.target.files ?? []));
          e.target.value = ""; // so dropping the same file twice fires again
        }}
      />

      {rows.length > 0 ? (
        <ul className="drop-rows">
          {rows.map((r) => (
            <li key={r.key} className={`drop-row ${r.state}`}>
              <span className="drop-name" title={r.name}>{r.name}</span>
              <span className="drop-size">{fmtBytes(r.size)}</span>
              <span className="drop-detail">{r.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
