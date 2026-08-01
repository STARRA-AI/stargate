import { getMemory, recordExchange, reviseExchange } from "@/lib/memory/store";
import { callDigest } from "@/lib/memory/call-digest";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  // ?digest=1 → the continuity block the LIVE VOICE CALL injects into her
  // realtime session instructions on connect. Same store, same tier shape as
  // the chat brain's `memoryForPrompt` — but with her OWN styled replies
  // withheld and a computed overuse guard on top, because in a realtime
  // instruction block her past lines stop being memory and start being a
  // few-shot style prompt. See src/lib/memory/call-digest.ts for the measured
  // case (856 "baby", 421 "right here" in the store as of 2026-07-31).
  //
  // DECK CHAT IS UNAFFECTED: api/chat calls memoryForPrompt itself, server
  // side, and never comes through this route.
  if (url.searchParams.get("digest") === "1") {
    const store = await getMemory();
    return Response.json({ digest: callDigest(store) });
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
  const { role, content, supersede } = (body ?? {}) as {
    role?: unknown;
    content?: unknown;
    supersede?: unknown;
  };
  if (role !== "user" && role !== "assistant") {
    return Response.json({ error: "role must be user|assistant" }, { status: 400 });
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return Response.json({ error: "content must be a non-empty string" }, { status: 400 });
  }
  // Bound a single turn so a runaway transcript can't bloat the store; the
  // store's own rolling windows do the long-term compaction.
  const text = content.slice(0, 2000);
  // `supersede` = "this is the SAME utterance I just sent you, further along".
  // The live call has no reliable end-of-user-turn event, so it commits the
  // cumulative partial whenever any of its flush triggers fires and marks the
  // follow-ups as revisions. reviseExchange only replaces when the stored turn
  // really is a prefix of this one — a genuinely new line always appends, so a
  // buggy or malicious `supersede: true` can never delete an unrelated turn.
  if (supersede === true) {
    await reviseExchange(role, text);
    return Response.json({ ok: true, superseded: true });
  }
  await recordExchange(role, text);
  return Response.json({ ok: true });
}
