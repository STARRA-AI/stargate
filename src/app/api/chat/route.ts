import { buildSystemPrompt } from "@/lib/brain";
import { getTier1, serializeTier1 } from "@/lib/context/tier1";
import {
  getMemory,
  memoryForPrompt,
  recordExchange,
} from "@/lib/memory/store";
import { getVault, vaultForPrompt } from "@/lib/vault/store";
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

export const runtime = "nodejs";
export const maxDuration = 180;

type ChatMessage = { role: "user" | "assistant"; content: string };

function sse(text: string) {
  return `data: ${JSON.stringify({ text })}\n\n`;
}

async function* stubStream(message: string) {
  const chunks = message.match(/.{1,12}/g) ?? [message];
  for (const c of chunks) {
    yield c;
    await new Promise((r) => setTimeout(r, 12));
  }
}

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
  const body = (await req.json()) as { messages?: ChatMessage[] };
  const messages = body.messages ?? [];
  const lastUser =
    [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

  const [tier1, memory, vault] = await Promise.all([
    getTier1(),
    getMemory(),
    getVault(),
  ]);

  const packPreview = await readLatestPackPreview(2500);
  const { model: ollamaModel } = ollamaConfig();

  const system = buildSystemPrompt([
    serializeTier1(tier1),
    memoryForPrompt(memory, lastUser),
    vaultForPrompt(vault.docs, lastUser),
    packPreview
      ? `RECENT REPOMIX PREVIEW (truncated):\n${packPreview}`
      : 'RECENT REPOMIX PREVIEW: none — operator can say "pack the repo".',
    `RUNTIME: Prefer grounded STARRA canon. Local free model when Ollama is up (${ollamaModel}) with Fable-inspired reasoning scaffold.`,
  ]);

  if (lastUser) {
    await recordExchange("user", lastUser);
    addTokens(lastUser.length + system.length / 8);
    pushFeed("EXEC", `Operator: ${lastUser.slice(0, 70)}`);
  }

  const encoder = new TextEncoder();
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const prefer =
    (process.env.LLM_PROVIDER || "auto").toLowerCase() as
      | "auto"
      | "ollama"
      | "anthropic";

  const toolReply = lastUser ? await maybeToolReply(lastUser) : null;

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

          if (useOllama && ollamaUp && hasModel) {
            await streamOllama({
              system,
              messages,
              onText: (t) => push(t),
            });
            full = stripThinkTags(full);
          } else if (anthropicKey && prefer !== "ollama") {
            const Anthropic = (await import("@anthropic-ai/sdk")).default;
            const client = new Anthropic({ apiKey: anthropicKey });
            const response = await client.messages.create({
              model: "claude-sonnet-4-20250514",
              max_tokens: 1024,
              system,
              messages: messages.map((m) => ({
                role: m.role,
                content: m.content,
              })),
              stream: true,
            });

            for await (const event of response) {
              if (
                event.type === "content_block_delta" &&
                event.delta.type === "text_delta"
              ) {
                push(event.delta.text);
              }
            }
          } else if (ollamaUp && hasModel) {
            await streamOllama({
              system,
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
