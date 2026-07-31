/**
 * STARGATE DATABASE — SQLite via node:sqlite (built into Node 24; zero deps,
 * $0, no daemon). One file: data/stargate.db, WAL mode for crash-safe
 * concurrent reads, 0600 perms.
 *
 * ACCESS POLICY (single-tenant RLS semantics, stated honestly): STARGATE is a
 * one-operator system. Row-level security here is enforced by construction,
 * not by a Postgres policy engine:
 *   1. Every row carries operator = 'classic'; every helper in this module
 *      scopes queries to CURRENT_OPERATOR — no caller can address another
 *      tenant's rows because no other tenant can be expressed.
 *   2. The ONLY paths to this module are server-side API routes, and every
 *      /api/* route sits behind the auth middleware (401 unauthenticated).
 *   3. The DB file itself is chmod 0600 and lives in gitignored data/.
 * True policy-engine RLS (Supabase/Postgres) is a documented later option and
 * requires Classic's account — see docs/PLATFORM.md.
 *
 * Tests point STARGATE_DB_PATH at a temp file to exercise real behavior.
 */
import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";

export const CURRENT_OPERATOR = "classic";

let db: DatabaseSync | null = null;

function dbPath(): string {
  return (
    process.env.STARGATE_DB_PATH ||
    path.join(process.cwd(), "data", "stargate.db")
  );
}

/** Open (once per process) with schema migrations applied. Never throws to the
 *  caller for schema/migration issues at import time — callers get the throw
 *  on first USE, which their own fail-open paths already handle. */
export function getDb(): DatabaseSync {
  if (db) return db;
  const p = dbPath();
  mkdirSync(path.dirname(p), { recursive: true });
  db = new DatabaseSync(p);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 3000;");
  migrate(db);
  try {
    chmodSync(p, 0o600);
  } catch {
    /* perms are hardening, not a functional requirement */
  }
  return db;
}

/** Idempotent, ordered migrations — one row per applied id. */
function migrate(d: DatabaseSync): void {
  d.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, at TEXT NOT NULL)",
  );
  const applied = new Set(
    (d.prepare("SELECT id FROM _migrations").all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  const steps: [string, string][] = [
    [
      "001_errors",
      `CREATE TABLE IF NOT EXISTS errors (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         operator TEXT NOT NULL DEFAULT 'classic',
         scope TEXT NOT NULL,
         message TEXT NOT NULL,
         stack TEXT,
         at TEXT NOT NULL
       )`,
    ],
    [
      "002_flipradar",
      `CREATE TABLE IF NOT EXISTS flip_entries (
         id TEXT PRIMARY KEY,
         operator TEXT NOT NULL DEFAULT 'classic',
         name TEXT NOT NULL,
         url TEXT NOT NULL,
         mrr INTEGER NOT NULL,
         source TEXT NOT NULL,
         verdict TEXT,
         status TEXT NOT NULL DEFAULT 'new',
         seenAt TEXT NOT NULL,
         updatedAt TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS meta (
         k TEXT PRIMARY KEY,
         operator TEXT NOT NULL DEFAULT 'classic',
         v TEXT
       )`,
    ],
  ];
  for (const [id, sql] of steps) {
    if (applied.has(id)) continue;
    d.exec("BEGIN");
    try {
      d.exec(sql);
      d.prepare("INSERT INTO _migrations (id, at) VALUES (?, ?)").run(
        id,
        new Date().toISOString(),
      );
      d.exec("COMMIT");
    } catch (e) {
      d.exec("ROLLBACK");
      throw e;
    }
  }
}

/** Test/dev helper — drop the cached handle (a new getDb() reopens). */
export function closeDb(): void {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
}
