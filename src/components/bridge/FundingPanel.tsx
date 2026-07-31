"use client";

/**
 * FUNDING panel — the backyard-banks pipeline on the deck. Shows status
 * counts and the next actionable leads; NEXT advances a lead one stage
 * (lead → prequal → applied → funded), DEAD retires it. Every row is a lead
 * to verify, per the playbook — the deck just makes the pipeline impossible
 * to forget. Best-effort fetches; the deck never breaks on this panel.
 */
import { useCallback, useEffect, useState } from "react";

type Status = "lead" | "prequal" | "applied" | "funded" | "dead";
type Lead = { id: string; institution: string; intel: string; status: Status };
type Store = { leads: Lead[] };

const NEXT: Record<Status, Status> = {
  lead: "prequal",
  prequal: "applied",
  applied: "funded",
  funded: "funded",
  dead: "dead",
};
const ORDER: Status[] = ["applied", "prequal", "lead"];

export function FundingPanel() {
  const [leads, setLeads] = useState<Lead[]>([]);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/funding");
      if (r.ok) setLeads(((await r.json()) as Store).leads ?? []);
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const move = useCallback(async (id: string, status: Status) => {
    try {
      const r = await fetch("/api/funding", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, status }),
      });
      if (r.ok) setLeads(((await r.json()) as Store).leads ?? []);
    } catch {
      /* row stays for retry */
    }
  }, []);

  const funded = leads.filter((l) => l.status === "funded").length;
  const active = ORDER.flatMap((s) => leads.filter((l) => l.status === s));

  return (
    <div className="panel" id="panel-funding">
      <div className="panel-head">
        <span className="dot" />
        <span className="panel-title">FUNDING PIPELINE</span>
        <div className="spacer" />
        <span className="panel-tag">
          {funded > 0 ? `${funded} FUNDED` : `${active.length} LIVE`}
        </span>
      </div>
      <div className="funding-body">
        {active.length === 0 ? (
          <p className="flipradar-empty">Pipeline clear.</p>
        ) : (
          active.slice(0, 4).map((l) => (
            <div className="funding-row" key={l.id}>
              <div className="funding-main">
                <span className={`funding-status funding-${l.status}`}>
                  {l.status.toUpperCase()}
                </span>
                <span className="funding-name" title={l.intel}>
                  {l.institution}
                </span>
              </div>
              <div className="flipradar-actions">
                <button
                  type="button"
                  className="btn-approve"
                  onClick={() => void move(l.id, NEXT[l.status])}
                >
                  NEXT
                </button>
                <button
                  type="button"
                  className="btn-later"
                  onClick={() => void move(l.id, "dead")}
                >
                  DEAD
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
