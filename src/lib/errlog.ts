/**
 * ERROR TRACKING ("air tracking", read as error tracking) — every captured
 * server-side failure lands in the errors table with scope + stack, and
 * narrates one feed line, so nothing breaks silently again (the poisoned-build
 * night, 2026-07-30, is exactly what this exists to surface).
 *
 * DISCIPLINE: capture may NEVER throw or block a caller — it is fire-and-
 * forget garnish on failure paths. Bounded: message 500 chars, stack 2000,
 * table pruned to the newest 500 rows.
 */
import { getDb, CURRENT_OPERATOR } from "@/lib/db";
import { pushFeed } from "@/lib/feed";

const KEEP = 500;

export function captureError(scope: string, err: unknown): void {
  try {
    const message =
      err instanceof Error ? err.message : String(err ?? "unknown");
    const stack = err instanceof Error ? (err.stack ?? "") : "";
    const d = getDb();
    d.prepare(
      "INSERT INTO errors (operator, scope, message, stack, at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      CURRENT_OPERATOR,
      scope.slice(0, 80),
      message.slice(0, 500),
      stack.slice(0, 2000),
      new Date().toISOString(),
    );
    d.prepare(
      "DELETE FROM errors WHERE operator = ? AND id NOT IN (SELECT id FROM errors WHERE operator = ? ORDER BY id DESC LIMIT ?)",
    ).run(CURRENT_OPERATOR, CURRENT_OPERATOR, KEEP);
    try {
      pushFeed("ERR", `${scope}: ${message.slice(0, 70)}`);
    } catch {
      /* feed is garnish on garnish */
    }
  } catch {
    /* error tracking must never become an error source */
  }
}

export type ErrorRow = {
  id: number;
  scope: string;
  message: string;
  stack: string | null;
  at: string;
};

export function recentErrors(limit = 50): ErrorRow[] {
  try {
    return getDb()
      .prepare(
        "SELECT id, scope, message, stack, at FROM errors WHERE operator = ? ORDER BY id DESC LIMIT ?",
      )
      .all(CURRENT_OPERATOR, Math.min(Math.max(1, limit), 200)) as ErrorRow[];
  } catch {
    return [];
  }
}
