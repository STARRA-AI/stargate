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
// Client-safe redactor (pure, no secrets, no server-only guard) — see the note at
// the throw site for why this is imported from the leaf module, not @/lib/engine.
import { redactSecrets } from "@/lib/engine/redact";

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

/**
 * Repetition penalties — sent ONLY where the provider documents them as real.
 * Verified live 2026-07-28 against each provider's own API reference:
 *
 * - Groq (`kimi` slot) — https://console.groq.com/docs/api-reference
 *   Both `frequency_penalty` and `presence_penalty` carry the note
 *   "This is not yet supported by any of our models." The request is accepted
 *   but the knob does NOTHING, so we never send it: a dead param would only
 *   buy false confidence. On Groq, anti-repetition is 100% the persona.
 *
 * - xAI (`grok` slot) — https://docs.x.ai/docs/api-reference, POST /v1/chat/completions
 *   `frequency_penalty`: "(Not supported by reasoning models)"
 *   `presence_penalty`:  "(Not supported by `grok-3` and reasoning models)"
 *   and https://docs.x.ai/docs/models lists grok-4.5 with
 *   `"features":{...,"reasoning":true,"reasoningEffortOptions":{...}}` —
 *   i.e. the slug in .env.local IS a reasoning model, so it gets NO penalties.
 *   A non-reasoning xAI slug (e.g. grok-4.20-non-reasoning) does get them.
 *
 * Values stay conservative on purpose: over-penalizing makes her word-avoidant
 * and incoherent, which reads as MORE stilted, not less.
 */
const PENALTY_FREQUENCY = 0.4;
const PENALTY_PRESENCE = 0.3;

/** Explicit "-non-reasoning" suffix wins; it contains "reasoning" as a substring. */
const NON_REASONING_SLUG = /non-reasoning/i;
/** Slugs xAI documents as reasoning models (penalties unsupported). */
const REASONING_SLUG = /reasoning|grok-3|grok-4\.5|grok-4\.3|grok-build|grok-code/i;

export function supportsPenalties(
  provider: HostedProvider,
  model: string,
): boolean {
  // Groq: documented as inert on every model — never send.
  if (provider !== "grok") return false;
  if (NON_REASONING_SLUG.test(model)) return true;
  return !REASONING_SLUG.test(model);
}

function penaltyBody(
  provider: HostedProvider,
  model: string,
): { frequency_penalty: number; presence_penalty: number } | Record<string, never> {
  return supportsPenalties(provider, model)
    ? { frequency_penalty: PENALTY_FREQUENCY, presence_penalty: PENALTY_PRESENCE }
    : {};
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

  const penalties = penaltyBody(opts.provider, model);

  const send = (withPenalties: boolean) =>
    fetch(`${cfg.base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        ...(withPenalties ? penalties : {}),
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

  let res = await send(true);

  // Graceful degradation: if a provider rejects the sampling knobs (slug moved
  // to a reasoning model, param retired), retry once WITHOUT them so the reply
  // still lands. Never let a tuning param be the reason she goes silent.
  if (!res.ok && res.status === 400 && Object.keys(penalties).length > 0) {
    res = await send(false);
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    // REDACT BEFORE TRUNCATING (2026-07-29). This Error message reaches the
    // browser via src/app/api/chat/route.ts (:418, :420, :426, :548), so a raw
    // upstream body from xAI/Groq — which can echo the Authorization header on
    // some 401/403 shapes — was rendering straight to Classic's screen. Same
    // defect the board ruled MAJOR for /api/realtime; this is the brain path,
    // which the first audit missed because its fetch lives here in a lib rather
    // than in a route.ts.
    //
    // Order matters: scrub FIRST, then truncate. Truncating first can split the
    // credential so the full-value match no longer fires, leaving a fragment of
    // a live key in the message.
    //
    // Imported from @/lib/engine/redact, NOT the @/lib/engine barrel: that barrel
    // is server-only, and this module is transitively in the CLIENT graph via
    // src/lib/keys.ts -> src/app/settings/page.tsx. redact.ts is pure and
    // client-safe, so it cannot break /app/settings.
    const safe = redactSecrets(detail, key ? [key] : []);
    throw new Error(`${opts.provider} ${res.status} ${safe.slice(0, 160)}`);
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
