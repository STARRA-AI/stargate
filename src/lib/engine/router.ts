/**
 * STARRA ENGINE — CAPABILITY ROUTER. SERVER-ONLY.
 *
 * One ordered chain per capability. Resolution picks the first provider that is
 * ENABLED and CONFIGURED and (if a probe result exists) HEALTHY, and reports WHY
 * — so the deck can show what is actually live instead of guessing.
 *
 * Two hard rules:
 *   1. IT DEGRADES, IT NEVER THROWS. Brain ends at local Ollama, voice ends at
 *      Web Speech, lipsync ends at the local viseme bank. A silent STARRA is a
 *      catastrophe; a downgraded one is fine.
 *   2. THE PAID INVARIANT. A provider marked paid:true is refused unless the
 *      operator set enabled:true for it explicitly. Not a comment — a branch.
 */

import {
  CAPABILITIES,
  PROVIDERS,
  assertServerOnly,
  getProvider,
  needsKey,
  type Capability,
  type HealthMap,
  type ProviderDef,
  type ProviderId,
  type ProviderStatus,
} from "./providers";
import { readEngineConfig, resolveSecret, type EngineConfig } from "./config";
import { hasKey, last4 } from "./redact";

assertServerOnly("router.ts");

export interface ProviderVerdict {
  id: ProviderId;
  ok: boolean;
  /** Human, safe to render — never contains a credential. */
  reason: string;
  status: ProviderStatus;
  /** Mirror of `ok`, for the settings routes' chain view. */
  eligible: boolean;
  /** Mirror of `reason`, for the settings routes' chain view. */
  why: string;
}

export interface Resolution {
  capability: Capability;
  providerId: ProviderId | null;
  provider: ProviderDef | null;
  status: ProviderStatus;
  /** Why THIS provider (or why nothing). Renderable. */
  why: string;
  /** Every candidate in chain order, with the verdict on each. */
  considered: ProviderVerdict[];
  /** Same array under the name the settings UI reads. */
  chain: ProviderVerdict[];
}

/**
 * The ONLY provider shape allowed to leave the server. No key, no keyOverride,
 * no field that could carry one — presence and the last 4 characters, nothing
 * else, and there is deliberately no reveal path anywhere in the engine.
 */
export interface PublicProviderView {
  id: ProviderId;
  label: string;
  capabilities: readonly Capability[];
  paid: boolean;
  local: boolean;
  enabled: boolean;
  status: ProviderStatus;
  hasKey: boolean;
  last4: string | null;
  /** Which env var backs it, for the Options panel. A NAME, never a value. */
  envKeys: readonly string[];
  detail: string;
  notes: string;
}

/** Explicit opt-in is the only thing that unlocks a paid provider. */
function explicitlyEnabled(cfg: EngineConfig, id: ProviderId): boolean {
  return cfg.providers[id]?.enabled === true;
}

function isEnabled(cfg: EngineConfig, def: ProviderDef): boolean {
  const entry = cfg.providers[def.id];
  return entry ? entry.enabled : def.defaultEnabled;
}

function verdict(
  id: ProviderId,
  ok: boolean,
  reason: string,
  status: ProviderStatus,
): ProviderVerdict {
  return { id, ok, reason, status, eligible: ok, why: reason };
}

/** Judge one provider. Pure, total, never throws, never touches the network. */
export function evaluateProvider(
  cfg: EngineConfig,
  id: string,
  health?: HealthMap,
): ProviderVerdict {
  const def = getProvider(id);
  if (!def) {
    return verdict(id as ProviderId, false, `unknown provider "${id}"`, "disabled");
  }

  // 1. THE PAID GATE — first, before anything else can make it look usable.
  if (def.paid && !explicitlyEnabled(cfg, def.id)) {
    return verdict(
      def.id,
      false,
      "paid provider — refused: not explicitly enabled (no-spend rule)",
      "disabled",
    );
  }

  if (!isEnabled(cfg, def)) {
    return verdict(def.id, false, "disabled by operator", "disabled");
  }

  if (needsKey(def) && !resolveSecret(cfg, def.id)) {
    return verdict(
      def.id,
      false,
      `missing key (set ${def.envKeys[0]} or save one in Options)`,
      "missing-key",
    );
  }

  const h = health?.[def.id];
  if (h && h.reachable === false) {
    return verdict(def.id, false, `probe failed: ${h.detail}`, "unreachable");
  }

  if (h && h.reachable === true) {
    return verdict(def.id, true, "configured and probe answered", "ok");
  }

  return verdict(
    def.id,
    true,
    def.local ? "local and available" : "configured (not probed)",
    "configured",
  );
}

