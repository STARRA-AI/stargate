"use client";

import { useStargate } from "@/lib/stargate-context";
import Link from "next/link";

export function SnapPanel() {
  const { snap } = useStargate();

  return (
    <section className="panel-etch flex flex-col gap-3 p-4">
      <header className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--purple)] shadow-[0_0_8px_var(--magenta)]" />
        <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
          Business Snap
        </h2>
        <Link
          href="/settings"
          className="ml-auto font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--purple)] uppercase"
        >
          Edit
        </Link>
      </header>
      <div className="grid grid-cols-1 gap-2 font-[family-name:var(--font-mono)] text-sm">
        <Row label="MRR" value={snap.mrrLabel} />
        <Row label="TASKS DUE" value={String(snap.tasksDue).padStart(2, "0")} />
        <Row
          label="PIPELINE OPEN"
          value={String(snap.pipelineOpen).padStart(2, "0")}
        />
      </div>
      <header className="mt-2 flex items-center gap-2 border-t border-[var(--border-soft)] pt-3">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--ok)]" />
        <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
          Memory
        </h2>
        <Link
          href="/memory"
          className="ml-auto font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--purple)] uppercase"
        >
          Open
        </Link>
      </header>
      <div className="grid grid-cols-1 gap-1.5 font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
        <Row label="WORKING" value={`${snap.working} msgs`} dim />
        <Row label="SUMMARY" value={`${snap.summaries} sums`} dim />
        <Row label="ARCHIVAL" value={`${snap.archival} arc`} dim />
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  dim,
}: {
  label: string;
  value: string;
  dim?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[10px] tracking-[0.2em] text-[color-mix(in_oklab,var(--chrome)_55%,transparent)] uppercase">
        {label}
      </span>
      <span
        className={
          dim
            ? "text-[var(--star)]"
            : "text-[var(--chrome)] text-base tracking-wide"
        }
      >
        {value}
      </span>
    </div>
  );
}
