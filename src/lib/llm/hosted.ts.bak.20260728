/**
 * Hosted OpenAI-compatible brains — free Kimi via Groq and Grok via xAI.
 * Both speak the OpenAI /chat/completions dialect, so one streamer serves both.
 * The STARRA canon + personality assembly is identical to every other provider:
 * the caller passes buildSystemPromptBlocks().full as `system`.
 *
 * Model slugs are resolved live from each provider's /models list at runtime
 * (cached per process), with an env override and a documented default so we
 * never hardcode a stale slug from memory.
 */

import type { ChatMessage } from "@/lib/llm/ollama";
import { getKey } from "@/lib/keys";

export type HostedProvider = "kimi" | "grok";

type HostedConfig = {
  base: string;
  keyEnv: string;
  modelEnv: string;
  /** Documented default — verified live 2026-07-18; runtime /models resolve wins. */
  defaultModel: string;
  /** Pick this provider's chat slug out of the /models list. */
  match: (id: string) => boolean;
};

const CONFIG: Record<HostedProvider, HostedConfig> = {
  kimi: {
    base: "https://api.groq.com/openai/v1",
    keyEnv: "GROQ_API_KEY",
    modelEnv: "GROQ_MODEL",
    defaultModel: "moonshotai/kimi-k2-instruct-0905",
    match: (id) => /kimi/i.test(id),
  },
  grok: {
    base: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    modelEnv: "XAI_MODEL",
    defaultModel: "grok-4.5",
    // General chat Grok only — exclude vision/image/voice/tts/build/code/fast.
    match: (id) =>
      /^grok/i.test(id) &&
      !/(vision|image|imagine|voice|tts|whisper|embedding|build|code|fast)/i.test(id),
  },
};

/** Vault slot backing each hosted provider — getKey() falls back to process.env. */
const KEY_SLOT: Record<HostedProvider, "groq" | "xai"> = {
  kimi: "groq",
  grok: "xai",
};

export async function hostedKey(
  provider: HostedProvider,
): Promise<string | undefined> {
  return getKey(KEY_SLOT[provider]);
}

export async function hostedAvailable(
  provider: HostedProvider,
): Promise<boolean> {
  return Boolean(await hostedKey(provider));
}

/** Cache resolved slugs so we hit /models at most once per provider per process. */
const modelCache: Partial<Record<HostedProvider, string>> = {};

export async function resolveHostedModel(
  provider: HostedProvider,
): Promise<string> {
  const cfg = CONFIG[provider];
  // Explicit operator override always wins.
  const override = process.env[cfg.modelEnv];
  if (override) return override;
  const cached = modelCache[provider];
  if (cached) return cached;

  const key = await hostedKey(provider);
  if (key) {
    try {
      const res = await fetch(`${cfg.base}/models`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = (await res.json()) as { data?: { id: string }[] };
        const matches = (data.data ?? []).map((m) => m.id).filter(cfg.match);
        // Prefer the documented default when the provider still lists it;
        // otherwise the newest by sort (dated variants sort last, …-0905 > …-0711).
        const picked = matches.includes(cfg.defaultModel)
          ? cfg.defaultModel
          : matches.sort()[matches.length - 1];
        if (picked) {
          modelCache[provider] = picked;
          return picked;
        }
      }
    } catch {
      /* fall through to documented default */
    }
  }
  modelCache[provider] = cfg.defaultModel;
  return cfg.defaultModel;
}

/** Stream a hosted OpenAI-compatible chat completion. Mirrors ollama.ts streamOpenAICompat. */
export async function streamHosted(opts: {
  provider: HostedProvider;
  system: string;
  messages: ChatMessage[];
  onText: (chunk: string) => void;
  /** Caller-side abort (e.g. the inbound request closing) — combined with the fixed timeout below. */
  signal?: AbortSignal;
}): Promise<{ provider: string; model: string }> {
  const cfg = CONFIG[opts.provider];
  const key = await hostedKey(opts.provider);
  if (!key) throw new Error(`${cfg.keyEnv} not set`);
  const model = await resolveHostedModel(opts.provider);

  const res = await fetch(`${cfg.base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      stream: true,
      messages: [
        { role: "system", content: opts.system },
        ...opts.messages,
      ],
    }),
    signal: AbortSignal.any(
      [opts.signal, AbortSignal.timeout(120_000)].filter(
        (s): s is AbortSignal => Boolean(s),
      ),
    ),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${opts.provider} ${res.status} ${detail.slice(0, 160)}`);
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
      if (!payload || payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const t = json.choices?.[0]?.delta?.content;
        if (t) opts.onText(t);
      } catch {
        /* ignore partial JSON */
      }
    }
  }
  return { provider: opts.provider, model };
}
