"use client";

import { useStargate } from "@/lib/stargate-context";
import Link from "next/link";
import { COPY } from "@/lib/copy";

export function ActionLog() {
  const { actionLog } = useStargate();

  return (
    <section className="panel-etch flex min-h-0 flex-1 flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--magenta)]" />
        <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
          Action Log
        </h2>
      </header>
      <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto font-[family-name:var(--font-mono)] text-xs">
        {actionLog.length === 0 ? (
          <li className="text-[var(--star)]">{COPY.emptyInbox}</li>
        ) : (
          actionLog.map((e) => (
            <li key={e.id} className="flex gap-3 text-[var(--chrome)]">
              <span className="shrink-0 text-[var(--purple)]">{e.time}</span>
              <span className="truncate">{e.text}</span>
            </li>
          ))
        )}
      </ul>
    </section>
  );
}

export function ConnectorsTile() {
  const { connectors } = useStargate();

  const mark = (s: string) =>
    s === "connected" ? "●" : s === "error" ? "◆" : "○";

  return (
    <section className="panel-etch flex flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />
        <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
          Connectors
        </h2>
        <Link
          href="/connectors"
          className="ml-auto font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--purple)] uppercase"
        >
          Manage
        </Link>
      </header>
      <ul className="space-y-1.5 font-[family-name:var(--font-mono)] text-xs">
        {connectors.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between text-[var(--chrome)]"
          >
            <span>
              <span
                className={
                  c.status === "connected"
                    ? "text-[var(--ok)]"
                    : c.status === "error"
                      ? "text-[var(--danger)]"
                      : "text-[var(--star)]"
                }
              >
                {mark(c.status)}
              </span>{" "}
              {c.name}
            </span>
            <span className="tracking-widest text-[color-mix(in_oklab,var(--chrome)_45%,transparent)] uppercase">
              {c.status}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
