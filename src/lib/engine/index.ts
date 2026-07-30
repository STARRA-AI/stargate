/**
 * STARRA ENGINE — public surface.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS FILE IS SERVER-ONLY. It re-exports the modules that resolve real     ║
 * ║ credentials (providers / config / router / health), so importing it from  ║
 * ║ a client component throws on purpose.                                    ║
 * ║                                                                          ║
 * ║ CLIENT CODE IMPORTS "@/lib/engine/bus" DIRECTLY — never "@/lib/engine".   ║
 * ║ The masking helpers in "@/lib/engine/redact" are also client-safe (pure). ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Layout:
 *   providers.ts  registry — every credential, endpoint and capability (SERVER)
 *   config.ts     data/engine.json read/write, 0600, mtime cache      (SERVER)
 *   router.ts     capability resolution + the paid invariant          (SERVER)
 *   health.ts     cheap, timeout-bounded probes, key in a header      (SERVER)
 *   redact.ts     masking / redaction                          (client-safe)
 *   bus.ts        live client state bus + React hook           (client-safe)
 */

import { assertServerOnly } from "./providers";

assertServerOnly("index.ts");

// ── SERVER-ONLY ────────────────────────────────────────────────────────────
export {
  CAPABILITIES,
  PAID_PROVIDER_IDS,
  PROVIDERS,
  PROVIDER_IDS,
  assertServerOnly,
  getProvider,
  isCapability,
  isProviderId,
  needsKey,
  providersFor,
  type Capability,
  type HealthMap,
  type ProviderDef,
  type ProviderHealth,
  type ProviderId,
  type ProviderProbe,
  type ProviderStatus,
} from "./providers";

export {
  DEFAULT_ENGINE_CONFIG,
  ENGINE_CONFIG_VERSION,
  __resetEngineConfigCache,
  collectSecretValues,
  deepMergeConfig,
  engineConfigPath,
  providerBaseUrl,
  readEngineConfig,
  resolveSecret,
  sanitizeEngineConfig,
  writeEngineConfig,
  // Short aliases the settings routes use. Same functions.
  readEngineConfig as readConfig,
  writeEngineConfig as writeConfig,
  type EngineConfig,
  type EngineConfigPatch,
  type EngineCosmetics,
  type EngineProviderConfig,
} from "./config";

export {
  activeProviderMap,
  describeProviders,
  evaluateProvider,
  listProviders,
  providerStatus,
  resolveAllCapabilities,
  resolveCapability,
  type ProviderVerdict,
  type PublicProviderView,
  type Resolution,
} from "./router";

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  diagnostics,
  probeAll,
  probeProvider,
  type BrokenItem,
  type EngineDiagnostics,
  type ProbeOptions,
} from "./health";

// ── CLIENT-SAFE (pure) ─────────────────────────────────────────────────────
export { hasKey, last4, maskKey, redactSecrets, redactUrl, safeErrorMessage } from "./redact";

// ── CLIENT-SAFE bus: TYPES ONLY here. Runtime import path is "@/lib/engine/bus"
// so no server module ever ends up in a client bundle by way of this barrel.
export type {
  EngineAffect,
  EngineBusError,
  EngineBusState,
  VoiceSource,
} from "./bus";
