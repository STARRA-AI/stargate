/**
 * STARRA ENGINE — RUNTIME CONFIG STORE (data/engine.json). SERVER-ONLY.
 *
 * WHY A JSON FILE AND NOT .env.local: Next bakes process.env at boot, so a
 * settings UI that only wrote .env.local would need a server restart to take
 * effect — useless for a deck Classic is tuning live. So .env.local stays the
 * BOOTSTRAP DEFAULT and is never rewritten; data/engine.json is the live
 * override, read per-request with an mtime cache.
 *
 * SECRET RESOLUTION ORDER: keyOverride (engine.json) → process.env → unset.
 *
 * The file holds credentials, so: mode 0600, gitignored (verified: .gitignore:66
 * `/data/` already covers data/engine.json — `git check-ignore -v` confirms),
 * and its contents never leave the server except through ./router's masked view.
 */

import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import {
  CAPABILITIES,
  PROVIDERS,
  assertServerOnly,
  getProvider,
  isProviderId,
  type Capability,
  type ProviderId,
} from "./providers";

assertServerOnly("config.ts");

// ── types ──────────────────────────────────────────────────────────────────

export interface EngineProviderConfig {
  enabled: boolean;
  /** Operator-supplied key. Wins over process.env. NEVER leaves the server. */
  keyOverride?: string;
  /** Endpoint override, for providers that have one (Ollama). */
  baseUrl?: string;
}

export interface EngineCosmetics {
  /** 0–360, applied as a CSS custom property — no rebuild. */
  accentHue: number;
  glowIntensity: number;
  reduceMotion: boolean;
  /** Idle clip pool for her face. */
  idlePool: string[];
  /** Master switch for the free local mouth sync. */
  mouthSync: boolean;
  fontScale: number;
  /**
   * Which body her face plays.
   *
   * "still" — base_loop.mp4 forever plus the composited viseme mouth. Her body
   *           does not move, but her speech is really SYNCED to her words.
   * "alive" — the 832x1248 anchor family: she nods, glances, tilts, laughs and
   *           raises an eyebrow between turns. Her mouth then moves on her real
   *           talking footage, which is photoreal but NOT synced to the words.
   *
   * Defaults to "still" so this landing changes nothing about his deck. See
   * ALIVE_POOL in src/lib/voice/starra-clip-map.ts for the measurement.
   */
  bodyMode: "still" | "alive";
}

export interface EngineConfig {
  version: number;
  providers: Partial<Record<ProviderId, EngineProviderConfig>>;
  capabilities: Record<Capability, ProviderId[]>;
  cosmetics: EngineCosmetics;
}

/** What a caller may hand to writeEngineConfig / deepMergeConfig. */
export interface EngineConfigPatch {
  version?: number;
  providers?: Partial<Record<ProviderId, Partial<EngineProviderConfig>>>;
  capabilities?: Partial<Record<Capability, ProviderId[]>>;
  cosmetics?: Partial<EngineCosmetics>;
}

export const ENGINE_CONFIG_VERSION = 1;

// ── defaults ───────────────────────────────────────────────────────────────

/**
 * DEFAULT CHAINS. Free first, local floor before anything paid, and NO paid
 * provider in any chain (asserted by tests and by the invariant below).
 */
const DEFAULT_CAPABILITY_CHAINS: Record<Capability, ProviderId[]> = {
  brain: ["groq", "xai", "ollama"],
  voice: ["xai", "piper", "webspeech"],
  realtime: ["xai"],
  lipsync: ["viseme-bank"],
  memory: ["local-memory"],
  vision: ["huggingface"],
};

