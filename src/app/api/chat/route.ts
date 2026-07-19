import { buildSystemPromptBlocks, buildTieredSystemPrompt } from "@/lib/brain";
import { getTier1, serializeTier1 } from "@/lib/context/tier1";
import {
  getMemory,
  memoryForPrompt,
  recordExchange,
} from "@/lib/memory/store";
import { getVault, vaultForPrompt } from "@/lib/vault/store";
import { obsidianForPrompt } from "@/lib/obsidian";
import { runRepomix, readLatestPackPreview } from "@/lib/tools/repomix";
import {
  briefForPipeline,
  queueMontageJob,
} from "@/lib/tools/openmontage";
import {
  ollamaAvailable,
  ollamaHasModel,
  ollamaConfig,
  streamOllama,
  stripThinkTags,
} from "@/lib/llm/ollama";
import { streamHosted, hostedAvailable } from "@/lib/llm/hosted";
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
VOICE (hard): You are STARRA — guardian and operator. Calm. Dry. Decisive.
You may open with "Copy." — then ALWAYS give the real answer in the same reply.
Forbidden final reply: only the word "Copy." (with or without a period).
Forbidden: repeating canned example lines — answer the operator's actual question.
Pattern: Copy. <one concrete move tied to what they asked>.
No "Sure!", no emoji, no "happy to help". Short sentences.
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
      ? "Copy. Brief queued — top move is LLM link check, then operator orders."
      : q.includes("status")
        ? "Copy. Link up. Ollama local. Standing by for your next order."
        : `Copy. Heard: ${(opts.lastUser || "status").slice(0, 48)}. State the objective and I execute.`;
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

  if (
    /\b(pack (the )?repo|repomix|pack codebase|dump (the )?repo)\b/.test(q)
  ) {
    const result = await runRepomix();
    if (!result.ok) {
      return `Repomix failed. ${result.error ?? "Unknown error"}. Retry from Tools.`;
    }
    return `Copy. Repo packed — ${result.bytes} bytes at ${result.outputPath}. Open Tools for preview.`;
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

export async function POST(req: Request) {
  const body = (await req.json()) as {
    messages?: ChatMessage[];
    /** When true, Anthropic path may use tool_use (bounded by MAX_AGENT_TURNS). */
    agentTools?: boolean;
  };
  const messages = body.messages ?? [];
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
  const volatileExtras = [
    threatVolatile,
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
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const prefer =
    (process.env.LLM_PROVIDER || "auto").toLowerCase() as
      | "auto"
      | "ollama"
      | "anthropic"
      | "kimi"
      | "grok";

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
        if (toolReply) {
          for await (const chunk of stubStream(toolReply)) push(chunk);
        } else {
          const ollamaUp = await ollamaAvailable();
          const hasModel = ollamaUp ? await ollamaHasModel() : false;
          const useOllama =
            prefer === "ollama" ||
            (prefer === "auto" && ollamaUp && hasModel && !anthropicKey) ||
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
          } else if (prefer === "kimi" && hostedAvailable("kimi")) {
            // Free Kimi (Groq) — tiered under the 8K free cap: always-on core
            // identity + on-demand doctrines/volatile budgeted to fit.
            const tiered = buildTieredSystemPrompt({
              query: lastUser,
              volatile: volatileExtras,
              includeUntrusted: Boolean(packPreview),
              includeSecurityTeam: !operatorScan.clean,
            });
            try {
              const r = await streamHosted({
                provider: "kimi",
                system: tiered.full,
                messages,
                onText: (t) => push(t),
              });
              pushFeed(
                "ORACLE",
                `Kimi brain — ${r.model} (~${tiered.tokens} tok, +${tiered.included.length - 1} ctx${tiered.dropped.length ? `, deferred: ${tiered.dropped.join(",")}` : ""})`,
              );
            } catch (err) {
              await localFallback("Kimi", err);
            }
          } else if (prefer === "grok" && hostedAvailable("grok")) {
            // xAI Grok — no TPM cap, send the full canon (identical assembly).
            try {
              const r = await streamHosted({
                provider: "grok",
                system,
                messages,
                onText: (t) => push(t),
              });
              pushFeed("ORACLE", `Grok brain — ${r.model}`);
            } catch (err) {
              await localFallback("Grok", err);
            }
          } else if (
            anthropicKey &&
            prefer !== "ollama" &&
            prefer !== "kimi" &&
            prefer !== "grok"
          ) {
            if (useAgentTools) {
              // Phase 0: bounded tool loop (non-stream rounds → stub stream final).
              const result = await runAnthropicAgent({
                apiKey: anthropicKey,
                system: systemBlocks,
                messages,
                enableTools: true,
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
