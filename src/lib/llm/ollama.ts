/**
 * Ollama provider — native /api/chat (best for deepseek-r1 thinking),
 * then Anthropic Messages compat, then OpenAI chat compat.
 * Default: deepseek-r1:1.5b (reasoning-oriented, fits ~8GB Mac).
 */

export type ChatMessage = { role: "user" | "assistant"; content: string };

const DEFAULT_BASE = "http://127.0.0.1:11434";
/** Instruction-tuned 1.5B — most reliable free HUD brain on 8GB Mac.
 *  Optional reasoning specialist: deepseek-r1:1.5b (set OLLAMA_MODEL). */
const DEFAULT_MODEL = "qwen2.5:1.5b";

export function ollamaConfig() {
  return {
    base: (process.env.OLLAMA_BASE_URL || DEFAULT_BASE).replace(/\/$/, ""),
    model: process.env.OLLAMA_MODEL || DEFAULT_MODEL,
  };
}

export async function ollamaAvailable(): Promise<boolean> {
  const { base } = ollamaConfig();
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ollamaHasModel(name?: string): Promise<boolean> {
  const { base, model } = ollamaConfig();
  const target = name || model;
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).some(
      (m) =>
        m.name === target ||
        m.name.startsWith(`${target}`) ||
        m.name.startsWith(target.split(":")[0]!),
    );
  } catch {
    return false;
  }
}

/** Strip DeepSeek-R1 style think blocks from operator-facing text. */
export function stripThinkTags(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\/?think>/gi, "")
    .trim();
}

export async function streamOllama(opts: {
  system: string;
  messages: ChatMessage[];
  onText: (chunk: string) => void;
}): Promise<{ provider: string; model: string }> {
  const { base, model } = ollamaConfig();
  const errors: string[] = [];

  // Native path handles R1 "thinking" vs "content" correctly
  try {
    await streamNativeChat(base, model, opts);
    return { provider: "ollama-native", model };
  } catch (err) {
    errors.push(`native:${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await streamAnthropicCompat(base, model, opts);
    return { provider: "ollama-anthropic", model };
  } catch (err) {
    errors.push(`anthropic:${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await streamOpenAICompat(base, model, opts);
    return { provider: "ollama-openai", model };
  } catch (err) {
    errors.push(`openai:${err instanceof Error ? err.message : String(err)}`);
    // #region agent log
    fetch("http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "f8c9f7",
      },
      body: JSON.stringify({
        sessionId: "f8c9f7",
        location: "ollama.ts:streamOllama",
        message: "all ollama providers failed",
        data: { model, systemChars: opts.system.length, errors },
        timestamp: Date.now(),
        hypothesisId: "H-C3",
        runId: "pre",
      }),
    }).catch(() => {});
    // #endregion
    throw new Error(errors.join(" | ") || "ollama failed");
  }
}

async function streamNativeChat(
  base: string,
  model: string,
  opts: { system: string; messages: ChatMessage[]; onText: (c: string) => void },
) {
  // 8GB Mac: keep ctx modest; oversized system prompts were hanging at 0 tokens
  const numCtx = model.includes("deepseek-r1") ? 8192 : 6144;
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: opts.system },
        ...opts.messages,
      ],
      options: {
        // R1 burns predict budget on thinking — give headroom when using deepseek
        num_predict: model.includes("deepseek-r1") ? 512 : 160,
        temperature: model.includes("deepseek-r1") ? 0.4 : 0.45,
        num_ctx: numCtx,
      },
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!res.ok || !res.body) {
    throw new Error(`ollama native ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let emitted = 0;
  let lastThinking = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const json = JSON.parse(trimmed) as {
          message?: { content?: string; thinking?: string };
          done?: boolean;
        };
        const content = json.message?.content ?? "";
        if (json.message?.thinking) {
          lastThinking = json.message.thinking;
        }
        if (content) {
          opts.onText(content);
          emitted += content.length;
        }
        if (json.done && emitted === 0 && lastThinking) {
          // Model spent budget on thinking only — surface a terse fallback
          const fallback = extractFinalFromThinking(lastThinking);
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
                location: "ollama.ts:streamNativeChat",
                message: "thinking-only fallback",
                data: {
                  model,
                  thinkingChars: lastThinking.length,
                  fallbackChars: fallback?.length ?? 0,
                  fallbackPreview: (fallback ?? "").slice(0, 100),
                },
                timestamp: Date.now(),
                hypothesisId: "H-C3",
                runId: "pre",
              }),
            },
          ).catch(() => {});
          // #endregion
          if (fallback) opts.onText(fallback);
        }
      } catch {
        /* ignore partial JSON */
      }
    }
  }
}

function extractFinalFromThinking(thinking: string): string {
  const cleaned = thinking.trim();
  // Prefer last short declarative sentence
  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && s.length < 280);
  const last = sentences[sentences.length - 1];
  if (last) return last;
  return "Processing complete. Standing by.";
}

async function streamAnthropicCompat(
  base: string,
  model: string,
  opts: { system: string; messages: ChatMessage[]; onText: (c: string) => void },
) {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "ollama",
      Authorization: "Bearer ollama",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      stream: true,
      system: opts.system,
      messages: opts.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`ollama anthropic ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      for (const line of part.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as {
            type?: string;
            delta?: { type?: string; text?: string };
          };
          if (
            json.type === "content_block_delta" &&
            json.delta?.type === "text_delta" &&
            json.delta.text
          ) {
            opts.onText(json.delta.text);
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
}

async function streamOpenAICompat(
  base: string,
  model: string,
  opts: { system: string; messages: ChatMessage[]; onText: (c: string) => void },
) {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer ollama",
    },
    body: JSON.stringify({
      model,
      stream: true,
      max_tokens: 1024,
      messages: [
        { role: "system", content: opts.system },
        ...opts.messages,
      ],
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`ollama openai ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const t = json.choices?.[0]?.delta?.content;
        if (t) opts.onText(t);
      } catch {
        /* ignore */
      }
    }
  }
}