const DEFAULT_COSMETICS: EngineCosmetics = {
  /**
   * MEASURED, not invented: src/app/globals.css:7 ships `--purple: #a855f7`,
   * which is hsl(271 91% 65%) — hue 270.7, rounded to 271. Defaulting to the
   * shipped hue means opening Options cannot shift the deck's colour.
   */
  accentHue: 271,
  glowIntensity: 1,
  reduceMotion: false,
  /** The three vetted idle clips — src/lib/voice/starra-clip-map.ts:27-29. */
  idlePool: ["idle_a1", "idle_c1", "idle_a2"],
  mouthSync: true,
  fontScale: 1,
  /** Unchanged behaviour by default — "alive" is opt-in. */
  bodyMode: "still",
};

function defaultProviders(): Partial<Record<ProviderId, EngineProviderConfig>> {
  const out: Partial<Record<ProviderId, EngineProviderConfig>> = {};
  for (const p of PROVIDERS) out[p.id] = { enabled: p.defaultEnabled };
  return out;
}

function freshDefaults(): EngineConfig {
  return {
    version: ENGINE_CONFIG_VERSION,
    providers: defaultProviders(),
    capabilities: {
      brain: [...DEFAULT_CAPABILITY_CHAINS.brain],
      voice: [...DEFAULT_CAPABILITY_CHAINS.voice],
      realtime: [...DEFAULT_CAPABILITY_CHAINS.realtime],
      lipsync: [...DEFAULT_CAPABILITY_CHAINS.lipsync],
      memory: [...DEFAULT_CAPABILITY_CHAINS.memory],
      vision: [...DEFAULT_CAPABILITY_CHAINS.vision],
    },
    cosmetics: { ...DEFAULT_COSMETICS, idlePool: [...DEFAULT_COSMETICS.idlePool] },
  };
}

/** Frozen reference copy. Callers get their own clone from freshDefaults(). */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = freshDefaults();

// NO-SPEND INVARIANT, second gate: nothing paid may be on, or in a chain, by
// default. Fails at import rather than at runtime in front of Classic.
for (const p of PROVIDERS) {
  if (p.paid && DEFAULT_ENGINE_CONFIG.providers[p.id]?.enabled) {
    throw new Error(`[engine] default config enables paid provider "${p.id}"`);
  }
}
for (const [cap, chain] of Object.entries(DEFAULT_ENGINE_CONFIG.capabilities)) {
  for (const id of chain) {
    if (getProvider(id)?.paid) {
      throw new Error(`[engine] default ${cap} chain contains paid provider "${id}"`);
    }
  }
}

// ── sanitize (pure, total — never throws) ──────────────────────────────────

const RawProviderSchema = z
  .object({
    enabled: z.boolean().optional().catch(undefined),
    keyOverride: z.string().optional().catch(undefined),
    baseUrl: z.string().optional().catch(undefined),
  })
  .catch({});

/**
 * THE ONE COSMETICS RANGE. Mirrored by the API projection
 * (src/app/api/engine/_shared.ts COSMETIC_BOUNDS) and asserted equal by
 * tests/engine-minors-cosmetics-bounds.test.ts.
 *
 * WHY THESE NUMBERS, and why this file used to hold WIDER ones. The store
 * previously accepted glowIntensity up to 3 and fontScale 0.5-2 while the
 * projection's `cosmeticsSchema` capped them at 1.6 and 0.85-1.35. A hand-edited
 * or migrated data/engine.json holding glowIntensity 2.0 therefore passed sanitize
 * untouched, then failed the projection's schema — which reset the WHOLE cosmetics
 * object to defaults and silently threw away every other setting, accentHue
 * included. The wide range had no consumer to justify it: the panel clamps to
 * 0-1.6 / 0.85-1.35 before writing a CSS variable (OptionsPanel.tsx:133-134) and
 * the client hook clamps to the same numbers (useCosmetics.ts:80-84). So the
 * NARROW, UI-safe range is now the single source of truth, here and there.
 */
export const COSMETIC_BOUNDS = {
  accentHue: [0, 360],
  glowIntensity: [0, 1.6],
  fontScale: [0.85, 1.35],
} as const;

