"use client";

/**
 * ROUTINES TABLE (G11). Renders Agent B's three scheduled routines
 * (SHARED CONTRACT §8) — file lives under components/bridge per this
 * worker's file ownership, but it mounts on the settings page, so it
 * follows settings' Tailwind-utility idiom (see settings/page.tsx's
 * WakeWordToggle) rather than the deck.css panel classes used elsewhere in
 * bridge/.
 *
 * Fetches GET /api/routines, toggles a single routine via
 * PUT /api/routines {id, enabled}. All three read disabled until Classic
 * turns one on — nothing here auto-enables anything, and lastResult is
 * rendered exactly as the API reports it (including a skip note, e.g.
 * morning-brief-prep noting no Gmail bridge exists).
 */
import { useCallback, useEffect, useState } from "react";

type RoutineId = "nightly-distill" | "morning-brief-prep" | "weekly-ops-report";

type Routine = {
  id: RoutineId;
  label: string;
  schedule: string;
  enabled: boolean;
  lastRun: string | null;
  lastResult: string | null;
};

export function RoutinesTable() {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<RoutineId | null>(null);

  const load = useCallback(() => {
    fetch("/api/routines")
      .then((r) => r.json())
      .then((d: { routines?: Routine[] }) => {
        setRoutines(d.routines ?? []);
        setError(false);
      })
      .catch(() => setError(true));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggle(r: Routine) {
    setPending(r.id);
    try {
      const res = await fetch("/api/routines", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: r.id, enabled: !r.enabled }),
      });
      if (res.ok) {
        const d = (await res.json()) as { routines?: Routine[] };
        setRoutines(d.routines ?? []);
      }
    } catch {
      /* leave state as-is — a manual retry or the next load() recovers */
    } finally {
      setPending(null);
    }
  }

  return (
    <section id="routines" className="panel-etch space-y-3 p-4 md:col-span-2">
      <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
        Routines
      </h2>
      <p className="font-[family-name:var(--font-body)] text-[11px] text-[var(--star)]">
        Scheduled agent runs. Each stays OFF until you switch it on — nothing
        here runs unattended by default.
      </p>
      {error ? (
        <p className="font-[family-name:var(--font-mono)] text-xs text-[var(--danger)]">
          LINK DEGRADED. RETRY?
        </p>
      ) : !routines ? (
        <p className="font-[family-name:var(--font-mono)] text-xs text-[var(--star)]">
          PROCESSING
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-[10px] tracking-widest text-[var(--star)] uppercase">
                <th className="py-2 pr-3">Routine</th>
                <th className="py-2 pr-3">Schedule</th>
                <th className="py-2 pr-3">Last run</th>
                <th className="py-2 pr-3">Last result</th>
                <th className="py-2 pr-3">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {routines.map((r) => (
                <tr key={r.id} className="border-b border-[var(--border)] align-top">
                  <td className="py-2 pr-3">{r.label}</td>
                  <td className="py-2 pr-3 text-[var(--star)]">{r.schedule}</td>
                  <td className="py-2 pr-3 text-[var(--star)]">{r.lastRun ?? "never"}</td>
                  <td className="py-2 pr-3 text-[var(--star)]">{r.lastResult ?? "—"}</td>
                  <td className="py-2 pr-3">
                    <button
                      type="button"
                      onClick={() => void toggle(r)}
                      disabled={pending === r.id}
                      aria-pressed={r.enabled}
                      aria-label={`${r.label} — ${r.enabled ? "enabled, tap to disable" : "disabled, tap to enable"}`}
                      className="focus-magenta border border-[var(--border)] px-3 py-1 text-[10px] tracking-widest uppercase text-[var(--chrome)] disabled:opacity-50"
                    >
                      {r.enabled ? "ON" : "OFF"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
