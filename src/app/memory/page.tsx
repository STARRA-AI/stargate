"use client";

import { ScreenShell } from "@/components/hud/ScreenShell";
import { useEffect, useState } from "react";

type MemoryPayload = {
  working: { role: string; content: string; at: string }[];
  summaries: string[];
  archival: { id: string; text: string; at: string }[];
};

export default function MemoryPage() {
  const [q, setQ] = useState("");
  const [data, setData] = useState<MemoryPayload | null>(null);

  useEffect(() => {
    const url = q ? `/api/memory?q=${encodeURIComponent(q)}` : "/api/memory";
    fetch(url)
      .then((r) => r.json())
      .then((d: MemoryPayload) => setData(d))
      .catch(() => setData({ working: [], summaries: [], archival: [] }));
  }, [q]);

  return (
    <ScreenShell title="Memory">
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Semantic / keyword search"
        className="focus-magenta panel-etch mb-5 w-full px-3 py-2 font-[family-name:var(--font-mono)] text-sm text-[var(--chrome)] outline-none"
        aria-label="Search memory"
      />
      {!data ? (
        <p className="font-[family-name:var(--font-mono)] text-[var(--star)]">
          PROCESSING
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          <Tier
            title={`Working (${data.working.length})`}
            items={data.working.map(
              (e) => `${e.role.toUpperCase()}: ${e.content}`,
            )}
          />
          <Tier title={`Summary (${data.summaries.length})`} items={data.summaries} />
          <Tier
            title={`Archival (${data.archival.length})`}
            items={data.archival.map((a) => a.text)}
          />
        </div>
      )}
    </ScreenShell>
  );
}

function Tier({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="panel-etch flex flex-col gap-2 p-4">
      <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
        {title}
      </h2>
      <ul className="space-y-2 font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
        {items.length === 0 ? (
          <li className="text-[var(--star)]">EMPTY</li>
        ) : (
          items.map((t, i) => (
            <li key={i} className="border-b border-[var(--border-soft)] pb-2">
              {t}
            </li>
          ))
        )}
      </ul>
    </section>
  );
}
