/**
 * STARRA ENGINE — HEALTH PROBES. SERVER-ONLY.
 *
 * Rules baked in, because this is the module most likely to leak or to cost:
 *   · THE KEY GOES IN A HEADER. Never a URL, never a query string — URLs end up
 *     in logs, in proxies and in error strings.
 *   · A PAID PROVIDER THAT IS NOT ENABLED IS NEVER CONTACTED. A probe is a
 *     request and a request is spend, so the paid gate is checked BEFORE fetch.
 *   · NO PROBE, NO CALL. A provider with no key, or nothing to probe (local /
 *     browser), returns a verdict without touching the network.
 *   · TIMEOUT-BOUNDED with AbortController + setTimeout — not AbortSignal.timeout,
 *     which is newer than this project's floor.
 *   · EVERY detail string passes through safeErrorMessage with the live secret
 *     list, so a probe failure can never print a credential.
 */

import {
  PROVIDERS,
  assertServerOnly,
  getProvider,
  type Capability,
  type HealthMap,
  type ProviderHealth,
  type ProviderId,
} from "./providers";
import {
  collectSecretValues,
  providerBaseUrl,
  readEngineConfig,
  resolveSecret,
  type EngineConfig,
} from "./config";
import { redactUrl, safeErrorMessage } from "./redact";
import {
  describeProviders,
  evaluateProvider,
  resolveAllCapabilities,
  type PublicProviderView,
  type Resolution,
} from "./router";

assertServerOnly("health.ts");

export const DEFAULT_PROBE_TIMEOUT_MS = 3_500;

export interface ProbeOptions {
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function health(
  id: string,
  status: ProviderHealth["status"],
  reachable: boolean | null,
  detail: string,
  latencyMs: number | null = null,
): ProviderHealth {
  return {
    id,
    status,
    reachable,
    detail,
    checkedAt: Date.now(),
    // Mirrors for the settings routes — same truth, friendlier names.
    ok: reachable === true,
    latencyMs,
    error: reachable === false ? detail : null,
  };
}

/**
 * Probe one provider. Resolves — always. Never rejects, never throws, never
 * contacts a provider it is not allowed to contact.
 *
 * `cfg` is optional: omit it and the live engine.json is read for you, which is
 * what a settings route wants (`await probeProvider(id)`).
 */
export async function probeProvider(
  id: string,
  cfg?: EngineConfig,
  opts: ProbeOptions = {},
): Promise<ProviderHealth> {
  const config = cfg ?? (await readEngineConfig());
  return probeWithConfig(id, config, opts);
}

async function probeWithConfig(
  id: string,
  cfg: EngineConfig,
  opts: ProbeOptions,
): Promise<ProviderHealth> {
  const secrets = collectSecretValues(cfg);
  const def = getProvider(id);
  if (!def) return health(id, "disabled", null, `unknown provider "${id}"`);

  // Paid gate / disabled / missing key — all decided WITHOUT a request.
  const verdict = evaluateProvider(cfg, def.id);
  if (!verdict.ok) return health(def.id, verdict.status, null, verdict.reason);

  if (!def.probe) {
    return health(def.id, "configured", null, "nothing to probe (local capability)");
  }

  const base = providerBaseUrl(cfg, def.id);
  if (!base) {
    return health(def.id, "unreachable", false, "no endpoint configured");
  }
  const url = `${base}${def.probe.path}`;

  const key = def.envKeys.length > 0 ? resolveSecret(cfg, def.id) : undefined;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (def.probe.headers && key) Object.assign(headers, def.probe.headers(key));

  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await doFetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      return health(
        def.id,
        "unreachable",
        false,
        `HTTP ${res.status} from ${redactUrl(url, secrets)}`,
        Date.now() - started,
      );
    }
    return health(def.id, "ok", true, `answered ${res.status}`, Date.now() - started);
  } catch (err) {
    return health(
      def.id,
      "unreachable",
      false,
      safeErrorMessage(err, secrets),
      Date.now() - started,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every provider in parallel. One bad probe cannot fail the batch. */
export async function probeAll(cfg: EngineConfig, opts: ProbeOptions = {}): Promise<HealthMap> {
  const entries = await Promise.all(
    PROVIDERS.map(async (def): Promise<[ProviderId, ProviderHealth]> => {
      try {
        return [def.id, await probeProvider(def.id, cfg, opts)];
      } catch (err) {
        return [
          def.id,
          health(def.id, "unreachable", false, safeErrorMessage(err, collectSecretValues(cfg))),
        ];
      }
    }),
  );
  const out: HealthMap = {};
  for (const [id, h] of entries) out[id] = h;
  return out;
}

export interface BrokenItem {
  capability: Capability;
  providerId: ProviderId | null;
  why: string;
}

export interface EngineDiagnostics {
  at: number;
  providers: PublicProviderView[];
  capabilities: Record<Capability, Resolution>;
  /** "What is broken right now" — the first thing Classic reads. */
  broken: BrokenItem[];
}

/**
 * Full picture: masked providers, live routing per capability, and the broken
 * list. Everything here is safe to render — asserted by tests.
 */
export async function diagnostics(
  cfg: EngineConfig,
  opts: ProbeOptions = {},
): Promise<EngineDiagnostics> {
  const healthMap = await probeAll(cfg, opts);
  const capabilities = resolveAllCapabilities(cfg, healthMap);
  const broken: BrokenItem[] = [];
  for (const [cap, resolution] of Object.entries(capabilities) as Array<
    [Capability, Resolution]
  >) {
    if (!resolution.providerId) {
      broken.push({ capability: cap, providerId: null, why: resolution.why });
      continue;
    }
    const h = healthMap[resolution.providerId];
    if (h && h.reachable === false) {
      broken.push({
        capability: cap,
        providerId: resolution.providerId,
        why: `${resolution.providerId}: ${h.detail}`,
      });
    }
  }
  return {
    at: Date.now(),
    providers: describeProviders(cfg, healthMap),
    capabilities,
    broken,
  };
}
