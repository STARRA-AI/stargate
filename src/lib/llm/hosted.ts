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
import { recordZdrHeader } from "@/lib/llm/zdr";
import { recordUsage } from "@/lib/llm/spend";

/**
 * TWO LANES, AND ONLY TWO. `grok` is her standing brain; `kimi` is the free
 * Groq slot kept as the emergency lane. `freellm` was removed 2026-08-06 with
 * Classic's ONE BRAIN order — a third hosted brain is a third Starra, which is
 * the exact defect that order exists to kill.
 */
export type HostedProvider = "kimi" | "grok";

/**
 * A hiccup, not an identity change.
 *
 * Thrown after the retries below are spent. The caller reports it or retries —
 * it must NEVER read this as a reason to hand the turn to a different brain.
 * Who is talking to Classic is a money decision (src/lib/llm/spend.ts) and his
 * decision, never a consequence of one bad response.
 */
export class HostedTransientError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HostedTransientError";
  }
}

/** Statuses worth trying again on the SAME provider. */
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
/** Backoff between attempts; length is also the retry count. */
const RETRY_DELAYS_MS = [400, 1200];

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
    // NOT kimi any more. Groq DELETED moonshotai/kimi-k2-instruct-0905 —
    // verified 2026-08-06 against the live /models list on this key (15 models,
    // no kimi among them). The old default only ever "worked" because
    // GROQ_MODEL in .env.local masked it; the first time that env var is not
    // loaded (fresh shell, launchd context, new machine) every brain call 404s.
    // On the CALL that failure used to be completely silent. So the default is
    // now a model that actually exists, and one with the headroom to hold her
    // whole canon: llama-3.3-70b-versatile measured 12000 TPM vs her 8,311-token
    // core. The lane keeps its historical "kimi" name — it is the free Groq
    // slot, not the Moonshot model.
    defaultModel: "llama-3.3-70b-versatile",
    // Must not still grep for /kimi/: nothing on Groq matches that now, so the
    // model picker would fall through to nothing.
    match: (id) => /^llama-3\.3|kimi/i.test(id),
  },
  grok: {
    base: "https://api.x.ai/v1",
    keyEnv: "XAI_API_KEY",
    modelEnv: "XAI_MODEL",
    // VERIFIED LIVE 2026-08-06 on Classic's key: GET https://api.x.ai/v1/models
    // returns grok-4.5 as a CONCRETE listed id (alongside grok-4.3,
    // grok-4.20-0309-reasoning, grok-4.20-0309-non-reasoning,
    // grok-4.20-multi-agent-0309, grok-build-0.1 and the imagine models) — it
    // is not an alias this config has to expand. Pinned here as the primary.
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
  if (!cfg.defaultModel) {
    // A lane with no documented default throws rather than inventing a slug
    // (verify-never-guess). Both current lanes carry one, so this is a guard
    // for the next lane added, not a live path.
    throw new Error(
      `${provider}: model unresolved — router unreachable at ${cfg.base} and no ${cfg.modelEnv} pin set`,
    );
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
  /** Explicit completion cap (wire max_tokens). TPM-capped lanes (kimi) MUST
   *  set it — Groq bills prompt + max_tokens against the limit, and omitting
   *  it reserves the model default. Omitted for grok: unchanged. */
  maxOutputTokens?: number;
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
        // Ask for the terminal usage frame so the spend meter prices REAL
        // counts instead of an estimate. VERIFIED LIVE 2026-08-06 against
        // POST https://api.x.ai/v1/chat/completions: the last data frame
        // before [DONE] carries usage.prompt_tokens,
        // usage.prompt_tokens_details.cached_tokens and
        // usage.completion_tokens_details.reasoning_tokens.
        stream_options: { include_usage: true },
        ...(opts.maxOutputTokens ? { max_tokens: opts.maxOutputTokens } : {}),
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

  // ── RETRY, NEVER SWAP ────────────────────────────────────────────────────
  // A rate limit or a server-side blip is a TRANSPORT problem. Every attempt
  // below goes back to the SAME provider: nothing in this function may reach
  // for another brain, because a stranger answering is a worse outcome than a
  // lost turn. Who talks to Classic changes for money (spend.ts) or for his
  // explicit order — never because one response came back unhappy.
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; ; attempt += 1) {
    lastErr = null;
    try {
      res = await send(true);
      // Graceful degradation: if a provider rejects the sampling knobs (slug
      // moved to a reasoning model, param retired), retry once WITHOUT them so
      // the reply still lands. Never let a tuning param be the reason she goes
      // silent.
      if (!res.ok && res.status === 400 && Object.keys(penalties).length > 0) {
        res = await send(false);
      }
    } catch (err) {
      // The caller hanging up is not a failure to retry through.
      if (opts.signal?.aborted) throw err;
      lastErr = err;
      res = null;
    }

    if (res && (res.ok || !RETRY_STATUSES.has(res.status))) break;

    if (attempt >= RETRY_DELAYS_MS.length) {
      if (res) {
        const detail = await res.text().catch(() => "");
        throw new HostedTransientError(
          res.status,
          `${opts.provider} ${res.status} ${redactSecrets(detail, key ? [key] : []).slice(0, 160)}`,
        );
      }
      throw new HostedTransientError(
        0,
        `${opts.provider} unreachable — ${redactSecrets(String(lastErr), key ? [key] : []).slice(0, 160)}`,
      );
    }
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }

  // PRIVACY, READ FROM THE WIRE. xAI states the live Zero-Data-Retention
  // setting on every response; recording it here is what lets the deck report
  // the truth instead of a remembered toggle. See src/lib/llm/zdr.ts.
  recordZdrHeader(opts.provider, res.headers.get("x-zero-data-retention"));

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
  let usage:
    | {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
        completion_tokens_details?: { reasoning_tokens?: number };
      }
    | undefined;
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
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            completion_tokens_details?: { reasoning_tokens?: number };
          };
        };
        const t = json.choices?.[0]?.delta?.content;
        if (t) opts.onText(t);
        if (json.usage) usage = json.usage;
      } catch {
        /* ignore partial JSON */
      }
    }
  }

  // METER THE TURN FROM WHAT THE PROVIDER ACTUALLY COUNTED.
  //
  // reasoning_tokens are billed as OUTPUT and are NOT included in
  // completion_tokens on xAI — verified live 2026-08-06: a turn reporting
  // prompt 207 / cached 128 / completion 1 / reasoning 23 carried
  // cost_in_usd_ticks 3404000 (= $0.0003404 at 1e-10 USD/tick), which matches
  // (79*$2.00 + 128*$0.30 + 24*$6.00)/1e6 to the cent-fraction only when the
  // 23 reasoning tokens are counted as output. Dropping them would under-report
  // her real cost by ~40% on a short turn.
  if (usage && opts.provider === "grok") {
    recordUsage(model, {
      prompt: usage.prompt_tokens ?? 0,
      cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
      completion:
        (usage.completion_tokens ?? 0) +
        (usage.completion_tokens_details?.reasoning_tokens ?? 0),
    });
  }
  return { provider: opts.provider, model };
}
