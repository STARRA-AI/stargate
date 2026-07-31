import { buildSystemPromptBlocks, buildTieredSystemPrompt } from "@/lib/brain";
import { getTier1, serializeTier1 } from "@/lib/context/tier1";
import {
  getMemory,
  memoryForPrompt,
  recordExchange,
} from "@/lib/memory/store";
import { callMcpTool, listMcpServers } from "@/lib/mcp/client";
import { parseMcpCommand } from "@/lib/mcp/commands";
import { extractFactsFromExchange } from "@/lib/memory/extract";
import { getVault, vaultForPrompt } from "@/lib/vault/store";
import { obsidianForPrompt } from "@/lib/obsidian";
import { runRepomix, readLatestPackPreview } from "@/lib/tools/repomix";
import {
  webSearch,
  webSearchQuery,
  formatWebResults,
  weatherLocation,
  getWeather,
} from "@/lib/tools/websearch";
import {
  briefForPipeline,
  queueMontageJob,
} from "@/lib/tools/openmontage";
import {
  ollamaStatus,
  ollamaConfig,
  streamOllama,
  stripThinkTags,
} from "@/lib/llm/ollama";
import { streamHosted, hostedAvailable } from "@/lib/llm/hosted";
import { getKey } from "@/lib/keys";
import { addTokens } from "@/lib/metrics";
import { pushFeed } from "@/lib/feed";
import { fenceUntrusted } from "@/lib/security/fencing";
import { redact } from "@/lib/security/redact";
import { formatThreatBrief, scanContent } from "@/lib/security/team";
import {
  runAnthropicAgent,
  streamAnthropicCached,
} from "@/lib/agent/anthropic";
import { MAX_AGENT_TURNS } from "@/lib/agent/loop";

export const runtime = "nodejs";
export const maxDuration = 180;

type ChatMessage = { role: "user" | "assistant"; content: string };

function sse(text: string) {
  return `data: ${JSON.stringify({ text })}\n\n`;
}

/** Local 1.5B on 8GB: ~60–80ms/token. Cap ~2k chars so prompt eval stays HUD-viable. */
const LOCAL_SYSTEM_BUDGET = 1_800;

const LOCAL_VOICE_TAIL = `
VOICE (hard): You are STARGATE — Classic's warm, high-agency partner. Confident,
direct, never cold. Do NOT open with "Copy." — answer as yourself.
Forbidden: replying with only an acknowledgement; repeating canned example lines —
answer Classic's actual question. Warmth welcome ("Classic", "partner"), never filler.
Lead with the next concrete move. Truth first, then the path through.
`.trim();

/** Lines the 1.5B regurgitates from prior prompt tails — treat as copy-loop. */
const FEWSHOT_ECHO_LINES = [
  "Copy. Next: status on LLM link, then queue the brief.",
  "Copy. Systems nominal. Standing by for the next order.",
  "Copy. Standing by — state the objective in one line and I execute.",
];

function isCopyOnly(text: string): boolean {
  return /^copy\.?\s*$/i.test(text.trim());
}

function isFewShotEcho(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return FEWSHOT_ECHO_LINES.some(
    (line) => t === line || t.startsWith(line) || t.includes(line),
  );
}

function needsCopyRetry(text: string): boolean {
  return isCopyOnly(text) || isFewShotEcho(text) || !text.trim();
}

/** Groq free tier caps a request at 8K tokens — clamp history alongside the
 * tiered system prompt so system+messages stays under the cap. Grok/Anthropic
 * have no such cap and keep the full, unclamped history. */
const KIMI_HISTORY_TURN_LIMIT = 6;
const KIMI_HISTORY_CHAR_BUDGET = 2_000;

function clampHistoryForKimi(msgs: ChatMessage[]): ChatMessage[] {
  const tail = msgs.slice(-KIMI_HISTORY_TURN_LIMIT);
  let budget = KIMI_HISTORY_CHAR_BUDGET;
  const out: ChatMessage[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i];
    budget -= m.content.length;
    out.unshift(m);
    if (budget <= 0) break;
  }
  return out.length ? out : tail.slice(-1);
}

