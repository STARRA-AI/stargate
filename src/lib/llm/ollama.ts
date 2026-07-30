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

async function fetchTags(
  timeoutMs: number,
): Promise<{ ok: boolean; models: { name: string }[] }> {
  const { base } = ollamaConfig();
  try {
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, models: [] };
    const data = (await res.json()) as { models?: { name: string }[] };
    return { ok: true, models: data.models ?? [] };
  } catch {
    return { ok: false, models: [] };
  }
}

function matchesModel(models: { name: string }[], target: string): boolean {
  return models.some(
    (m) =>
      m.name === target ||
      m.name.startsWith(`${target}`) ||
      m.name.startsWith(target.split(":")[0]!),
  );
}

export async function ollamaAvailable(): Promise<boolean> {
  const { ok } = await fetchTags(2000);
  return ok;
}

export async function ollamaHasModel(name?: string): Promise<boolean> {
  const { model } = ollamaConfig();
  const target = name || model;
  const { ok, models } = await fetchTags(3000);
  return ok ? matchesModel(models, target) : false;
}

/**
 * Combined status from a single /api/tags fetch — use this on hot paths
 * (chat route) that previously called ollamaAvailable() + ollamaHasModel()
 * back-to-back, doubling the request.
 */
export async function ollamaStatus(
  name?: string,
): Promise<{ up: boolean; hasModel: boolean }> {
  const { model } = ollamaConfig();
  const target = name || model;
  const { ok, models } = await fetchTags(3000);
  return { up: ok, hasModel: ok ? matchesModel(models, target) : false };
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
    throw new Error(errors.join(" | ") || "ollama failed");
  }
}

async function streamNativeChat(
  base: string,
  model: string,
  opts: { system: string; messages: ChatMessage[]; onText: (c: string) => void },
) {
  // 8GB Mac: smaller ctx = faster first token; keep replies short
  const numCtx = model.includes("deepseek-r1") ? 6144 : 4096;
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      stream: true,
      keep_alive: "5m",
      messages: [
        { role: "system", content: opts.system },
        ...opts.messages,
      ],
      options: {
        // Cap length so operator HUD feels snappy on CPU-only inference
        num_predict: model.includes("deepseek-r1") ? 384 : 220,
        temperature: model.includes("deepseek-r1") ? 0.4 : 0.4,
        num_ctx: numCtx,
        // Repetition control. Verified live 2026-07-28 against Ollama's own
        // "Valid Parameters and Values" table:
        // https://raw.githubusercontent.com/ollama/ollama/main/docs/modelfile.mdx
        //   repeat_penalty — "Sets how strongly to penalize repetitions."  (Default: 1.1)
        //   repeat_last_n  — "Sets how far back for the model to look back to
        //                     prevent repetition."                        (Default: 64, -1 = num_ctx)
        // Nudged just past the defaults: 1.15 discourages her recycling the
        // same stock phrases without pushing her into word-avoidance, and a
        // 256-token window spans a few turns instead of one short reply.
        // NOTE: Ollama exposes NO dry_multiplier/dry_base — the DRY sampler is
        // llama.cpp-only and is not available through this API.
        repeat_penalty: 1.15,
        repeat_last_n: 256,
      },
    }),
    signal: AbortSignal.timeout(75_000),
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
