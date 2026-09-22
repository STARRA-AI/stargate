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
 * AUTH. xAI's servers call this from the public internet, so it carries a
 * bearer token and FAILS CLOSED when that token is unset. It is no longer ONE
 * token: reads (`recall`) take STARRA_MCP_TOKEN, and anything that MUTATES
 * takes STARRA_MCP_WRITE_TOKEN. A holder of the read key can look her up; only
 * the write key can change what she believes. See src/lib/api/public-auth.ts.
 *
 * WRITES ARE DELIBERATELY LIMITED. remember + note + funding-status + trade.
 * Nothing here can delete anything, and nothing can read the store wholesale —
 * and nothing here can START OR STOP his trading bot. `dragon` reads its state;
 * engage/disengage need his deck cookie and are not reachable from this route.
 */

import { getMemory, recordExchange } from "@/lib/memory/store";
import {
  spokenDragon,
  spokenPositions,
  spokenShards,
  spokenSignals,
  spokenTrade,
} from "@/lib/tools/trade-voice";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { authorizePublic, notePublicDenial, type PublicScope } from "@/lib/api/public-auth";
import { safePublicError } from "@/lib/api/public-errors";
import { captureError } from "@/lib/errlog";

export const runtime = "nodejs";

/** Which actions MUTATE. Anything not listed here is read-only. */
// `trade` is here because it SPENDS. positions/shards/signals only look.
const WRITE_ACTIONS = new Set(["remember", "note", "funding_status", "trade"]);

/** Plain text — this is speech, not an API payload. */
function say(text: string, status = 200) {
  return new Response(text, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
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

/**
 * The action is a PATH segment, not a query param, on purpose.
 *
 * xAI's console requires every query parameter to be declared under "Additional
 * parameters" — which means the MODEL fills it. Letting her choose `action` at
 * call time would mean a mis-picked verb writes to memory when she meant to
 * read it. In the path, each console tool points at exactly one verb and the
 * model cannot get it wrong: /api/voice-tools/remember, /recall, /note,
 * /funding_status. The only thing she fills is the content.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ action: string }> },
) {
  const url = new URL(req.url);
  const { action } = await ctx.params;

  // The SCOPE is decided by the verb in the path, before anything is read or
  // written. An unknown action falls to "read" — the weaker demand — and still
  // needs a valid token to hear the "I don't know that one" sentence.
  const scope: PublicScope = WRITE_ACTIONS.has(action) ? "write" : "read";
  const gate = authorizePublic(req, scope);
  if (!gate.ok) {
    notePublicDenial("voice-tools", scope, gate);
    return say(gate.message, gate.status);
  }

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

      // ── trading (2026-09-04) ────────────────────────────────────────────
      // Reads are free. `trade` takes the WRITE token AND still refuses to
      // spend unless ?live=true is explicit — two separate gates, because on a
      // call a misheard word must never be what commits funds.
      case "positions":
        return say(await spokenPositions());

      case "shards":
        return say(await spokenShards());

      case "signals":
        return say(await spokenSignals());

      case "trade":
        return say(await spokenTrade(url.searchParams.get("live") === "true"));

      // `dragon` is a READ and stays one. It answers "what is his BOT doing" —
      // engaged or stopped, which category, paper or live, what it has made —
      // which is a different question from `positions`, and one she previously
      // could not answer on a call at all.
      //
      // ENGAGE/DISENGAGE ARE DELIBERATELY ABSENT FROM THIS ROUTE. xAI's servers
      // reach this file from the public internet; starting or stopping his
      // trading bot needs his DECK COOKIE, the same bar /api/dragon/control
      // already sets. The control verbs live in the chat lane only — see the
      // header on the Dragon section of lib/tools/trade-voice.ts.
      case "dragon":
        return say(await spokenDragon());

      case "funding_status": {
        const name = url.searchParams.get("name") ?? "";
        const status = url.searchParams.get("status") ?? "";
        if (!name || !status) return say("Tell me which lender and what status.");
        return say(await fundingStatus(name, status));
      }

      default:
        return say(
          "I don't know that one. I can recall something, remember something, take a note, check the dragon, or move a funding lead.",
        );
    }
  } catch (err) {
    // Never a stack trace on a phone call, and never a path on the internet —
    // but never a silent failure either. Reaching here needs a VALID token, so
    // this is not anonymous-floodable and is captured unthrottled.
    captureError(`voice-tools.${action}`, err);
    return say(`Something went wrong on my end — ${safePublicError(err, { maxLen: 80 })}`);
  }
}
