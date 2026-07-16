import { buildSystemPromptBlocks } from "@/lib/brain";
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
  queueMontageJob,
  silentShadowTemplate,
} from "@/lib/tools/openmontage";
import {
  ollamaAvailable,
  ollamaHasModel,
  ollamaConfig,
  streamOllama,
  stripThinkTags,
} from "@/lib/llm/ollama";
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
const LOCAL_SYSTEM_BUDGET = 2_200;

const LOCAL_VOICE_TAIL = `
VOICE (hard): You are STARRA. Calm. Dry. Decisive.
Say "Copy." not "Sure!". No emoji. No "happy to help". Lead with the next move. Short sentences.
`.trim();

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
    const job = await queueMontageJob({
      brief: silentShadowTemplate(topic),
      pipeline: "silent-shadow-short",
    });
    return `Queued OpenMontage job ${job.id}. Brief on disk under data/openmontage-briefs/. Hand vendor/OpenMontage/AGENT_GUIDE.md to the agent to render. Standing by.`;
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

  const tPrompt = Date.now();
  // Phase 2: build once per request — stable canon reused from in-process cache;
  // volatile extras (memory/vault/pack) stay out of the Anthropic cache prefix.
  const systemBlocks = buildSystemPromptBlocks([
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
  ]);
  const system = systemBlocks.full;
  // #region agent log
  fetch("http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "f8c9f7",
    },
    body: JSON.stringify({
      sessionId: "f8c9f7",
      location: "chat/route.ts:POST",
      message: "chat request context",
      data: {
        model: ollamaModel,
        systemChars: system.length,
        stableChars: systemBlocks.stable.length,
        volatileChars: systemBlocks.volatile.length,
        lastUserChars: lastUser.length,
        promptBuildMs: Date.now() - tPrompt,
        prefer: (process.env.LLM_PROVIDER || "auto").toLowerCase(),
        ollamaPriority: process.env.OLLAMA_PRIORITY === "1",
        maxAgentTurns: MAX_AGENT_TURNS,
      },
      timestamp: Date.now(),
      hypothesisId: "H-C2",
      runId: "post-fix",
    }),
  }).catch(() => {});
  // #endregion

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
      | "anthropic";

  const toolReply = lastUser ? await maybeToolReply(lastUser) : null;
  const useAgentTools =
    body.agentTools === true || process.env.STARRA_AGENT_TOOLS === "1";

  const stream = new ReadableStream({
    async start(controller) {
      let full = "";
      const tStream = Date.now();
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

          // #region agent log
          fetch(
            "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Debug-Session-Id": "f8c9f7",
              },
              body: JSON.stringify({
                sessionId: "f8c9f7",
                location: "chat/route.ts:provider",
                message: "provider branch",
                data: {
                  ollamaUp,
                  hasModel,
                  useOllama,
                  hasAnthropic: Boolean(anthropicKey),
                  prefer,
                  model: ollamaModel,
                  useAgentTools,
                },
                timestamp: Date.now(),
                hypothesisId: "H-C4",
                runId: "post-fix",
              }),
            },
          ).catch(() => {});
          // #endregion

          if (useOllama && ollamaUp && hasModel) {
            const localSystem = clipSystemForLocal(system);
            // #region agent log
            fetch(
              "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Debug-Session-Id": "f8c9f7",
                },
                body: JSON.stringify({
                  sessionId: "f8c9f7",
                  location: "chat/route.ts:localClip",
                  message: "local system clip",
                  data: {
                    before: system.length,
                    after: localSystem.length,
                    clipped: localSystem.length < system.length,
                    model: ollamaModel,
                  },
                  timestamp: Date.now(),
                  hypothesisId: "H-C5",
                  runId: "post-fix",
                }),
              },
            ).catch(() => {});
            // #endregion
            await streamOllama({
              system: localSystem,
              messages,
              onText: (t) => push(t),
            });
            const beforeStrip = full.length;
            full = stripThinkTags(full);
            // #region agent log
            fetch(
              "http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Debug-Session-Id": "f8c9f7",
                },
                body: JSON.stringify({
                  sessionId: "f8c9f7",
                  location: "chat/route.ts:ollama",
                  message: "ollama stream complete",
                  data: {
                    model: ollamaModel,
                    beforeStripChars: beforeStrip,
                    afterStripChars: full.length,
                    emptyAfterStrip: full.length === 0,
                    streamMs: Date.now() - tStream,
                    preview: full.slice(0, 120),
                  },
                  timestamp: Date.now(),
                  hypothesisId: "H-C3",
                  runId: "post-fix",
                }),
              },
            ).catch(() => {});
            // #endregion
          } else if (anthropicKey && prefer !== "ollama") {
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
            await streamOllama({
              system: localSystem,
              messages,
              onText: (t) => push(t),
            });
            full = stripThinkTags(full);
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
