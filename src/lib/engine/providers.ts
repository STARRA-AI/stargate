/**
 * STARRA ENGINE — PROVIDER REGISTRY. The single source of truth for every
 * credential, endpoint and capability in the deck.
 *
 * ── SERVER-ONLY ────────────────────────────────────────────────────────────
 * This module and everything that imports it (config / router / health) resolve
 * real credentials. They must never reach a client bundle.
 *
 * WHY NOT `import "server-only"`: that package is NOT installed here — it only
 * exists privately inside next/dist/compiled, and adding a dependency is
 * forbidden by this build's constraints (verified: `import("server-only")`
 * fails with ERR_MODULE_NOT_FOUND under tsx, which is how the tests run). So the
 * engine ships the equivalent: assertServerOnly() throws loudly at module scope
 * if a browser ever evaluates this file. Same failure mode, zero dependencies.
 *
 * WHY THIS EXISTS AT ALL: every surface of the deck already had its own idea of
 * which key to read and which endpoint to call — brain, voice, realtime, mouth
 * and memory each guessed independently. One registry ends the guessing.
 */

/** Throw if a secret-bearing module is evaluated in a browser. */
export function assertServerOnly(where: string): void {
  if (typeof window !== "undefined") {
    throw new Error(
      `[engine] ${where} is server-only and must never be imported by a client component — ` +
        `it resolves credentials. Import "@/lib/engine/bus" on the client instead.`,
    );
  }
}

assertServerOnly("providers.ts");

// ── capabilities ───────────────────────────────────────────────────────────