/**
 * Bounds are applied by CLAMPING, not by dropping the field. An out-of-range
 * number is a value Classic (or a migration) meant something by — the nearest
 * legal value honours it. A NON-number is meaningless and falls back to its own
 * default; `"off"` must never coerce to 0.
 */
function clampCosmetic(
  v: unknown,
  key: keyof typeof COSMETIC_BOUNDS,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  const [lo, hi] = COSMETIC_BOUNDS[key];
  return v < lo ? lo : v > hi ? hi : v;
}

// Ranged numerics are accepted UNBOUNDED here on purpose: a `.min()/.max()` would
// make `.catch(undefined)` DROP an out-of-range value, and dropping is the
// behaviour this change exists to remove. The clamp below is the bound.
const RawCosmeticsSchema = z
  .object({
    accentHue: z.number().optional().catch(undefined),
    glowIntensity: z.number().optional().catch(undefined),
    reduceMotion: z.boolean().optional().catch(undefined),
    idlePool: z.array(z.string()).min(1).optional().catch(undefined),
    mouthSync: z.boolean().optional().catch(undefined),
    fontScale: z.number().optional().catch(undefined),
  })
  .catch({});

const RawConfigSchema = z.object({
  version: z.number().int().optional().catch(undefined),
  providers: z.record(z.string(), RawProviderSchema).optional().catch(undefined),
  capabilities: z
    .record(z.string(), z.array(z.string()).catch([]))
    .optional()
    .catch(undefined),
  cosmetics: RawCosmeticsSchema.optional().catch(undefined),
});

function trimmed(v: string | undefined): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/**
 * Turn ANYTHING into a valid EngineConfig. A malformed field falls back to its
 * own default; the good fields around it survive. Never throws — a corrupt
 * settings file must not take her offline.
 */
export function sanitizeEngineConfig(raw: unknown): EngineConfig {
  const out = freshDefaults();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

  const parsed = RawConfigSchema.safeParse(raw);
  if (!parsed.success) return out;
  const data = parsed.data;

  if (typeof data.version === "number") out.version = data.version;

  for (const [id, entry] of Object.entries(data.providers ?? {})) {
    if (!isProviderId(id)) continue; // unknown provider ids are dropped
    const base = out.providers[id] ?? { enabled: getProvider(id)?.defaultEnabled ?? false };
    const next: EngineProviderConfig = { enabled: base.enabled };
    if (typeof entry.enabled === "boolean") next.enabled = entry.enabled;
    const key = trimmed(entry.keyOverride);
    if (key) next.keyOverride = key;
    const url = trimmed(entry.baseUrl);
    if (url) next.baseUrl = url;
    out.providers[id] = next;
  }

  for (const [cap, chain] of Object.entries(data.capabilities ?? {})) {
    if (!(CAPABILITIES as readonly string[]).includes(cap)) continue;
    const capability = cap as Capability;
    const filtered = chain.filter(
      (id): id is ProviderId =>
        isProviderId(id) && (getProvider(id)?.capabilities.includes(capability) ?? false),
    );
    const deduped = [...new Set(filtered)];
    // An empty or fully-invalid chain is worse than useless — it would make the
    // capability unroutable. Fall back to the shipped chain.
    if (deduped.length > 0) out.capabilities[capability] = deduped;
  }

  // CLAMP, never wipe: one out-of-range cosmetic may not cost him the rest.
  const cos = data.cosmetics ?? {};
  out.cosmetics.accentHue = Math.round(
    clampCosmetic(cos.accentHue, "accentHue", DEFAULT_COSMETICS.accentHue),
  );
  out.cosmetics.glowIntensity = clampCosmetic(
    cos.glowIntensity,
    "glowIntensity",
    DEFAULT_COSMETICS.glowIntensity,
  );
  out.cosmetics.fontScale = clampCosmetic(
    cos.fontScale,
    "fontScale",
    DEFAULT_COSMETICS.fontScale,
  );
  if (typeof cos.reduceMotion === "boolean") out.cosmetics.reduceMotion = cos.reduceMotion;
  if (Array.isArray(cos.idlePool) && cos.idlePool.length > 0) {
    out.cosmetics.idlePool = cos.idlePool.filter((s) => typeof s === "string" && s.length > 0);
    if (out.cosmetics.idlePool.length === 0) {
      out.cosmetics.idlePool = [...DEFAULT_COSMETICS.idlePool];
    }
  }
  if (typeof cos.mouthSync === "boolean") out.cosmetics.mouthSync = cos.mouthSync;

  return out;
}

