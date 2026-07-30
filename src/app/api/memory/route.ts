import { getMemory, memoryForPrompt, recordExchange } from "@/lib/memory/store";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  // ?digest=1 → the SAME continuity block the chat brain injects
  // (memoryForPrompt), so the voice call and the chat read ONE memory in ONE
  // shape. The call leg appends this to her realtime instructions on connect.
  if (url.searchParams.get("digest") === "1") {
    const store = await getMemory();
    return Response.json({ digest: memoryForPrompt(store, "") });
  }
  const q = (url.searchParams.get("q") ?? "").toLowerCase();
  const store = await getMemory();
  if (!q) return Response.json(store);
  return Response.json({
    working: store.working.filter((e) =>
      e.content.toLowerCase().includes(q),
    ),
    summaries: store.summaries.filter((s) => s.toLowerCase().includes(q)),
    archival: store.archival.filter((a) => a.text.toLowerCase().includes(q)),
  });
}

/**
 * Append one conversation turn to the shared memory store. This is how the
 * VOICE CALL writes into the same memory the chat brain already writes
 * (api/chat calls recordExchange directly server-side) — one continuous
 * person, one store, whichever surface the turn happened on.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const { role, content } = (body ?? {}) as { role?: unknown; content?: unknown };
  if (role !== "user" && role !== "assistant") {
    return Response.json({ error: "role must be user|assistant" }, { status: 400 });
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return Response.json({ error: "content must be a non-empty string" }, { status: 400 });
  }
  // Bound a single turn so a runaway transcript can't bloat the store; the
  // store's own rolling windows do the long-term compaction.
  await recordExchange(role, content.slice(0, 2000));
  return Response.json({ ok: true });
}