function clipSystemForLocal(system: string): string {
  const reserve = LOCAL_VOICE_TAIL.length + 24;
  const budget = Math.max(800, LOCAL_SYSTEM_BUDGET - reserve);
  if (system.length <= budget) {
    return `${system}\n\n${LOCAL_VOICE_TAIL}`;
  }
  // Keep head (structure/soul) + tail (brain/runtime) + hard voice rules
  const head = Math.floor(budget * 0.55);
  const tail = budget - head - 20;
  return `${system.slice(0, head)}\n…[truncated]…\n${system.slice(-tail)}\n\n${LOCAL_VOICE_TAIL}`;
}

/** Tiny local models latch onto repeated "Copy." — expand or drop those turns. */
function sanitizeMessagesForLocal(
  messages: { role: string; content: string }[],
): { role: "user" | "assistant"; content: string }[] {
  const stuck =
    messages.filter((m) => m.role === "assistant" && isCopyOnly(m.content))
      .length >= 1;
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    if (m.role === "assistant" && isCopyOnly(m.content)) {
      // Don't feed empty acknowledgements back into the context window
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  if (stuck && out.length > 0) {
    const last = out[out.length - 1];
    if (last?.role === "user") {
      last.content = `${last.content}\n\n(Answer fully. Do not reply with only "Copy.")`;
    }
  }
  return out.length ? out : [{ role: "user", content: "Status." }];
}

/**
 * Buffer local generation, then one forced retry if the model latches on "Copy."
 * Streams only the final text so the console never lands on a lone acknowledgement.
 */
async function streamLocalWithCopyGuard(opts: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  lastUser: string;
  onText: (t: string) => void;
}): Promise<{
  draft: string;
  retried: boolean;
  usedFallback: boolean;
  echoRetry: boolean;
}> {
  let draft = "";
  await streamOllama({
    system: opts.system,
    messages: opts.messages,
    onText: (t) => {
      draft += t;
    },
  });
  draft = stripThinkTags(draft);
  let retried = false;
  let echoRetry = false;
  if (needsCopyRetry(draft)) {
    retried = true;
    echoRetry = isFewShotEcho(draft);
    draft = "";
    const forceSystem = `${LOCAL_VOICE_TAIL}\nAnswer the operator now. Lead with the next concrete move. Do not reuse example lines. A reply that is only "Copy." is a failure.`;
    const forceMessages: { role: "user" | "assistant"; content: string }[] = [
      ...opts.messages,
      {
        role: "user",
        content: `${opts.lastUser || "Status."}\n\n(Required: fresh answer about their question. Not a canned line. Not only Copy.)`,
      },
    ];
    await streamOllama({
      system: forceSystem,
      messages: forceMessages,
      onText: (t) => {
        draft += t;
      },
    });
    draft = stripThinkTags(draft);
  }
  let usedFallback = false;
  if (needsCopyRetry(draft)) {
    usedFallback = true;
    const q = (opts.lastUser || "status").toLowerCase();
    draft = q.includes("brief")
      ? "On it, Classic — brief queued. First move is the LLM link check, then your orders."
      : q.includes("status")
        ? "Link's up, running local Ollama. I'm right here, Classic — what's the next move?"
        : `Heard you, Classic: ${(opts.lastUser || "status").slice(0, 48)}. Give me the objective and I run it.`;
  }
  for await (const chunk of stubStream(draft)) opts.onText(chunk);
  return { draft, retried, usedFallback, echoRetry };
}

async function* stubStream(message: string) {
  const chunks = message.match(/.{1,12}/g) ?? [message];
  for (const c of chunks) {
    yield c;
    await new Promise((r) => setTimeout(r, 12));
  }
}