/** Merge a partial patch onto a config. Pure — never mutates either input. */
export function deepMergeConfig(base: EngineConfig, patch: EngineConfigPatch): EngineConfig {
  const merged: EngineConfig = {
    version: patch.version ?? base.version,
    providers: {},
    capabilities: { ...base.capabilities },
    cosmetics: { ...base.cosmetics, idlePool: [...base.cosmetics.idlePool] },
  };

  for (const [id, entry] of Object.entries(base.providers)) {
    if (entry) merged.providers[id as ProviderId] = { ...entry };
  }
  for (const [id, entry] of Object.entries(patch.providers ?? {})) {
    if (!isProviderId(id) || !entry) continue;
    const prev = merged.providers[id] ?? {
      enabled: getProvider(id)?.defaultEnabled ?? false,
    };
    merged.providers[id] = { ...prev, ...entry };
  }
  for (const [cap, chain] of Object.entries(patch.capabilities ?? {})) {
    if ((CAPABILITIES as readonly string[]).includes(cap) && Array.isArray(chain)) {
      merged.capabilities[cap as Capability] = [...chain];
    }
  }
  if (patch.cosmetics) {
    merged.cosmetics = { ...merged.cosmetics, ...patch.cosmetics };
    if (patch.cosmetics.idlePool) merged.cosmetics.idlePool = [...patch.cosmetics.idlePool];
  }
  return merged;
}

// ── disk ───────────────────────────────────────────────────────────────────

/**
 * Path to the store. STARRA_ENGINE_CONFIG_PATH exists so tests (and a future
 * multi-profile deck) can point somewhere else; it is read server-side only.
 */
export function engineConfigPath(): string {
  const override = trimmed(process.env.STARRA_ENGINE_CONFIG_PATH);
  return override ?? path.join(process.cwd(), "data", "engine.json");
}

type CacheEntry = { path: string; mtimeMs: number; size: number; value: EngineConfig };
let cache: CacheEntry | null = null;

/** Test/hot-reload hook — drops the mtime cache. */
export function __resetEngineConfigCache(): void {
  cache = null;
}

/**
 * Read the live config. Cheap on the hot path: one stat, and a parse only when
 * the file actually changed. Absent or corrupt file → defaults, never a throw.
 */
export async function readEngineConfig(): Promise<EngineConfig> {
  const file = engineConfigPath();
  try {
    const st = await fs.stat(file);
    if (
      cache &&
      cache.path === file &&
      cache.mtimeMs === st.mtimeMs &&
      cache.size === st.size
    ) {
      return cache.value;
    }
    const raw = await fs.readFile(file, "utf8");
    let value: EngineConfig;
    try {
      value = sanitizeEngineConfig(JSON.parse(raw));
    } catch {
      value = freshDefaults(); // corrupt JSON: fall back, stay up
    }
    cache = { path: file, mtimeMs: st.mtimeMs, size: st.size, value };
    return value;
  } catch {
    // No file yet (the normal first-run state) or unreadable — defaults.
    return freshDefaults();
  }
}

/**
 * Apply a patch and persist it at 0600. Atomic (temp file + rename) so a crash
 * mid-write can never leave a half-written settings file behind. Returns the
 * config that is now live.
 */
