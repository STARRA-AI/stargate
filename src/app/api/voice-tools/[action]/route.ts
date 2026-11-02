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
 *
 * ── copy_scan (2026-10-04) IS A READ, AND THERE IS NO COPY-EXECUTE VERB ──────
 * `copy_scan` tells him what the leaderboard copy lane currently sees. It reads
 * Kalshi's free public leaderboard, reads a snapshot file if a RECENT ENOUGH one
 * exists (its age is always said out loud — see COPY_SNAPSHOT_FRESH_MS), and
 * PLACES NOTHING. It is deliberately absent from WRITE_ACTIONS, and
 * there is deliberately NO verb on this route that fires a copy order: placing
 * orders stays off the public bearer lane, same bar as engage/disengage.
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
import { DEFAULTS as LOOP_DEFAULTS, scanKalshiLeaderboardIntents } from "@/lib/copy-loop";
import { DEFAULT_SIGNAL_CONFIG } from "@/lib/copy-signals";
import { authorizePublic, notePublicDenial, type PublicScope } from "@/lib/api/public-auth";
import { safePublicError } from "@/lib/api/public-errors";
import { captureError } from "@/lib/errlog";

export const runtime = "nodejs";

/**
 * Which actions MUTATE. Anything not listed here is read-only.
 *
 * NOT EXPORTED, on purpose: a Next route file may only export the HTTP verbs and
 * the handful of route-config names, so `tests/copy-loop-dragon.test.ts` asserts
 * against this literal by reading the source of this file instead of importing
 * it. That is the source of truth either way.
 */
// `trade` is here because it SPENDS. positions/shards/signals/copy_scan only look.
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

/* ── copy_scan: what the leaderboard copy lane can see, in one sentence ──────
 * READ-ONLY. It never places, never POSTs, and never touches dragontradar.com —
 * a single bad token there answers 429 and locks him out of his own bot, which
 * is not something a phone call should be able to cause.
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * ── THE SNAPSHOT'S AGE IS ALWAYS SAID OUT LOUD ───────────────────────────────
 *
 * This used to call a snapshot up to 30 MINUTES old "Right now", while the lane
 * that produced it only accepts fills younger than
 * `DEFAULT_SIGNAL_CONFIG.maxSignalAgeMin` (10). So she could say "Right now"
 * about a set of fills every one of which the lane itself had already declared
 * stale. There was also no upper bound: a snapshot from last week was read out
 * the same way, just with a bigger number.
 *
 * Both are fixed by the two constants below:
 *  - FRESH is the signal age itself, read from the config rather than restated,
 *    so these two numbers cannot drift apart again.
 *  - MAX is a hard ceiling. Past it the file is not spoken at all and the bounded
 *    live look runs instead, which is the same path as "no snapshot".
 *
 * And the age goes in the sentence EVERY time, fresh or not. "Right now" is gone:
 * a cached number is never now, and on a call the difference matters because he
 * may act on it.
 */
const COPY_SNAPSHOT_FRESH_MS = DEFAULT_SIGNAL_CONFIG.maxSignalAgeMin * 60_000;

/** Older than this and the snapshot is not evidence of anything. One hour. */
const COPY_SNAPSHOT_MAX_AGE_MS = 60 * 60_000;

type CopySnapshot = {
  scannedAt?: string;
  kalshi?: { examined?: number; visible?: number; visibleNicknames?: string[] };
  polymarket?: { examined?: number; persistent?: number };
  intents?: number;
  rejections?: number;
  plan?: { accepted?: number; committedCents?: number };
};