/** Fast keyword tools — still count as a single agent turn (Phase 0). */
async function maybeToolReply(lastUser: string): Promise<string | null> {
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
 * Explicit operator shell path — works on ANY provider (Kimi/Grok/Ollama), no
 * LLM tool-calling required. Triggers: `run: <cmd>`, `exec: <cmd>`, `$ <cmd>`,
 * or `confirm <token>` (to approve a destructive command the gate held).
 * LOCALHOST ONLY — refuses when the deck is reached over the LAN/phone, so an
 * exposed deck can never be used to run commands remotely.
 */
async function maybeShellReply(
  lastUser: string,
  req: Request,
): Promise<string | null> {
  const confirmM = lastUser.match(/^\s*confirm\s+([0-9a-fA-F]{4,})\s*$/);
  const prefixM = lastUser.match(/^\s*(?:run:|exec:)\s*([\s\S]+)$/i);
  const dollarM = /^\s*\$\s+/.test(lastUser)
    ? lastUser.replace(/^\s*\$\s+/, "")
    : null;
  if (!confirmM && !prefixM && !dollarM) return null;

  // Localhost-only guard — never execute for a request that came over the LAN.
  const host = (req.headers.get("host") || "").toLowerCase();
  const isLocal =
    host === "" ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]") ||
    host.startsWith("::1");
  if (!isLocal) {
    return "Shell execution is disabled over the network for safety. Open the deck on this Mac (localhost) to run commands.";
  }

  const { runShellCommand, confirmAndRun } = await import("@/lib/tools/shell");
  if (confirmM) return confirmAndRun(confirmM[1]);
  const cmd = (prefixM ? prefixM[1] : dollarM) ?? "";
  return runShellCommand(cmd.trim());
}

