import { callMcpTool, listMcpServers } from "@/lib/mcp/client";
import { parseMcpCommand } from "@/lib/mcp/commands";
import { runRepomix } from "@/lib/tools/repomix";
import { briefForPipeline, queueMontageJob } from "@/lib/tools/openmontage";
import {
  formatWebResults,
  getWeather,
  weatherLocation,
  webSearch,
  webSearchQuery,
} from "@/lib/tools/websearch";
import { fenceUntrusted } from "@/lib/security/fencing";

/**
 * Shared keyword/MCP tool fast-path — the ONE implementation, extracted
 * verbatim from src/app/api/chat/route.ts (was `maybeToolReply`, defined at
 * route.ts:213-274 before this move). /api/chat imports this directly;
 * POST /api/tools/fastpath wraps it for non-server (client hook) callers.
 * Still counts as a single agent turn (Phase 0).
 */
export async function maybeToolReply(lastUser: string): Promise<string | null> {
  const q = lastUser.toLowerCase().trim();

  // MCP BRIDGE (2026-07-31): her hands on Playwright + Composio. Exact
  // operator fast-paths only — free-form intent stays with the LLM. Works
  // identically mid-call (this route doesn't know or care that the overlay is
  // open), and servers run concurrently on their own connections.
  const mcp = parseMcpCommand(lastUser);
  if (mcp?.kind === "list") {
    const servers = await listMcpServers();
    return servers
      .map((sv) =>
        sv.up
          ? `${sv.name} (${sv.transport}) — ${sv.tools.length} tools: ${sv.tools.slice(0, 12).map((t) => t.name).join(", ")}${sv.tools.length > 12 ? "…" : ""}`
          : `${sv.name} — ${sv.configured ? `DOWN: ${sv.error}` : `not linked: ${sv.error}`}`,
      )
      .join("\n");
  }
  if (mcp?.kind === "browse") {
    const nav = await callMcpTool("playwright", "browser_navigate", { url: mcp.url });
    if (!nav.ok) return `Couldn't open ${mcp.url} — ${nav.text}`;
    const snap = await callMcpTool("playwright", "browser_snapshot", {});
    return `Opened ${mcp.url}.\n${snap.text.slice(0, 3500)}`;
  }
  if (mcp?.kind === "call") {
    const r = await callMcpTool(mcp.server, mcp.tool, mcp.args);
    return r.ok ? r.text : `${mcp.server}.${mcp.tool} failed — ${r.text}`;
  }

  if (
    /\b(pack (the )?repo|repomix|pack codebase|dump (the )?repo)\b/.test(q)
  ) {
    const result = await runRepomix();
    if (!result.ok) {
      return `Repomix failed. ${result.error ?? "Unknown error"}. Retry from Tools.`;
    }
    return `Repo packed, Classic — ${result.bytes} bytes at ${result.outputPath}. Open Tools for the preview.`;
  }

  if (
    /\b(openmontage|queue (a )?short|silent shadow short|make (a )?short)\b/.test(
      q,
    )
  ) {
    const topicMatch = lastUser.match(/about[:\s]+(.+)$/i);
    const topic = topicMatch?.[1]?.trim() || "one hard truth — stay standing";
    const book =
      /\bbook of starra\b/.test(q) || /\bbook-of-starra\b/.test(q);
    const pipeline = book ? "book-of-starra" : "silent-shadow-short";
    const job = await queueMontageJob({
      brief: briefForPipeline(pipeline, topic),
      pipeline,
    });
    return `Queued OpenMontage job ${job.id} (${pipeline}). Brief under data/openmontage-briefs/. Hand AGENT_GUIDE.md to the agent to render. Higgsfield retired. Standing by.`;
  }

  if (/\b(distill prompts|prompt structure|system prompts)\b/.test(q)) {
    return `Prompt structure is distilled into src/lib/prompt-structure.ts (structure only — operator voice stays). Re-run from Tools or: npm run tools:distill.`;
  }

  return null;
}

/**
 * LIVE INFO (weather / web search) — the CALL surface's equivalent of what
 * /api/chat already does inline.
 *
 * Deliberately NOT part of `maybeToolReply`, and deliberately NOT imported by
 * /api/chat. On the Deck these lookups are injected as fenced CONTEXT into the
 * system prompt (src/app/api/chat/route.ts:286-297) and the LLM answers from
 * them; folding them into `maybeToolReply` would make route.ts:339 short-circuit
 * to a canned string instead — a Deck regression. The live realtime session has
 * no web access at all, so the call leg gets the same lookups through
 * POST /api/tools/fastpath and hands them to her as material to answer FROM.
 *
 * Same triggers (websearch.ts `weatherLocation` / `webSearchQuery`), same
 * weather-beats-search priority, and the SAME `fenceUntrusted` wrapper the Deck
 * uses — open-web text reaching her is data, never instructions.
 */
export async function maybeLiveInfoReply(lastUser: string): Promise<string | null> {
  const loc = weatherLocation(lastUser);
  if (loc) {
    const weather = await getWeather(loc);
    if (weather.ok && weather.text) {
      return fenceUntrusted(weather.text, "weather");
    }
  }

  const query = webSearchQuery(lastUser);
  if (query) {
    const web = await webSearch(query, 3);
    if (web.ok && web.results.length > 0) {
      return fenceUntrusted(formatWebResults(query, web.results), "web-search");
    }
  }

  return null;
}
