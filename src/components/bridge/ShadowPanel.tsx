"use client";

/**
 * SILENT SHADOW panel — content-engine queue visibility on the deck.
 * Counts for ready/uploaded/failed plus the failed filenames (the actionable
 * ones). Read-only v1: publishing stays with the existing pipeline; this makes
 * the volume machine VISIBLE so it actually gets run. Best-effort: any fetch
 * failure renders zeros, never breaks the deck.
 */
import { useEffect, useState } from "react";

type Q = { count: number; files: { name: string; at: string }[] };
type Report = { ready: Q; uploaded: Q; failed: Q };

const EMPTY: Report = {
  ready: { count: 0, files: [] },
  uploaded: { count: 0, files: [] },
  failed: { count: 0, files: [] },
};

export function ShadowPanel() {
  const [report, setReport] = useState<Report>(EMPTY);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      fetch("/api/tools/shadow")
        .then((r) => (r.ok ? r.json() : null))
        .then((j: Report | null) => {
          if (!cancelled && j && j.ready && j.uploaded && j.failed) setReport(j);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div className="panel" id="panel-shadow">
      <div className="panel-head">
        <span className="dot" />
        <span className="panel-title">SILENT SHADOW</span>
        <div className="spacer" />
        <span className="panel-tag">{report.failed.count > 0 ? "ATTN" : "OK"}</span>
      </div>
      <div className="snap-metrics">
        <div className="snap-metric">
          <span className="snap-label">READY</span>
          <span className="snap-value">{String(report.ready.count).padStart(2, "0")}</span>
        </div>
        <div className="snap-metric">
          <span className="snap-label">UPLOADED</span>
          <span className="snap-value">{String(report.uploaded.count).padStart(2, "0")}</span>
        </div>
        <div className="snap-metric">
          <span className="snap-label">FAILED</span>
          <span className="snap-value">{String(report.failed.count).padStart(2, "0")}</span>
        </div>
      </div>
      {report.failed.files.length > 0 ? (
        <div className="shadow-failed">
          {report.failed.files.slice(0, 4).map((f) => (
            <p className="shadow-failed-line" key={f.name}>
              ✕ {f.name}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