export const CAPABILITIES = [
  "brain",
  "voice",
  "realtime",
  "lipsync",
  "memory",
  "vision",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const PROVIDER_IDS = [
  "groq",
  "xai",
  "anthropic",
  "ollama",
  "piper",
  "webspeech",
  "viseme-bank",
  "local-memory",
  "huggingface",
  "replicate",
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * ok           — configured AND a probe confirmed it answers
 * configured   — usable, not probed (or nothing to probe: local/browser)
 * missing-key  — declared a credential it does not have
 * unreachable  — probed and failed
 * disabled     — switched off by the operator, or a PAID provider not opted in
 */
export type ProviderStatus = "ok" | "configured" | "missing-key" | "unreachable" | "disabled";

export interface ProviderProbe {
  /**
   * Path appended to the provider's resolved base URL. NEVER carries a
   * credential — keys go in headers() only, because URLs land in logs.
   */
  path: string;
  /** Auth headers for the probe. The ONLY place a key may appear. */
  headers?: (key: string) => Record<string, string>;
}

export interface ProviderDef {
  id: ProviderId;
  /** Human label for the Options panel. */
  label: string;
  /** Capabilities this provider can serve. */
  capabilities: readonly Capability[];
  /** Env var names backing it, most-preferred first. Empty = needs no key. */
  envKeys: readonly string[];
  /** True = using it costs money. Refused unless explicitly enabled. */
  paid: boolean;
  /** True = runs on Classic's own machine / in the browser. Always free. */
  local: boolean;
  /** Default enabled state. MUST be false for every paid provider. */
  defaultEnabled: boolean;
  /** Fixed API base, when the provider has one. */
  baseUrl?: string;
  /** Env var that can override the base URL (self-hosted endpoints). */
  baseUrlEnv?: string;
  /** Fallback base when neither config nor env supplies one. */
  defaultBaseUrl?: string;
  probe?: ProviderProbe;
  /** Shown in Diagnostics so Classic knows what he is looking at. */
  notes: string;
}

const bearer = (key: string): Record<string, string> => ({
  Authorization: `Bearer ${key}`,
});

/**
 * Endpoints below are the ones this repo already calls in production code —
 * src/lib/llm/hosted.ts:29 (Groq base), :36 (xAI base), :81 (`/models` probe),
 * src/lib/llm/ollama.ts:9 (127.0.0.1:11434) and :26 (`/api/tags`),
 * src/app/api/tts/route.ts:28 (xAI TTS). Nothing here is invented.
 */
export const PROVIDERS: readonly ProviderDef[] = [
  {
    id: "groq",
    label: "Groq (Kimi K2)",
    capabilities: ["brain"],
    envKeys: ["GROQ_API_KEY"],
    paid: false,
    local: false,
    defaultEnabled: true,
    baseUrl: "https://api.groq.com/openai/v1",
    probe: { path: "/models", headers: bearer },
    notes: "Free daily-driver brain. First in the brain chain.",
  },
  {
    id: "xai",
    label: "xAI (Grok + Ara voice)",
    capabilities: ["brain", "voice", "realtime"],
    envKeys: ["XAI_API_KEY"],
    // Already covered by Classic's existing xAI subscription — not new spend.
    paid: false,
    local: false,
    defaultEnabled: true,
    baseUrl: "https://api.x.ai/v1",
    probe: { path: "/models", headers: bearer },
    notes: "Her voice (Ara TTS) and the realtime call. Also a brain fallback.",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    capabilities: ["brain"],
    envKeys: ["ANTHROPIC_API_KEY"],
    // Metered API — spend. Off until Classic says otherwise.
    paid: true,
    local: false,
    defaultEnabled: false,
    baseUrl: "https://api.anthropic.com",
    probe: {
      path: "/v1/models",
      headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    },
    notes: "PAID metered brain. Disabled: the router refuses it unless enabled.",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    capabilities: ["brain"],
    envKeys: [],
    paid: false,
    local: true,
    defaultEnabled: true,
    baseUrlEnv: "OLLAMA_BASE_URL",
    defaultBaseUrl: "http://127.0.0.1:11434",
    probe: { path: "/api/tags" },
    notes: "Free local brain — the floor the brain chain can always fall to.",
  },
  {
    id: "piper",
    label: "Piper (local TTS)",
    capabilities: ["voice"],
    envKeys: [],
    paid: false,
    local: true,
    defaultEnabled: true,
    notes: "Free on-device voice, in the browser. No endpoint to probe.",
  },
  {
    id: "webspeech",
    label: "Web Speech (browser)",
    capabilities: ["voice"],
    envKeys: [],
    paid: false,
    local: true,
    defaultEnabled: true,
    notes: "Last-resort voice so she is never silent.",
  },
  {
    id: "viseme-bank",
    label: "Viseme bank (local mouth sync)",
    capabilities: ["lipsync"],
    envKeys: [],
    paid: false,
    local: true,
    defaultEnabled: true,
    notes:
      "Free 2-D mouth patch driven by an AnalyserNode. The ONLY default lipsync path.",
  },
  {
    id: "local-memory",
    label: "Local memory (data/memory.json)",
    capabilities: ["memory"],
    envKeys: [],
    paid: false,
    local: true,
    defaultEnabled: true,
    notes: "Her working memory / summaries / archival, on disk.",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    capabilities: ["vision"],
    envKeys: ["HF_TOKEN"],
    paid: false,
    local: false,
    defaultEnabled: true,
    baseUrl: "https://huggingface.co",
    probe: { path: "/api/whoami-v2", headers: bearer },
    notes: "Free-tier inference for vision work.",
  },
  {
    id: "replicate",
    label: "Replicate (SadTalker lipsync)",
    capabilities: ["lipsync"],
    envKeys: ["REPLICATE_API_TOKEN"],
    paid: true,
    local: false,
    defaultEnabled: false,
    baseUrl: "https://api.replicate.com",
    probe: { path: "/v1/account", headers: bearer },
    notes:
      "PAID per-render lipsync. Disabled, absent from every default chain, and " +
      "never probed while disabled — a probe is a request, and a request is spend.",
  },
];

export const PAID_PROVIDER_IDS: readonly ProviderId[] = PROVIDERS.filter((p) => p.paid).map(
  (p) => p.id,
);

/**
 * MACHINE-CHECKED NO-SPEND INVARIANT. Classic's rule is not a comment: if
 * anyone ever ships a paid provider that defaults to on, the module refuses to
 * load and every route that touches the engine fails loudly and immediately.
 */
for (const p of PROVIDERS) {
  if (p.paid && p.defaultEnabled) {
    throw new Error(
      `[engine] NO-SPEND INVARIANT VIOLATED: paid provider "${p.id}" defaults to enabled.`,
    );
  }
}

const BY_ID = new Map<string, ProviderDef>(PROVIDERS.map((p) => [p.id, p]));

export function isProviderId(id: unknown): id is ProviderId {
  return typeof id === "string" && BY_ID.has(id);
}

export function isCapability(cap: unknown): cap is Capability {
  return typeof cap === "string" && (CAPABILITIES as readonly string[]).includes(cap);
}

export function getProvider(id: string): ProviderDef | undefined {
  return BY_ID.get(id);
}

/** Providers that can serve a capability, in registry order. */
export function providersFor(cap: Capability): readonly ProviderDef[] {
  return PROVIDERS.filter((p) => p.capabilities.includes(cap));
}

/** True when the provider declares a credential it needs. */
export function needsKey(def: ProviderDef): boolean {
  return def.envKeys.length > 0;
}

// ── health (shape only; ./health produces it, ./router consumes it) ─────────

export interface ProviderHealth {
  id: string;
  status: ProviderStatus;
  /** true = probe answered · false = probe failed · null = not probed. */
  reachable: boolean | null;
  /** Human, ALWAYS redacted, safe to render. */
  detail: string;
  checkedAt: number;
  /**
   * Convenience mirrors for the settings routes — same truth, friendlier names.
   * Optional so a hand-built health object (tests, fixtures) stays valid.
   */
  ok?: boolean;
  /** Round-trip of the probe, when one was actually made. */
  latencyMs?: number | null;
  /** Redacted failure text, or null when nothing failed. */
  error?: string | null;
}

export type HealthMap = Partial<Record<ProviderId, ProviderHealth>>;