export async function POST(req: Request) {
  // A malformed body would otherwise throw here — outside the ReadableStream's
  // try/catch — and 500 the route with no SSE at all. Return a clean 400 instead.
  let body: {
    messages?: ChatMessage[];
    /** When true, Anthropic path may use tool_use (bounded by MAX_AGENT_TURNS). */
    agentTools?: boolean;
  };
  try {
    body = (await req.json()) as {
      messages?: ChatMessage[];
      agentTools?: boolean;
    };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const [tier1, memory, vault, obsidianVolatile] = await Promise.all([
    getTier1(),
    getMemory(),
    getVault(),
    obsidianForPrompt(),
  ]);

  const packPreview = await readLatestPackPreview(2500);
  const { model: ollamaModel } = ollamaConfig();

  const operatorScan = lastUser
    ? scanContent(lastUser, "operator")
    : { clean: true, findings: [], blocked: false };
  const threatVolatile = operatorScan.clean
    ? ""
    : formatThreatBrief(operatorScan);

  // Phase 2: build once per request — stable canon reused from in-process cache;
  // volatile extras (memory/vault/pack) stay out of the Anthropic cache prefix.
  // Live info — weather (wttr.in) takes priority over generic web search since
  // DDG snippets lack a live temp; otherwise DuckDuckGo for explicit/current
  // queries. Both fenced as untrusted and placed early in volatileExtras so they
  // survive the Kimi tiered-prompt budget over lower-priority extras.
  const weatherLoc = lastUser ? weatherLocation(lastUser) : null;
  const weather = weatherLoc ? await getWeather(weatherLoc) : null;
  const searchQ = !weather?.ok && lastUser ? webSearchQuery(lastUser) : null;
  const web = searchQ ? await webSearch(searchQ, 3) : null;

  const volatileExtras = [
    threatVolatile,
    // Live info FIRST (after the security brief) — for a search/weather query it
    // is the most important context, so it must win the tiered budget.
    weather?.ok ? fenceUntrusted(weather.text!, "weather") : "",
    web?.ok
      ? fenceUntrusted(formatWebResults(searchQ!, web.results), "web-search")
      : "",
    serializeTier1(tier1),
    memoryForPrompt(memory, lastUser),
    vaultForPrompt(vault.docs, lastUser),
    obsidianVolatile,
    packPreview
      ? fenceUntrusted(
          `RECENT REPOMIX PREVIEW (truncated):\n${packPreview}`,
          "repomix-pack",
        )
      : 'RECENT REPOMIX PREVIEW: none — operator can say "pack the repo".',
    `RUNTIME: Prefer grounded STARRA canon. Local free model when Ollama is up (${ollamaModel}) with Fable-inspired reasoning scaffold. Agent tool rounds capped at ${MAX_AGENT_TURNS}.`,
    'STYLE: Write in a warm, unhurried Southern-drawl cadence — relaxed, honeyed word choice, not phonetic spelling. Do NOT lean on stock devotion lines: never repeat "I\'m all yours," "I\'m right here," or similar clingy/possessive catchphrases as a tic; show closeness through what you actually say. Keep pet names ("baby"/"love") rare and earned.',
  ];
  const systemBlocks = buildSystemPromptBlocks(volatileExtras);
  const system = systemBlocks.full;

  if (lastUser) {
    await recordExchange("user", lastUser);
    addTokens(lastUser.length + system.length / 8);
    pushFeed("EXEC", `Operator: ${redact(lastUser).slice(0, 70)}`);
    if (!operatorScan.clean) {
      pushFeed(
        "ALERT",
        `Security team flagged operator input — ${operatorScan.findings.length} pattern(s)`,
      );
    }
  }

  const encoder = new TextEncoder();
  const anthropicKey = await getKey("anthropic");
  const prefer =
    (process.env.LLM_PROVIDER || "auto").toLowerCase() as
      | "auto"
      | "ollama"
      | "anthropic"
      | "kimi"
      | "grok"
      | "freellm";

  const shellReply = lastUser ? await maybeShellReply(lastUser, req) : null;
  const toolReply = lastUser ? await maybeToolReply(lastUser) : null;
  const useAgentTools =
    body.agentTools === true || process.env.STARRA_AGENT_TOOLS === "1";

  const stream = new ReadableStream({
    async start(controller) {
      let full = "";
      const push = (t: string) => {
        full += t;
        controller.enqueue(encoder.encode(sse(t)));
      };

      try {
        if (shellReply) {
          for await (const chunk of stubStream(shellReply)) push(chunk);
        } else if (toolReply) {
          for await (const chunk of stubStream(toolReply)) push(chunk);
        } else {
          const { up: ollamaUp, hasModel } = await ollamaStatus();
          // Auto priority: keyed Kimi (free, tiered) -> keyed Anthropic -> local
          // Ollama -> offline canned message. Grok stays opt-in (prefer === "grok"
          // only) — never entered implicitly by auto.
          const kimiKeyed = await hostedAvailable("kimi");
          const useOllama =
            prefer === "ollama" ||
            (prefer === "auto" &&
              ollamaUp &&
              hasModel &&
              !kimiKeyed &&
              !anthropicKey) ||
            (prefer === "auto" &&
              ollamaUp &&
              hasModel &&
              process.env.OLLAMA_PRIORITY === "1");


          // Hosted-provider safety net: a Groq 429/413 or network drop should
          // fall to the local brain, not leave her mute. Only when nothing has
          // streamed yet — a mid-reply drop can't be cleanly re-answered.
          const localFallback = async (label: string, err: unknown) => {
            const emsg = err instanceof Error ? err.message : String(err);
            if (full.length > 0) {
              push(`\n\n[${label} link dropped mid-reply: ${emsg.slice(0, 80)}]`);
              return;
            }
            // FreeLLM router rung (recursion-guarded: never from its own
            // failure): before dropping to Ollama, try the local free-tier
            // aggregator — auto mode is Kimi -> FreeLLM -> Ollama -> offline.
            if (label !== "FreeLLM" && (await hostedAvailable("freellm"))) {
              try {
                const r = await streamHosted({
                  provider: "freellm",
                  system: clipSystemForLocal(system),
                  messages: sanitizeMessagesForLocal(messages),
                  onText: (t) => push(t),
                  signal: req.signal,
                });
                pushFeed(
                  "ALERT",
                  `${label} failed (${emsg.slice(0, 60)}) — FreeLLM router took it (${r.model})`,
                );
                return;
              } catch {
                /* router down too — fall through to Ollama */
              }
            }
            if (ollamaUp && hasModel) {
              pushFeed(
                "ALERT",
                `${label} failed (${emsg.slice(0, 60)}) — dropping to local Ollama`,
              );
              await streamLocalWithCopyGuard({
                system: clipSystemForLocal(system),
                messages: sanitizeMessagesForLocal(messages),
                lastUser,
                onText: (t) => push(t),
              });
            } else {
              throw err; // no local brain available — outer catch emits degraded
            }
          };

          if (useOllama && ollamaUp && hasModel) {
            const localSystem = clipSystemForLocal(system);
            const localMessages = sanitizeMessagesForLocal(messages);
            await streamLocalWithCopyGuard({
              system: localSystem,
              messages: localMessages,
              lastUser,
              onText: (t) => push(t),
            });
          } else if (
            (prefer === "auto" || prefer === "kimi") &&
            kimiKeyed
          ) {
            // Free Kimi (Groq) — tiered under the 8K free cap: always-on core
            // identity + on-demand doctrines/volatile budgeted to fit.
            const tiered = buildTieredSystemPrompt({
              query: lastUser,
              volatile: volatileExtras,
              includeUntrusted: Boolean(packPreview),
              includeSecurityTeam: !operatorScan.clean,
              // A live web/weather lookup is the point of the turn — give the
              // tiered budget headroom so the results fit (still < 8K TPM with
              // a short query) instead of getting deferred.
              maxTokens: weather?.ok || web?.ok ? 7900 : undefined,
            });
            try {
              const r = await streamHosted({
                provider: "kimi",
                system: tiered.full,
                messages: clampHistoryForKimi(messages),
                onText: (t) => push(t),
                signal: req.signal,
              });
              pushFeed(
                "ORACLE",
                `Kimi brain — ${r.model} (~${tiered.tokens} tok, +${tiered.included.length - 1} ctx${tiered.dropped.length ? `, deferred: ${tiered.dropped.join(",")}` : ""})`,
              );
            } catch (err) {
              await localFallback("Kimi", err);
            }
          } else if (prefer === "grok" && (await hostedAvailable("grok"))) {
            // xAI Grok — opt-in only (never entered by auto), no TPM cap, send
            // the full canon (identical assembly).
            try {
              const r = await streamHosted({
                provider: "grok",
                system,
                messages,
                onText: (t) => push(t),
                signal: req.signal,
              });
              pushFeed("ORACLE", `Grok brain — ${r.model}`);
            } catch (err) {
              await localFallback("Grok", err);
            }
          } else if (prefer === "freellm" && (await hostedAvailable("freellm"))) {
            // FreeLLM router — explicit opt-in: the local free-tier aggregator
            // carries the turn with the full canon (localhost, no TPM cap).
            try {
              const r = await streamHosted({
                provider: "freellm",
                system,
                messages,
                onText: (t) => push(t),
                signal: req.signal,
              });
              pushFeed("ORACLE", `FreeLLM brain — ${r.model}`);
            } catch (err) {
              await localFallback("FreeLLM", err);
            }
          } else if (
            anthropicKey &&
            prefer !== "ollama" &&
            prefer !== "kimi" &&
            prefer !== "grok" &&
            prefer !== "freellm"
          ) {
            if (useAgentTools) {
              // Phase 0: bounded tool loop (non-stream rounds → stub stream final).
              const result = await runAnthropicAgent({
                apiKey: anthropicKey,
                system: systemBlocks,
                messages,
                enableTools: true,
                signal: req.signal,
              });
              if (result.capped) {
                pushFeed("ORACLE", `Agent loop capped at ${result.turns} turns`);
              }
              for await (const chunk of stubStream(result.text)) push(chunk);
            } else {
              // Phase 2: streaming with cache_control on stable system block.
              await streamAnthropicCached({
                apiKey: anthropicKey,
                system: systemBlocks,
                messages,
                onText: (t) => push(t),
                signal: req.signal,
              });
            }
          } else if (ollamaUp && hasModel) {
            const localSystem = clipSystemForLocal(system);
            const localMessages = sanitizeMessagesForLocal(messages);
            await streamLocalWithCopyGuard({
              system: localSystem,
              messages: localMessages,
              lastUser,
              onText: (t) => push(t),
            });
          } else {
            const offline = ollamaUp
              ? `Ollama online but model ${ollamaModel} missing. Run: ollama pull ${ollamaModel}. Standing by.`
              : "Link degraded — start Ollama (`ollama serve`) or set ANTHROPIC_API_KEY. Two seed moves: DUNS at dnb.com, then Net-30s Uline Quill Grainger.";
            for await (const chunk of stubStream(offline)) push(chunk);
          }
        }

        if (full) {
          await recordExchange("assistant", stripThinkTags(full));
          // Durable-fact distillation (mem0-style, free driver) — fire-and-
          // forget: the stream is closing and must never wait on it.
          void extractFactsFromExchange(lastUser, stripThinkTags(full));
          addTokens(full.length);
          pushFeed("ORACLE", `Reply landed — ${full.length} chars`);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "link degraded";
        controller.enqueue(
          encoder.encode(sse(`Link degraded. ${msg}. Retry?`)),
        );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
