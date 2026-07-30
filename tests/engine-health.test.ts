/**
 * STARRA Engine — health probes.
 *
 * Probes must be cheap, timeout-bounded, and must NEVER put a credential in a
 * URL or query string (URLs land in logs, proxies and error strings) — header
 * only. A paid provider that is not enabled must never be contacted at all: a
 * probe is a request, and a request is spend.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import { sanitizeEngineConfig } from "../src/lib/engine/config";
import { diagnostics, probeAll, probeProvider } from "../src/lib/engine/health";

const KEY_ENVS = ["GROQ_API_KEY", "XAI_API_KEY", "HF_TOKEN", "REPLICATE_API_TOKEN"] as const;
const saved: Record<string, string | undefined> = {};
const SECRET = "gsk_probeSecretValue_ABCDEFGH1234";

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

type Call = { url: string; init: RequestInit | undefined };

function recorder(
  respond: (call: Call) => Promise<Response> | Response = () =>
    new Response("[]", { status: 200 }),
) {
  const calls: Call[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(respond({ url, init }));
  };
  return { calls, fetchImpl: fetchImpl as typeof fetch };
}

describe("engine health — the key goes in a HEADER, never the URL", () => {
  it("sends Authorization and keeps the URL clean", async () => {
    process.env.GROQ_API_KEY = SECRET;
    const { calls, fetchImpl } = recorder();
    const h = await probeProvider("groq", sanitizeEngineConfig({}), { fetchImpl });
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].url.includes(SECRET), "KEY LEAKED INTO THE PROBE URL");
    assert.ok(!calls[0].url.includes("?"), "no query string on the probe at all");
    const headers = new Headers(calls[0].init?.headers);
    assert.ok(headers.get("authorization")?.includes(SECRET), "key must be sent as a header");
    assert.equal(h.reachable, true);
    assert.equal(h.status, "ok");
  });

  it("never leaks the key into the health detail on failure", async () => {
    process.env.GROQ_API_KEY = SECRET;
    const { fetchImpl } = recorder(() => {
      throw new Error(`connect ECONNREFUSED using ${SECRET}`);
    });
    const h = await probeProvider("groq", sanitizeEngineConfig({}), { fetchImpl });
    assert.equal(h.reachable, false);
    assert.equal(h.status, "unreachable");
    assert.ok(!h.detail.includes(SECRET), "KEY LEAKED INTO A HEALTH DETAIL");
    assert.ok(!JSON.stringify(h).includes(SECRET));
  });

  it("treats a non-2xx as unreachable without throwing", async () => {
    process.env.GROQ_API_KEY = SECRET;
    const { fetchImpl } = recorder(() => new Response("nope", { status: 401 }));
    const h = await probeProvider("groq", sanitizeEngineConfig({}), { fetchImpl });
    assert.equal(h.reachable, false);
    assert.match(h.detail, /401/);
  });

  it("is timeout-bounded and does not hang on a dead endpoint", async () => {
    process.env.GROQ_API_KEY = SECRET;
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const started = Date.now();
    const h = await probeProvider("groq", sanitizeEngineConfig({}), {
      fetchImpl,
      timeoutMs: 25,
    });
    assert.equal(h.reachable, false);
    assert.ok(Date.now() - started < 3_000, "must abort quickly");
  });
});

describe("engine health — no spend, no pointless requests", () => {
  it("does NOT contact a paid provider that is not explicitly enabled", async () => {
    process.env.REPLICATE_API_TOKEN = "r8_paid_token_value_1234567890";
    const { calls, fetchImpl } = recorder();
    const h = await probeProvider("replicate", sanitizeEngineConfig({}), { fetchImpl });
    assert.equal(calls.length, 0, "A PAID ENDPOINT WAS CONTACTED");
    assert.equal(h.reachable, null);
    assert.equal(h.status, "disabled");
  });

  it("does not contact a provider with no key", async () => {
    const { calls, fetchImpl } = recorder();
    const h = await probeProvider("groq", sanitizeEngineConfig({}), { fetchImpl });
    assert.equal(calls.length, 0);
    assert.equal(h.status, "missing-key");
    assert.equal(h.reachable, null);
  });

  it("reports probe-less local providers without any network call", async () => {
    const { calls, fetchImpl } = recorder();
    const h = await probeProvider("webspeech", sanitizeEngineConfig({}), { fetchImpl });
    assert.equal(calls.length, 0);
    assert.equal(h.reachable, null);
    assert.equal(h.status, "configured");
  });

  it("probeAll returns an entry per provider and never rejects", async () => {
    process.env.GROQ_API_KEY = SECRET;
    const { fetchImpl } = recorder(({ url }) => {
      if (url.includes("groq")) return new Response("[]", { status: 200 });
      throw new Error("boom");
    });
    const map = await probeAll(sanitizeEngineConfig({}), { fetchImpl, timeoutMs: 50 });
    assert.equal(map.groq?.reachable, true);
    assert.ok(Object.keys(map).length >= 5);
    assert.ok(!JSON.stringify(map).includes(SECRET));
  });
});

describe("engine health — diagnostics", () => {
  it("answers 'what is broken right now' per capability", async () => {
    process.env.GROQ_API_KEY = SECRET;
    const { fetchImpl } = recorder();
    const d = await diagnostics(sanitizeEngineConfig({}), { fetchImpl, timeoutMs: 50 });
    assert.equal(d.capabilities.brain.providerId, "groq");
    assert.equal(d.capabilities.lipsync.providerId, "viseme-bank");
    assert.ok(Array.isArray(d.broken));
    assert.ok(Array.isArray(d.providers));
    assert.ok(!JSON.stringify(d).includes(SECRET), "diagnostics must be safe to render");
  });

  it("lists a capability with no usable provider as broken", async () => {
    const { fetchImpl } = recorder();
    const cfg = sanitizeEngineConfig({ capabilities: { brain: ["groq", "xai"] } });
    const d = await diagnostics(cfg, { fetchImpl, timeoutMs: 50 });
    assert.equal(d.capabilities.brain.providerId, null);
    assert.ok(
      d.broken.some((b) => b.capability === "brain"),
      "an unroutable capability must appear in the broken list",
    );
  });
});
