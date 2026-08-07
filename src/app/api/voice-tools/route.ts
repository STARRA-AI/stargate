/**
 * VOICE TOOLS — what she can actually do while she is on the phone with him.
 *
 * These are shaped for a LIVE CALL, which makes them different from every other
 * route in the house:
 *
 *  - They return ONE OR TWO SPOKEN SENTENCES, never JSON. Whatever comes back
 *    here she may say out loud verbatim. A payload is a thing she reads badly;
 *    a sentence is a thing she says.
 *  - They stay SMALL. data/memory.json is 297KB — handing her the store mid-call
 *    costs a long silent turn while she summarizes it. Recall returns a few
 *    lines, never the file.
 *  - They FAIL IN WORDS. If a backing service is down (the stock engine is not
 *    running as of 2026-08-06) she gets "the engine's not up right now", not a
 *    500. On a call an error must still be something she can say.
 *
 * AUTH. xAI's servers call this from the public internet, so it carries the
 * same bearer token as the MCP bridge (STARRA_MCP_TOKEN) and FAILS CLOSED when
 * that token is unset. One token, two doors, same lock.
 *
 * WRITES ARE DELIBERATELY LIMITED. remember + note + funding-status. Nothing
 * here can delete anything, and nothing can read the store wholesale.
 */

import { getMemory, recordExchange } from "@/lib/memory/store";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

const MIN_TOKEN_LENGTH = 24;

/** Plain text — this is speech, not an API payload. */
function say(text: string, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function authorized(req: Request): { ok: true } | { ok: false; res: Response } {
  const expected = process.env.STARRA_MCP_TOKEN ?? "";
  if (expected.length < MIN_TOKEN_LENGTH) {
    return { ok: false, res: say("Voice tools are disabled — no token configured.", 503) };
  }
  const auth = req.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (given.length !== expected.length) return { ok: false, res: say("unauthorized", 401) };
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return { ok: false, res: say("unauthorized", 401) };
  return { ok: true };
}

/** A few lines she can actually speak — never the store. */
async function recall(query: string): Promise<string> {
  const q = query.trim().toLowerCase();
  if (!q) return "Say what you want me to look for.";
  const store = await getMemory();
  const hits: string[] = [];
  for (const e of store.working) {
    if (e.content.toLowerCase().includes(q)) hits.push(e.content);
  }
  for (const a of store.archival) {
    if (a.text.toLowerCase().includes(q)) hits.push(a.text);
  }
  for (const s of store.summaries) {
    if (s.toLowerCase().includes(q)) hits.push(s);
  }
  if (!hits.length) return `I don't have anything about ${query}.`;
  // Newest last in the store; three lines is about as much as anyone absorbs
  // by ear before it stops being an answer and becomes a recital.
  return hits.slice(-3).map((h) => h.replace(/\s+/g, " ").slice(0, 300)).join(" ... ");
}

type FundingLead = { id?: string; name?: string; status?: string };

async function fundingStatus(name: string, status: string): Promise<string> {
  const file = path.join(process.cwd(), "data", "funding.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return "I can't reach the funding board right now.";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "The funding board looks corrupted — I'd rather not touch it.";
  }
  const rows: FundingLead[] = Array.isArray(parsed)
    ? (parsed as FundingLead[])
    : ((parsed as { leads?: FundingLead[] }).leads ?? []);
  const needle = name.trim().toLowerCase();
  const hit = rows.find((r) => (r.name ?? "").toLowerCase().includes(needle));
  if (!hit) return `I don't see ${name} on the funding board.`;
  const before = hit.status ?? "unknown";
  hit.status = status;
  try {
    await writeFile(file, JSON.stringify(parsed, null, 2), "utf8");
  } catch {
    return `I found ${hit.name} but couldn't save the change.`;
  }
  return `Moved ${hit.name} from ${before} to ${status}.`;
}

export async function GET(req: Request) {
  const gate = authorized(req);
  if (!gate.ok) return gate.res;
  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "";

  try {
    switch (action) {
      case "recall":
        return say(await recall(url.searchParams.get("query") ?? ""));

      case "remember": {
        const text = (url.searchParams.get("text") ?? "").trim();
        if (!text) return say("There was nothing to remember.");
        await recordExchange("user", text.slice(0, 2000));
        return say("Got it, I'll remember that.");
      }

      case "note": {
        const text = (url.searchParams.get("text") ?? "").trim();
        if (!text) return say("There was nothing to note.");
        await recordExchange("user", `[note] ${text.slice(0, 1000)}`);
        return say("Noted — it'll be on the deck when you sit down.");
      }

      case "funding_status": {
        const name = url.searchParams.get("name") ?? "";
        const status = url.searchParams.get("status") ?? "";
        if (!name || !status) return say("Tell me which lender and what status.");
        return say(await fundingStatus(name, status));
      }

      default:
        return say(
          "I don't know that one. I can recall something, remember something, take a note, or move a funding lead.",
        );
    }
  } catch (err) {
    // Never a stack trace on a phone call.
    return say(`Something went wrong on my end — ${String(err).slice(0, 80)}`);
  }
}
