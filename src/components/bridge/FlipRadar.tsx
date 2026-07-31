"use client";

/**
 * FLIP RADAR panel — the clone-and-flip revenue hunter on the deck.
 *
 * Reads /api/flipradar (TrustMRR listings scored against her five filters),
 * renders the NEW candidates with score + per-filter dots, and gives Classic
 * two buttons: APPROVE (marks approved AND creates a Multica quick task — his
 * click IS the explicit ask, so the agents-only-when-asked rule holds) and
 * PASS. SCAN forces a fresh pull. Styling reuses the deck's existing panel /
 * btn-approve / btn-later vocabulary — no new design language.
 */
import { useCallback, useEffect, useState } from "react";

type Verdict = {
  score: number;
  filters: Record<string, boolean>;
  note: string;
};
type Entry = {
  id: string;
  name: string;
  url: string;
  mrr: number;
  status: "new" | "approved" | "passed" | "building";
  verdict: Verdict | null;
};
type Radar = { entries: Entry[]; lastScanAt: string | null };

const FILTER_ORDER = ["diligent", "value", "divineRight", "cost", "mission"] as const;
const FILTER_SHORT: Record<(typeof FILTER_ORDER)[number], string> = {
  diligent: "STEADY",
  value: "VALUE",
  divineRight: "RIGHT",
  cost: "COST",
  mission: "MISSION",
};

export function FlipRadar() {
  const [radar, setRadar] = useState<Radar>({ entries: [], lastScanAt: null });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/flipradar");
      if (r.ok) setRadar((await r.json()) as Radar);
    } catch {
      /* panel is best-effort; the deck never breaks on it */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scan = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/flipradar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "scan", force: true }),
      });
      if (r.ok) setRadar((await r.json()) as Radar);
    } catch {
      /* source down — keep what we have */
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const decide = useCallback(
    async (entry: Entry, status: "approved" | "passed") => {
      try {
        const r = await fetch("/api/flipradar", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: entry.id, status }),
        });
        if (r.ok) setRadar((await r.json()) as Radar);
        if (status === "approved") {
          // Classic's click is the explicit ask — spin up the build task.
          void fetch("/api/tools/multica", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "quick",
              title: `FLIP BUILD: ${entry.name} — our own take on a proven $${entry.mrr.toLocaleString("en-US")}/mo need (${entry.url})`,
            }),
          }).catch(() => {});
        }
      } catch {
        /* decision failed — entry stays visible for a retry */
      }
    },
    [],
  );

  const fresh = radar.entries.filter((e) => e.status === "new");
  const approved = radar.entries.filter(
    (e) => e.status === "approved" || e.status === "building",
  ).length;

  return (
    <div className="panel" id="panel-flipradar">
      <div className="panel-head">
        <span className="dot" />
        <span className="panel-title">FLIP RADAR</span>
        <div className="spacer" />
        <button
          type="button"
          className="panel-tag"
          onClick={() => void scan()}
          disabled={busy}
        >
          {busy ? "SCANNING…" : "SCAN"}
        </button>
      </div>
      <div className="flipradar-body">
        {fresh.length === 0 ? (
          <p className="flipradar-empty">
            {radar.lastScanAt
              ? `No new candidates. ${approved} in build pipeline.`
              : "No scan yet. Hit SCAN to hunt."}
          </p>
        ) : (
          fresh.slice(0, 5).map((e) => (
            <div className="flipradar-row" key={e.id}>
              <div className="flipradar-main">
                <a href={e.url} target="_blank" rel="noreferrer" className="flipradar-name">
                  {e.name}
                </a>
                <span className="flipradar-mrr">
                  ${e.mrr.toLocaleString("en-US")}/mo
                </span>
                {e.verdict ? (
                  <span className="flipradar-score">{e.verdict.score}</span>
                ) : null}
              </div>
              {e.verdict ? (
                <div className="flipradar-filters">
                  {FILTER_ORDER.map((f) => (
                    <span
                      key={f}
                      className={`flipradar-filter${e.verdict?.filters[f] ? " pass" : " fail"}`}
                      title={FILTER_SHORT[f]}
                    >
                      {FILTER_SHORT[f]}
                    </span>
                  ))}
                </div>
              ) : null}
              {e.verdict?.note ? (
                <p className="flipradar-note">{e.verdict.note}</p>
              ) : null}
              <div className="flipradar-actions">
                <button
                  type="button"
                  className="btn-approve"
                  onClick={() => void decide(e, "approved")}
                >
                  APPROVE
                </button>
                <button
                  type="button"
                  className="btn-later"
                  onClick={() => void decide(e, "passed")}
                >
                  PASS
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
