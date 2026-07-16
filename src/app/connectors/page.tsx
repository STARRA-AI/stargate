"use client";

import { ScreenShell } from "@/components/hud/ScreenShell";
import { useStargate } from "@/lib/stargate-context";

export default function ConnectorsPage() {
  const { connectors } = useStargate();

  return (
    <ScreenShell title="Connectors">
      <p className="mb-4 font-[family-name:var(--font-mono)] text-xs text-[var(--star)]">
        OAuth wires when keys are present. Tiles stay available until then.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {connectors.map((c) => (
          <article key={c.id} className="panel-etch flex items-center justify-between p-4">
            <div>
              <h2 className="font-[family-name:var(--font-display)] text-sm tracking-[0.2em] text-[var(--chrome)] uppercase">
                {c.name}
              </h2>
              <p className="mt-1 font-[family-name:var(--font-mono)] text-[11px] tracking-widest text-[var(--star)] uppercase">
                {c.status === "connected"
                  ? "● connected"
                  : c.status === "error"
                    ? "◆ error — reauth"
                    : "○ available"}
              </p>
            </div>
            <button
              type="button"
              disabled
              className="border border-[var(--border)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.2em] text-[var(--star)] uppercase opacity-60"
            >
              Connect
            </button>
          </article>
        ))}
      </div>
    </ScreenShell>
  );
}