/** Nicknames are read aloud, so "szg.szg" has to stop being a filename. */
function sayable(nick: string): string {
  return nick.replace(/\./g, " dot ").replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

function namesOf(nicks: string[] | undefined): string {
  const list = (nicks ?? []).filter((n) => n).map(sayable);
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

/**
 * The full scan walks ~100 free Kalshi endpoints one at a time, which is a long
 * silent turn on a call. So: use the snapshot `scripts/starra-copy-scan.ts`
 * leaves behind when it exists, and only fall back to a BOUNDED live look when
 * it does not. Default bound is the top 25 — he can widen it with ?traders=.
 */
async function copyScan(tradersParam: string): Promise<string> {
  const snap = await readCopySnapshot();
  if (snap) {
    const { when, stale } = snapshotAge(Date.now() - Date.parse(snap.scannedAt!));
    const vis = snap.kalshi?.visible ?? 0;
    const examined = snap.kalshi?.examined ?? 0;
    const who = namesOf(snap.kalshi?.visibleNicknames);
    const intents = snap.intents ?? 0;
    if (vis === 0) {
      return `${when}, none of the top ${examined} traders on Kalshi share their trades, so there's nothing to copy over there. I placed nothing.${stale}`;
    }
    const money =
      snap.plan?.committedCents && snap.plan.committedCents > 0
        ? ` That's about $${(snap.plan.committedCents / 100).toFixed(2)} of exposure if you fired all of it.`
        : "";
    if (intents === 0) {
      return `${when}, ${vis} of the top ${examined} on Kalshi share their trades${who ? ` — ${who}` : ""}, but nothing fresh enough to mirror came through. I placed nothing.${stale}`;
    }
    // ★ `intents` counts BOTH venues. Saying "their fills" would hand the
    //   Polymarket signals to the two Kalshi names, which is a true number
    //   attached to the wrong people — so the sentence names the venues instead.
    const poly = snap.polymarket?.persistent ?? 0;
    return (
      `${when}, ${vis} of the top ${examined} on Kalshi share their trades${who ? ` — ${who}` : ""}, ` +
      `and ${poly} Polymarket wallets are still winning from before this week. ` +
      `Across both, ${intents} fills clear the bar.${money} I placed nothing — the plan's on the deck.${stale}`
    );
  }

  // No snapshot. A bounded live look, so she has an answer instead of a shrug.
  const n = Math.min(100, Math.max(1, Math.floor(Number(tradersParam) || 25)));
  const scan = await scanKalshiLeaderboardIntents({
    ...LOOP_DEFAULTS,
    kalshiTraderLimit: n,
    // Faster than the 120ms the full walk uses: a call cannot wait 12 seconds.
    kalshiWalkDelayMs: 40,
  });
  const partial = n < 100 ? ` I only checked the top ${n} to keep this quick` : "";
  if (scan.checked.kalshiVisible === 0) {
    return `Nobody in the top ${scan.checked.kalshiTraders} on Kalshi shares their trades, so there's nothing to copy there.${partial}. I placed nothing.`;
  }
  if (scan.intents.length === 0) {
    return `${scan.checked.kalshiVisible} of the top ${scan.checked.kalshiTraders} share their trades, but none of their fills are fresh enough to mirror.${partial}. I placed nothing.`;
  }
  const best = scan.intents[0];
  return `${scan.intents.length} fills clear the bar — the freshest is ${best.action} ${best.side.toUpperCase()} on ${best.ticker} at ${best.priceCents} cents.${partial}. I placed nothing.`;
}

/**
 * How old the snapshot is, in words she can say. Two pieces so neither one has to
 * be jammed into the middle of a sentence: `when` opens it, `stale` closes it.
 * There is no "right now" — a cached number is never now.
 */
function snapshotAge(ageMs: number): { when: string; stale: string } {
  const age = Math.max(0, ageMs);
  const mins = Math.round(age / 60_000);
  const stamp = mins < 1 ? "under a minute ago" : `${mins} minute${mins === 1 ? "" : "s"} ago`;
  // ★ STRICTLY LESS THAN, to match the lane's own INCLUSIVE staleness boundary:
  //   copy-signals' freshness() calls a fill exactly maxSignalAgeMin old ALREADY
  //   STALE, so a snapshot exactly that old must carry the note, not skip it.
  const stale =
    age < COPY_SNAPSHOT_FRESH_MS
      ? ""
      : ` That read is older than the ${DEFAULT_SIGNAL_CONFIG.maxSignalAgeMin}-minute window I mirror on, so treat it as history.`;
  return { when: `As of ${stamp}`, stale };
}

/**
 * The snapshot, or null when there isn't a usable one. Never throws.
 *
 * A snapshot past COPY_SNAPSHOT_MAX_AGE_MS is treated as absent, so the caller
 * does a bounded live look instead of reading out something arbitrarily old.
 */
async function readCopySnapshot(): Promise<CopySnapshot | null> {
  try {
    const raw = await readFile(path.join(process.cwd(), "data", "copy-scan.json"), "utf8");
    const parsed = JSON.parse(raw) as CopySnapshot;
    if (!parsed.scannedAt || !Number.isFinite(Date.parse(parsed.scannedAt))) return null;
    if (Date.now() - Date.parse(parsed.scannedAt) > COPY_SNAPSHOT_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
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

      // `copy_scan` is a READ and stays one. It answers "who are we copying and
      // what would it cost" — the leaderboard lane, which `signals` (the
      // Polymarket-vs-Kalshi price gap) does not cover. It places NOTHING, and
      // there is no copy-execute verb on this route at all.
      case "copy_scan":
        return say(await copyScan(url.searchParams.get("traders") ?? ""));

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
          "I don't know that one. I can recall something, remember something, take a note, check the dragon, run a copy scan, or move a funding lead.",
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
