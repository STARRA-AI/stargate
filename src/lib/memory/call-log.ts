import { promises as fs } from "fs";
import path from "path";

/**
 * PER-CALL CONVERSATION ARCHIVE (Bug 3). One JSON file per call under the
 * resolved storage dir — separate from data/memory.json's rolling working
 * array (store.ts:18), which has no per-conversation concept at all.
 *
 * This module sits on the LIVE CALL PATH (Agent B fire-and-forget POSTs from
 * useVoiceCall.ts on every turn) — a throw here is silence in Classic's ear.
 * Mirrors the defensive style of store.ts:29-56: every read tolerates a
 * missing/corrupt file, every write swallows its own failure.
 */

export type CallLogTurn = { role: "user" | "assistant"; text: string; at: string };
export type CallLogSession = {
  id: string;
  startedAt: string;
  endedAt: string | null;
  turns: CallLogTurn[];
};

const VOLUME_ROOT = "/Volumes/Storage";
const VOLUME_CALLS_DIR = path.join(VOLUME_ROOT, "STARRA", "calls");

/** How much of a turn's text survives into the listSessions preview. */
const PREVIEW_CHARS = 160;
/** How many sessions listSessions returns, newest first. */
const LIST_CAP = 50;

/**
 * Storage dir, in order: STARRA_CALL_LOG_DIR env → /Volumes/Storage/STARRA/calls
 * if the drive is mounted → <cwd>/data/calls. Checks the MOUNT ROOT
 * (/Volumes/Storage), not the calls subdir itself — the subdir legitimately
 * doesn't exist yet on a first-ever run with the drive plugged in, and
 * checking it would wrongly fall back to local disk. An unplugged drive
 * degrades silently; it never throws.
 */
async function resolveDir(): Promise<string> {
  const envDir = process.env.STARRA_CALL_LOG_DIR;
  if (envDir) return envDir;
  try {
    await fs.access(VOLUME_ROOT);
    return VOLUME_CALLS_DIR;
  } catch {
    return path.join(process.cwd(), "data", "calls");
  }
}

function sessionPath(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

function isTurn(t: unknown): t is CallLogTurn {
  const c = t as Partial<CallLogTurn> | null;
  return (
    !!c &&
    (c.role === "user" || c.role === "assistant") &&
    typeof c.text === "string" &&
    typeof c.at === "string"
  );
}

/** Reads one session file. Missing/corrupt → null, never throws. */
async function readSessionFile(dir: string, id: string): Promise<CallLogSession | null> {
  try {
    const raw = await fs.readFile(sessionPath(dir, id), "utf8");
    const parsed = JSON.parse(raw) as Partial<CallLogSession> | null;
    if (!parsed || typeof parsed.id !== "string" || !Array.isArray(parsed.turns)) return null;
    return {
      id: parsed.id,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : new Date().toISOString(),
      endedAt: typeof parsed.endedAt === "string" ? parsed.endedAt : null,
      turns: parsed.turns.filter(isTurn),
    };
  } catch {
    return null;
  }
}

/**
 * Append one turn to a call's session file, creating it on the first turn.
 * NEVER THROWS — called fire-and-forget from the live call path (contract
 * §D); a dropped turn beats a crash in her ear.
 */
export async function appendTurn(id: string, turn: CallLogTurn): Promise<void> {
  try {
    const dir = await resolveDir();
    await fs.mkdir(dir, { recursive: true });
    const existing = await readSessionFile(dir, id);
    const session: CallLogSession = existing ?? {
      id,
      startedAt: turn.at || new Date().toISOString(),
      endedAt: null,
      turns: [],
    };
    session.turns.push(turn);
    await fs.writeFile(sessionPath(dir, id), JSON.stringify(session, null, 2), "utf8");
  } catch {
    // Storage unavailable / write raced / disk full — silence beats a crash
    // on the live call path. The turn is lost, not the call.
  }
}

/**
 * Lists sessions newest-first (by startedAt), capped at LIST_CAP, with each
 * turn's text trimmed to a preview so the listing stays light. Never throws —
 * an unreadable/missing dir is an empty list, not an error.
 */
export async function listSessions(): Promise<CallLogSession[]> {
  try {
    const dir = await resolveDir();
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const ids = names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -".json".length));
    const sessions = (
      await Promise.all(ids.map((id) => readSessionFile(dir, id)))
    ).filter((s): s is CallLogSession => s !== null);
    sessions.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
    return sessions.slice(0, LIST_CAP).map((s) => ({
      ...s,
      turns: s.turns.map((t) => ({
        ...t,
        text: t.text.length > PREVIEW_CHARS ? `${t.text.slice(0, PREVIEW_CHARS)}…` : t.text,
      })),
    }));
  } catch {
    return [];
  }
}

/** Reads one full session (untrimmed). Missing/corrupt → null, never throws. */
export async function readSession(id: string): Promise<CallLogSession | null> {
  try {
    const dir = await resolveDir();
    return await readSessionFile(dir, id);
  } catch {
    return null;
  }
}