/** Provider status for the Options panel, independent of any chain. */
export function providerStatus(
  cfg: EngineConfig,
  id: ProviderId,
  health?: HealthMap,
): ProviderStatus {
  return evaluateProvider(cfg, id, health).status;
}

function chainFor(cfg: EngineConfig, cap: Capability): ProviderId[] {
  const chain = cfg.capabilities[cap];
  return Array.isArray(chain) ? chain : [];
}

function resolveWithConfig(
  cap: Capability,
  cfg: EngineConfig,
  health?: HealthMap,
): Resolution {
  const considered: ProviderVerdict[] = [];
  const chain = chainFor(cfg, cap);

  for (let i = 0; i < chain.length; i += 1) {
    const id = chain[i];
    const v = evaluateProvider(cfg, id, health);
    considered.push(v);
    if (!v.ok) continue;
    const def = getProvider(id)!;
    const position = i === 0 ? "first choice" : `fallback #${i}`;
    return {
      capability: cap,
      providerId: def.id,
      provider: def,
      status: v.status,
      why: `${def.label} — ${position} in the ${cap} chain: ${v.reason}`,
      considered,
      chain: considered,
    };
  }

  const why =
    chain.length === 0
      ? `no provider is configured for ${cap}`
      : `no usable provider for ${cap}: ${considered
          .map((c) => `${c.id} (${c.reason})`)
          .join("; ")}`;
  return {
    capability: cap,
    providerId: null,
    provider: null,
    status: "unreachable",
    why,
    considered,
    chain: considered,
  };
}

/**
 * Resolve one capability to a live provider. Total function: on total failure it
 * returns providerId null with a reason, so callers branch on data instead of
 * catching.
 *
 * Two forms:
 *   resolveCapability(cap, cfg, health?) → Resolution           (sync, pure)
 *   resolveCapability(cap)               → Promise<Resolution>  (reads the live
 *                                          engine.json for you — route sugar)
 */
export function resolveCapability(cap: Capability): Promise<Resolution>;
export function resolveCapability(
  cap: Capability,
  cfg: EngineConfig,
  health?: HealthMap,
): Resolution;
export function resolveCapability(
  cap: Capability,
  cfg?: EngineConfig,
  health?: HealthMap,
): Resolution | Promise<Resolution> {
  if (!cfg) {
    return readEngineConfig().then((live) => resolveWithConfig(cap, live, health));
  }
  return resolveWithConfig(cap, cfg, health);
}

/** Resolve every capability at once — the payload the Diagnostics panel wants. */
export function resolveAllCapabilities(
  cfg: EngineConfig,
  health?: HealthMap,
): Record<Capability, Resolution> {
  const out = {} as Record<Capability, Resolution>;
  for (const cap of CAPABILITIES) out[cap] = resolveCapability(cap, cfg, health);
  return out;
}

/** capability → live provider id. What the client bus displays. No secrets. */
export function activeProviderMap(
  cfg: EngineConfig,
  health?: HealthMap,
): Partial<Record<Capability, ProviderId>> {
  const out: Partial<Record<Capability, ProviderId>> = {};
  for (const cap of CAPABILITIES) {
    const r = resolveCapability(cap, cfg, health);
    if (r.providerId) out[cap] = r.providerId;
  }
  return out;
}

/**
 * The masked provider list for GET /api/engine/... — build responses from THIS
 * and nothing else. It cannot leak a key because it never carries one.
 */
export function describeProviders(
  cfg: EngineConfig,
  health?: HealthMap,
): PublicProviderView[] {
  return PROVIDERS.map((def) => {
    const v = evaluateProvider(cfg, def.id, health);
    const secret = needsKey(def) ? resolveSecret(cfg, def.id) : undefined;
    return {
      id: def.id,
      label: def.label,
      capabilities: def.capabilities,
      paid: def.paid,
      local: def.local,
      enabled: isEnabled(cfg, def),
      status: v.status,
      hasKey: hasKey(secret),
      last4: last4(secret),
      envKeys: def.envKeys,
      detail: health?.[def.id]?.detail ?? v.reason,
      notes: def.notes,
    };
  });
}

/**
 * Masked provider list read straight from the live engine.json — the one call a
 * settings route needs for GET. Never carries a credential (see
 * PublicProviderView); there is no reveal path anywhere in the engine.
 */
export async function listProviders(health?: HealthMap): Promise<PublicProviderView[]> {
  return describeProviders(await readEngineConfig(), health);
}
