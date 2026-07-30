/**
 * STARRA Engine — capability router.
 *
 * The router is the thing that ends "every surface guesses independently": one
 * ordered chain per capability, first provider that is enabled AND configured
 * AND (if probed) healthy, plus the REASON so the HUD can show it. It must
 * degrade, never throw — and it must refuse a PAID provider unless the operator
 * explicitly enabled it (Classic's no-spend rule as a machine-checked rule).
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import { sanitizeEngineConfig, type EngineConfig } from "../src/lib/engine/config";
import { CAPABILITIES, PROVIDERS, type ProviderHealth } from "../src/lib/engine/providers";
import {
  describeProviders,
  listProviders,
  resolveAllCapabilities,
  resolveCapability,
} from "../src/lib/engine/router";

const KEY_ENVS = [
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "HF_TOKEN",
  "REPLICATE_API_TOKEN",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEY_ENVS) {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }
});

after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function cfgWith(patch: unknown): EngineConfig {
  return sanitizeEngineConfig(patch);
}

const healthy = (id: string): ProviderHealth => ({
  id,
  status: "ok",
  reachable: true,
  detail: "ok",
  checkedAt: 1,
});
const down = (id: string): ProviderHealth => ({
  id,
  status: "unreachable",
  reachable: false,
  detail: "probe failed",
  checkedAt: 1,
});

describe("engine router — brain chain", () => {
  it("picks the first configured provider and says why", () => {
    process.env.GROQ_API_KEY = "gsk_test_key_value_1234";
    const r = resolveCapability("brain", cfgWith({}));
    assert.equal(r.providerId, "groq");
    assert.ok(r.why.length > 0);
    assert.ok(!r.why.includes("gsk_test_key_value_1234"), "reason must not leak the key");
  });

  it("falls past a provider with no key to the next in the chain", () => {
    process.env.XAI_API_KEY = "xai-test-key-value-1234";
    const r = resolveCapability("brain", cfgWith({}));
    assert.equal(r.providerId, "xai");
    const groq = r.considered.find((c) => c.id === "groq");
    assert.ok(groq && !groq.ok);
    assert.match(groq!.reason, /key/i);
  });

  it("falls all the way back to local Ollama when no hosted key exists", () => {
    const r = resolveCapability("brain", cfgWith({}));
    assert.equal(r.providerId, "ollama", "the local free floor must always be reachable");
  });

  it("skips a disabled provider even when its key is present", () => {
    process.env.GROQ_API_KEY = "gsk_test_key_value_1234";
    const r = resolveCapability("brain", cfgWith({ providers: { groq: { enabled: false } } }));
    assert.notEqual(r.providerId, "groq");
    const groq = r.considered.find((c) => c.id === "groq");
    assert.match(groq!.reason, /disabl/i);
  });

  it("skips a provider a probe says is unreachable", () => {
    process.env.GROQ_API_KEY = "gsk_test_key_value_1234";
    process.env.XAI_API_KEY = "xai-test-key-value-1234";
    const r = resolveCapability("brain", cfgWith({}), { groq: down("groq") });
    assert.equal(r.providerId, "xai");
  });

  it("uses a healthy probe result as confirmation, not an obstacle", () => {
    process.env.GROQ_API_KEY = "gsk_test_key_value_1234";
    const r = resolveCapability("brain", cfgWith({}), { groq: healthy("groq") });
    assert.equal(r.providerId, "groq");
    assert.equal(r.status, "ok");
  });

  it("returns null with a reason when EVERY provider is down — never throws", () => {
    const cfg = cfgWith({ capabilities: { brain: ["groq", "xai"] } });
    let r!: ReturnType<typeof resolveCapability>;
    assert.doesNotThrow(() => {
      r = resolveCapability("brain", cfg);
    });
    assert.equal(r.providerId, null);
    assert.equal(r.provider, null);
    assert.ok(r.why.length > 0);
    assert.equal(r.considered.length, 2);
    assert.ok(r.considered.every((c) => !c.ok));
  });
});

describe("engine router — voice / lipsync / realtime chains", () => {
  it("voice prefers Ara (xai) when the key is present", () => {
    process.env.XAI_API_KEY = "xai-test-key-value-1234";
    assert.equal(resolveCapability("voice", cfgWith({})).providerId, "xai");
  });

  it("voice degrades to piper, then to web speech, with no key at all", () => {
    assert.equal(resolveCapability("voice", cfgWith({})).providerId, "piper");
    assert.equal(
      resolveCapability("voice", cfgWith({ providers: { piper: { enabled: false } } }))
        .providerId,
      "webspeech",
    );
  });

  it("lipsync resolves to the local free viseme bank", () => {
    const r = resolveCapability("lipsync", cfgWith({}));
    assert.equal(r.providerId, "viseme-bank");
  });

  it("realtime and memory resolve without a network probe", () => {
    process.env.XAI_API_KEY = "xai-test-key-value-1234";
    assert.equal(resolveCapability("realtime", cfgWith({})).providerId, "xai");
    assert.equal(resolveCapability("memory", cfgWith({})).providerId, "local-memory");
  });

  it("resolves every declared capability, always with a reason", () => {
    const all = resolveAllCapabilities(cfgWith({}));
    for (const cap of CAPABILITIES) {
      assert.ok(cap in all, `${cap} missing from resolveAll`);
      assert.ok(all[cap].why.length > 0);
    }
  });
});

describe("engine router — THE PAID INVARIANT", () => {
  const chain = { capabilities: { lipsync: ["replicate", "viseme-bank"] } };

  it("REFUSES a paid provider that is not explicitly enabled, key or not", () => {
    process.env.REPLICATE_API_TOKEN = "r8_test_key_value_1234567890";
    const r = resolveCapability("lipsync", cfgWith(chain));
    assert.equal(r.providerId, "viseme-bank", "must not route to a paid provider by default");
    const rep = r.considered.find((c) => c.id === "replicate");
    assert.ok(rep && !rep.ok);
    assert.match(rep!.reason, /paid/i);
  });

  it("routes to a paid provider ONLY when explicitly enabled and configured", () => {
    process.env.REPLICATE_API_TOKEN = "r8_test_key_value_1234567890";
    const r = resolveCapability(
      "lipsync",
      cfgWith({ ...chain, providers: { replicate: { enabled: true } } }),
    );
    assert.equal(r.providerId, "replicate");
  });

  it("still refuses an enabled paid provider with no key, and degrades", () => {
    const r = resolveCapability(
      "lipsync",
      cfgWith({ ...chain, providers: { replicate: { enabled: true } } }),
    );
    assert.equal(r.providerId, "viseme-bank");
  });

  it("marks replicate as paid in the registry", () => {
    const rep = PROVIDERS.find((p) => p.id === "replicate");
    assert.ok(rep, "replicate must exist in the registry so it can be refused by name");
    assert.equal(rep!.paid, true);
  });
});

describe("engine router — the public provider view never leaks a key", () => {
  it("exposes hasKey + last4 only", () => {
    const secret = "gsk_verySecretValue_ABCDEFGH1234";
    process.env.GROQ_API_KEY = secret;
    const view = describeProviders(cfgWith({}), { groq: healthy("groq") });
    const blob = JSON.stringify(view);
    assert.ok(!blob.includes(secret), "PLAINTEXT KEY LEAKED INTO THE VIEW");
    assert.ok(!blob.includes(secret.slice(0, 10)), "leading fragment leaked");
    const groq = view.find((v) => v.id === "groq")!;
    assert.equal(groq.hasKey, true);
    assert.equal(groq.last4, secret.slice(-4));
    assert.equal(groq.paid, false);
    assert.equal(typeof groq.enabled, "boolean");
    assert.ok(Array.isArray(groq.capabilities));
    assert.ok(!("keyOverride" in groq), "no key field of any name");
    assert.ok(!("key" in groq));
  });

  it("reports missing-key / disabled / paid statuses for the diagnostics panel", () => {
    const view = describeProviders(
      cfgWith({ providers: { piper: { enabled: false } } }),
    );
    const byId = new Map(view.map((v) => [v.id, v]));
    assert.equal(byId.get("groq")!.status, "missing-key");
    assert.equal(byId.get("piper")!.status, "disabled");
    assert.equal(byId.get("replicate")!.status, "disabled");
    assert.equal(byId.get("replicate")!.paid, true);
  });
});

describe("engine router — live-config convenience forms (used by the settings routes)", () => {
  const CFG_ENV = "STARRA_ENGINE_CONFIG_PATH";
  let prevCfgPath: string | undefined;

  it("resolveCapability(cap) reads the live config and still resolves", async () => {
    prevCfgPath = process.env[CFG_ENV];
    process.env[CFG_ENV] = "/nonexistent-starra-engine/engine.json"; // defaults path
    try {
      const r = await resolveCapability("lipsync");
      assert.equal(r.providerId, "viseme-bank");
      assert.ok(Array.isArray(r.chain), "chain alias present for the settings UI");
      assert.equal(r.chain, r.considered, "chain and considered are the same array");
      assert.equal(r.chain[0].eligible, r.chain[0].ok, "eligible mirrors ok");
      assert.equal(r.chain[0].why, r.chain[0].reason, "why mirrors reason");
    } finally {
      if (prevCfgPath === undefined) delete process.env[CFG_ENV];
      else process.env[CFG_ENV] = prevCfgPath;
    }
  });

  it("listProviders() returns the masked view with no key in it", async () => {
    prevCfgPath = process.env[CFG_ENV];
    process.env[CFG_ENV] = "/nonexistent-starra-engine/engine.json";
    const secret = "gsk_listProvidersSecret_ABCD1234";
    process.env.GROQ_API_KEY = secret;
    try {
      const list = await listProviders();
      assert.ok(list.length >= 5);
      assert.ok(!JSON.stringify(list).includes(secret), "PLAINTEXT KEY LEAKED FROM listProviders");
      assert.equal(list.find((p) => p.id === "groq")!.last4, secret.slice(-4));
    } finally {
      if (prevCfgPath === undefined) delete process.env[CFG_ENV];
      else process.env[CFG_ENV] = prevCfgPath;
    }
  });
});