export async function writeEngineConfig(patch: EngineConfigPatch): Promise<EngineConfig> {
  const file = engineConfigPath();
  const current = await readEngineConfig();
  const next = sanitizeEngineConfig(deepMergeConfig(current, patch));
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
  try {
    await fs.chmod(file, 0o600); // rename keeps the temp mode; belt and braces
  } catch {
    /* a filesystem without chmod must not fail the save */
  }
  __resetEngineConfigCache();
  return next;
}

// ── secrets ────────────────────────────────────────────────────────────────

/** Resolved endpoint for a provider: config → env → registry default. */
export function providerBaseUrl(cfg: EngineConfig, id: ProviderId): string | undefined {
  const def = getProvider(id);
  if (!def) return undefined;
  const fromCfg = trimmed(cfg.providers[id]?.baseUrl);
  if (fromCfg) return fromCfg.replace(/\/+$/, "");
  const fromEnv = def.baseUrlEnv ? trimmed(process.env[def.baseUrlEnv]) : undefined;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  const fallback = def.baseUrl ?? def.defaultBaseUrl;
  return fallback ? fallback.replace(/\/+$/, "") : undefined;
}

/**
 * THE ONLY place the operator's pasted key is read out of data/engine.json.
 * Both resolvers in the deck go through this one function:
 *   • resolveSecret()          — the engine's sync path (router / health / probes)
 *   • lib/keys.ts getKey()     — the path VOICE, REALTIME and BRAIN actually use
 * Keeping it in one function is the whole point: two readers is how the panel
 * ended up saying "saved" while her voice kept the old key.
 */
export function resolveKeyOverride(cfg: EngineConfig, id: ProviderId): string | undefined {
  if (!getProvider(id)) return undefined;
  return trimmed(cfg.providers[id]?.keyOverride);
}

/**
 * The override for an arbitrary id string, read from the live config. This is
 * the seam lib/keys.ts calls across (it deals in KeySlotId, not ProviderId).
 *
 * TOTAL BY CONTRACT: an id the registry does not know, an absent file, a corrupt
 * file — all return undefined. It NEVER throws and NEVER rejects, because the
 * caller is on the path to her voice.
 */
export async function resolveKeyOverrideById(id: string): Promise<string | undefined> {
  try {
    if (!isProviderId(id)) return undefined;
    return resolveKeyOverride(await readEngineConfig(), id);
  } catch {
    return undefined;
  }
}

/**
 * A credential as the ENGINE sees it. Order: keyOverride → process.env →
 * undefined. Returns the plaintext key, so every caller is server-side and must
 * never pass the result anywhere near a response body.
 *
 * NOTE the deliberate asymmetry with getKey(): this sync path cannot read
 * data/keys.json (that needs I/O). getKey() is the superset — see the residual
 * risk note in lib/keys.ts.
 */
export function resolveSecret(cfg: EngineConfig, id: ProviderId): string | undefined {
  const def = getProvider(id);
  if (!def) return undefined;
  const override = resolveKeyOverride(cfg, id);
  if (override) return override;
  for (const envKey of def.envKeys) {
    const v = trimmed(process.env[envKey]);
    if (v) return v;
  }
  return undefined;
}

/**
 * Every credential value the engine currently knows about — the input to
 * redactSecrets() so an opaque key with no recognisable shape still cannot
 * survive a log line or an error message.
 */
export function collectSecretValues(cfg: EngineConfig): string[] {
  const out = new Set<string>();
  for (const def of PROVIDERS) {
    const override = trimmed(cfg.providers[def.id]?.keyOverride);
    if (override && override.length >= 8) out.add(override);
    for (const envKey of def.envKeys) {
      const v = trimmed(process.env[envKey]);
      if (v && v.length >= 8) out.add(v);
    }
  }
  // Non-provider secrets that must also never appear in engine output.
  for (const extra of ["STARRA_PASSWORD"]) {
    const v = trimmed(process.env[extra]);
    if (v && v.length >= 8) out.add(v);
  }
  return [...out].sort((a, b) => b.length - a.length);
}
