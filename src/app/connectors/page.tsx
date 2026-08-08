"use client";

import { ScreenShell } from "@/components/hud/ScreenShell";
import { useStargate } from "@/lib/stargate-context";

export default function ConnectorsPage() {
  const { connectors } = useStargate();

  return (
    <ScreenShell title="Connectors">
      <p className="mb-4 deck-note">
        OAuth wires when keys are present. Tiles stay available until then.
      </p>
      <div className="deck-grid">
        {connectors.map((c) => (
          <article key={c.id} className="deck-panel">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="font-[family-name:var(--font-display)] text-sm tracking-[0.2em] text-[var(--chrome)] uppercase">
                  {c.name}
                </h2>
                <span
                  className={`mt-1 deck-badge ${
                    c.status === "connected"
                      ? "is-ok"
                      : c.status === "error"
                        ? "is-danger"
                        : "is-idle"
                  }`}
                >
                  {c.status === "connected"
                    ? "connected"
                    : c.status === "error"
                      ? "error — reauth"
                      : "available"}
                </span>
              </div>
              <button
                type="button"
                disabled
                className="border border-[var(--border)] px-3 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.2em] text-[var(--star)] uppercase opacity-60"
              >
                Connect
              </button>
            </div>
          </article>
        ))}
      </div>
    </ScreenShell>
  );
}
