"use client";

import { ScreenShell } from "@/components/hud/ScreenShell";
import { useEffect, useState, type FormEvent } from "react";

type Doc = {
  id: string;
  name: string;
  facts: string[];
  text: string;
  at: string;
};

export default function VaultPage() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [active, setActive] = useState<Doc | null>(null);
  const [status, setStatus] = useState("");

  async function refresh() {
    try {
      const res = await fetch("/api/vault/upload");
      if (!res.ok) {
        setDocs([]);
        return;
      }
      const data = (await res.json()) as { docs?: Doc[] };
      setDocs(data.docs ?? []);
    } catch {
      setDocs([]);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onUpload(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setStatus("INGESTING");
    try {
      const res = await fetch("/api/vault/upload", { method: "POST", body: fd });
      if (!res.ok) {
        setStatus("LINK DEGRADED. RETRY?");
        return;
      }
      setStatus("FACTS STORED");
      form.reset();
      await refresh();
    } catch {
      setStatus("LINK DEGRADED. RETRY?");
    }
  }

  return (
    <ScreenShell title="Vault">
      <form onSubmit={onUpload} className="panel-etch mb-5 flex flex-wrap items-center gap-3 p-4">
        <input
          type="file"
          name="file"
          accept=".pdf,.md,.txt,.docx,.xlsx,text/*"
          required
          className="font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]"
        />
        <button
          type="submit"
          className="focus-magenta border border-[var(--purple)] px-4 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] text-[var(--chrome)] uppercase"
        >
          Upload
        </button>
        {status && (
          <span className="font-[family-name:var(--font-mono)] text-xs text-[var(--magenta)]">
            {status}
          </span>
        )}
      </form>

      <div className="grid gap-4 md:grid-cols-2">
        <ul className="space-y-2">
          {docs.length === 0 ? (
            <li className="font-[family-name:var(--font-mono)] text-[var(--star)]">
              NO DOCS
            </li>
          ) : (
            docs.map((d) => (
              <li key={d.id}>
                <button
                  type="button"
                  onClick={() => setActive(d)}
                  className="panel-etch focus-magenta w-full p-3 text-left"
                >
                  <p className="font-[family-name:var(--font-body)] font-semibold text-[var(--chrome)]">
                    {d.name}
                  </p>
                  <p className="mt-1 font-[family-name:var(--font-mono)] text-[10px] text-[var(--star)]">
                    {d.facts.length} facts · {new Date(d.at).toLocaleString()}
                  </p>
                </button>
              </li>
            ))
          )}
        </ul>

        <article className="panel-etch p-4">
          {!active ? (
            <p className="font-[family-name:var(--font-mono)] text-[var(--star)]">
              SELECT A DOC
            </p>
          ) : (
            <>
              <h2 className="font-[family-name:var(--font-display)] text-sm tracking-[0.2em] text-[var(--chrome)] uppercase">
                {active.name}
              </h2>
              <h3 className="mt-4 font-[family-name:var(--font-display)] text-[10px] tracking-[0.28em] text-[var(--magenta)] uppercase">
                Facts
              </h3>
              <ul className="mt-2 space-y-2 font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
                {active.facts.map((f, i) => (
                  <li key={i}>◆ {f}</li>
                ))}
              </ul>
              <h3 className="mt-4 font-[family-name:var(--font-display)] text-[10px] tracking-[0.28em] text-[var(--star)] uppercase">
                Reader
              </h3>
              <pre className="mt-2 max-h-80 overflow-auto font-[family-name:var(--font-prose)] text-sm whitespace-pre-wrap text-[var(--chrome)]">
                {active.text.slice(0, 8000)}
              </pre>
            </>
          )}
        </article>
      </div>
    </ScreenShell>
  );
}
