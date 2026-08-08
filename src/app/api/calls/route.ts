import { appendTurn, listSessions, readSession } from "@/lib/memory/call-log";

export const runtime = "nodejs";

/**
 * Per-call conversation archive (Bug 3). Auth is the middleware cookie gate
 * (src/middleware.ts) — same as every other /api/* route including the
 * neighbouring src/app/api/memory/route.ts, which also does no auth check of
 * its own. This route adds none either.
 */

export async function GET(req: Request) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (id) {
    const session = await readSession(id);
    if (!session) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json(session);
  }
  const sessions = await listSessions();
  return Response.json({ sessions });
}

/**
 * Appends one turn to a call's session file, creating it on the first turn.
 * Fire-and-forget client (Agent B, useVoiceCall.ts) — see call-log.ts for why
 * appendTurn itself never throws.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { id, role, text } = (body ?? {}) as {
    id?: unknown;
    role?: unknown;
    text?: unknown;
  };
  if (typeof id !== "string" || id.trim().length === 0) {
    return Response.json({ error: "id must be a non-empty string" }, { status: 400 });
  }
  if (role !== "user" && role !== "assistant") {
    return Response.json({ error: "role must be user|assistant" }, { status: 400 });
  }
  if (typeof text !== "string" || text.trim().length === 0) {
    return Response.json({ error: "text must be a non-empty string" }, { status: 400 });
  }
  await appendTurn(id, { role, text: text.slice(0, 4000), at: new Date().toISOString() });
  return Response.json({ ok: true });
}
