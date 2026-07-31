/**
 * FLIP RADAR store — SQLite-backed (the deck's first migrated store; the
 * pattern for the rest). Same exported API as the JSON version, so the route
 * and panel are untouched. Data lives in flip_entries + meta (data/stargate.db,
 * WAL, operator-scoped — see lib/db.ts for the access policy).
 *
 * Writes are TRANSACTIONS now (BEGIN/COMMIT), which is what the old
 * serialized-chain discipline was approximating. Re-scans still never regress
 * operator status: upsert refreshes the listed MRR only, and a verdict can
 * only fill in where none exists.
 *
 * MIGRATION: on first read, if the table is empty and the legacy
 * data/flipradar.json exists, its entries are imported once.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { getDb, CURRENT_OPERATOR } from "@/lib/db";
import type { FlipCandidate, FlipVerdict } from "./scan";

export type FlipStatus = "new" | "approved" | "passed" | "building";

export type RadarEntry = FlipCandidate & {
  verdict: FlipVerdict | null;
  status: FlipStatus;
  seenAt: string;
  updatedAt: string;
};

export type RadarStore = {
  entries: RadarEntry[];
  lastScanAt: string | null;
};

type Row = {
  id: string;
  name: string;
  url: string;
  mrr: number;
  source: string;
  verdict: string | null;
  status: string;
  seenAt: string;
  updatedAt: string;
};

function rowToEntry(r: Row): RadarEntry {
  let verdict: FlipVerdict | null = null;
  if (r.verdict) {
    try {
      verdict = JSON.parse(r.verdict) as FlipVerdict;
    } catch {
      verdict = null;
    }
  }
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    mrr: r.mrr,
    source: r.source as FlipCandidate["source"],
    verdict,
    status: r.status as FlipStatus,
    seenAt: r.seenAt,
    updatedAt: r.updatedAt,
  };
}

let legacyImportDone = false;

/** One-time import of the legacy JSON store into an empty table. */
async function importLegacyOnce(): Promise<void> {
  if (legacyImportDone) return;
  legacyImportDone = true;
  try {
    const d = getDb();
    const count = d
      .prepare("SELECT COUNT(*) AS n FROM flip_entries WHERE operator = ?")
      .get(CURRENT_OPERATOR) as { n: number };
    if (count.n > 0) return;
    const raw = await fs.readFile(
      path.join(process.cwd(), "data", "flipradar.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as Partial<RadarStore>;
    if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) return;
    d.exec("BEGIN");
    try {
      const ins = d.prepare(
        `INSERT OR IGNORE INTO flip_entries
           (id, operator, name, url, mrr, source, verdict, status, seenAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of parsed.entries) {
        ins.run(
          e.id,
          CURRENT_OPERATOR,
          e.name,
          e.url,
          e.mrr,
          e.source,
          e.verdict ? JSON.stringify(e.verdict) : null,
          e.status,
          e.seenAt,
          e.updatedAt,
        );
      }
      if (typeof parsed.lastScanAt === "string") {
        d.prepare(
          "INSERT OR REPLACE INTO meta (k, operator, v) VALUES ('flip_lastScanAt', ?, ?)",
        ).run(CURRENT_OPERATOR, parsed.lastScanAt);
      }
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  } catch {
    /* no legacy file or unreadable — nothing to import */
  }
}

export async function getRadar(): Promise<RadarStore> {
  try {
    await importLegacyOnce();
    const d = getDb();
    const rows = d
      .prepare(
        "SELECT id, name, url, mrr, source, verdict, status, seenAt, updatedAt FROM flip_entries WHERE operator = ? ORDER BY seenAt DESC LIMIT 100",
      )
      .all(CURRENT_OPERATOR) as Row[];
    const meta = d
      .prepare("SELECT v FROM meta WHERE k = 'flip_lastScanAt' AND operator = ?")
      .get(CURRENT_OPERATOR) as { v: string | null } | undefined;
    return { entries: rows.map(rowToEntry), lastScanAt: meta?.v ?? null };
  } catch {
    return { entries: [], lastScanAt: null }; // fail-open: empty radar, never a 500
  }
}

/**
 * Fold a scan in, transactionally. NEW ids insert as status "new"; known ids
 * refresh mrr/updatedAt only — status and an existing verdict NEVER regress
 * from a re-scan (operator truth outranks scans).
 */
export async function upsertScan(
  candidates: FlipCandidate[],
  verdicts: Map<string, FlipVerdict | null>,
  now: string,
): Promise<RadarStore> {
  await importLegacyOnce();
  const d = getDb();
  d.exec("BEGIN");
  try {
    const up = d.prepare(
      `INSERT INTO flip_entries
         (id, operator, name, url, mrr, source, verdict, status, seenAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         mrr = excluded.mrr,
         updatedAt = excluded.updatedAt,
         verdict = COALESCE(flip_entries.verdict, excluded.verdict)`,
    );
    for (const c of candidates) {
      const v = verdicts.get(c.id);
      up.run(
        c.id,
        CURRENT_OPERATOR,
        c.name,
        c.url,
        c.mrr,
        c.source,
        v ? JSON.stringify(v) : null,
        now,
        now,
      );
    }
    d.prepare(
      "INSERT OR REPLACE INTO meta (k, operator, v) VALUES ('flip_lastScanAt', ?, ?)",
    ).run(CURRENT_OPERATOR, now);
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return getRadar();
}

export async function setStatus(
  id: string,
  status: FlipStatus,
  now: string,
): Promise<RadarStore | null> {
  await importLegacyOnce();
  const d = getDb();
  const res = d
    .prepare(
      "UPDATE flip_entries SET status = ?, updatedAt = ? WHERE id = ? AND operator = ?",
    )
    .run(status, now, id, CURRENT_OPERATOR);
  if (res.changes === 0) return null;
  return getRadar();
}
