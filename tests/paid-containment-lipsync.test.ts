/**
 * PAID CONTAINMENT — /api/lipsync.
 *
 * Replicate is PAID: ~$0.086 per prediction (verified figures in the route
 * header). Charter §0 says no spend until STARRA earns. Before this suite the
 * route's ONLY precondition was "a REPLICATE_API_TOKEN exists" — and it exists
 * in .env.local — so every POST billed a real run without ever consulting the
 * engine's paid invariant.
 *
 * What this file locks down:
 *   1. With replicate DISABLED (the shipped default, and the state of
 *      data/engine.json today) the route makes ZERO outbound calls. The proof is
 *      an injected global fetch that THROWS if it is ever invoked — a billable
 *      call cannot pass silently.
 *   2. The refusal keeps the existing harmless contract: 200 { mode: "off" },
 *      which src/lib/voice/lipsync.ts already treats as "no clip" and falls back
 *      to the free reactive face.
 *   3. The engine store is AUTHORITATIVE: a keyOverride in engine.json is the
 *      credential used, and no engine.json at all (first run) still refuses.
 *   4. The route may not read process.env.REPLICATE_API_TOKEN directly again —
 *      a static scan, so the hole cannot be reopened by a later edit.
 *
 * No network call is made anywhere in this file.
 */
import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __resetEngineConfigCache, DEFAULT_ENGINE_CONFIG } from "../src/lib/engine/config";
import { PROVIDERS, getProvider } from "../src/lib/engine/providers";

const CFG_ENV = "STARRA_ENGINE_CONFIG_PATH";
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL = {
  cfg: process.env[CFG_ENV],
  token: process.env.REPLICATE_API_TOKEN,
  cap: process.env.LIPSYNC_MAX_PREDICTIONS,
};

/** Any invocation is real money leaving the account — fail loud, not silent. */
function forbiddenFetch(): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error(`BILLABLE CALL ATTEMPTED: ${String(input)}`);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** Satisfies the two Replicate calls without touching the network. */
function allowedFetch() {
  const calls: string[] = [];
  const auth: string[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const h = (init?.headers ?? {}) as Record<string, string>;
    if (h.Authorization) auth.push(h.Authorization);
    if (url.includes("/v1/models/")) {
      return new Response(JSON.stringify({ latest_version: { id: "v1" } }), { status: 200 });
    }
    if (url.includes("/v1/predictions")) {
      return new Response(JSON.stringify({ id: "p1", status: "starting" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls, auth };
}

function req(body: unknown, raw?: string): Request {
  return new Request("http://localhost/api/lipsync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
}

describe("paid containment — /api/lipsync under the engine's paid invariant", () => {
  let route: typeof import("../src/app/api/lipsync/route");
  let dir: string;
  const fixture = (name: string) => path.join(dir, name);

  async function useConfig(name: string, contents: unknown | null) {
    if (contents !== null) await fs.writeFile(fixture(name), JSON.stringify(contents), "utf8");
    process.env[CFG_ENV] = fixture(name);
    __resetEngineConfigCache();
  }

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "starra-paid-"));
    route = await import("../src/app/api/lipsync/route");
  });

  beforeEach(() => {
    // The token IS set in Classic's .env.local. Every refusal below therefore
    // has to hold with a perfectly usable credential present — that is the
    // whole point: a key is not consent to spend.
    process.env.REPLICATE_API_TOKEN = "r8_liveLookingTokenAAAAAAAAAAAAAAAAAAAA";
    delete process.env.LIPSYNC_MAX_PREDICTIONS;
    __resetEngineConfigCache();
  });

  after(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const [k, v] of [
      [CFG_ENV, ORIGINAL.cfg],
      ["REPLICATE_API_TOKEN", ORIGINAL.token],
      ["LIPSYNC_MAX_PREDICTIONS", ORIGINAL.cap],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetEngineConfigCache();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("registry keeps replicate PAID and off by default (the invariant this route must honour)", () => {
    const def = getProvider("replicate")!;
    assert.equal(def.paid, true);
    assert.equal(def.defaultEnabled, false);
    assert.equal(DEFAULT_ENGINE_CONFIG.providers.replicate?.enabled, false);
    for (const [cap, chain] of Object.entries(DEFAULT_ENGINE_CONFIG.capabilities)) {
      for (const id of chain) {
        assert.ok(!getProvider(id)?.paid, `default ${cap} chain must not contain a paid provider`);
      }
    }
    assert.ok(PROVIDERS.some((p) => p.id === "replicate" && p.paid));
  });

  it("replicate disabled: a spoken turn makes ZERO outbound calls and returns { mode: \"off\" }", async () => {
    await useConfig("disabled.json", { version: 1, providers: { replicate: { enabled: false } } });
    const { impl, calls } = forbiddenFetch();
    globalThis.fetch = impl;

    const res = await route.POST(req({ wav: "dGVzdA==" }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { mode: "off" });
    assert.deepEqual(calls, [], "no outbound call may be attempted while replicate is disabled");
    assert.equal(route.predictionsCreated, 0, "no prediction may be counted, let alone billed");
  });

  it("replicate disabled: the CALL-OPEN warm-up (which used to bill before she spoke) makes ZERO calls", async () => {
    await useConfig("disabled.json", { version: 1, providers: { replicate: { enabled: false } } });
    const { impl, calls } = forbiddenFetch();
    globalThis.fetch = impl;

    const res = await route.POST(req({ warm: true }));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { mode: "off" });
    assert.deepEqual(calls, []);
    assert.equal(route.predictionsCreated, 0);
  });

  it("replicate disabled: even a malformed body is refused as { mode: \"off\" }, never armed", async () => {
    await useConfig("disabled.json", { version: 1, providers: { replicate: { enabled: false } } });
    const { impl, calls } = forbiddenFetch();
    globalThis.fetch = impl;

    const res = await route.POST(req(null, "{not json"));

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { mode: "off" });
    assert.deepEqual(calls, []);
  });

  it("NO engine.json at all (first run = defaults) refuses despite a usable token", async () => {
    await useConfig("absent.json", null);
    const { impl, calls } = forbiddenFetch();
    globalThis.fetch = impl;

    const res = await route.POST(req({ wav: "dGVzdA==" }));

    assert.deepEqual(await res.json(), { mode: "off" });
    assert.deepEqual(calls, []);
  });

  it("an engine.json that only flips OTHER providers on does not arm replicate", async () => {
    await useConfig("others.json", {
      version: 1,
      providers: { xai: { enabled: true }, groq: { enabled: true } },
    });
    const { impl, calls } = forbiddenFetch();
    globalThis.fetch = impl;

    assert.deepEqual(await (await route.POST(req({ wav: "dGVzdA==" }))).json(), { mode: "off" });
    assert.deepEqual(calls, []);
  });

  it("explicitly enabled but with NO credential anywhere: still no call, still { mode: \"off\" }", async () => {
    await useConfig("enabled-nokey.json", {
      version: 1,
      providers: { replicate: { enabled: true } },
    });
    delete process.env.REPLICATE_API_TOKEN;
    const { impl, calls } = forbiddenFetch();
    globalThis.fetch = impl;

    assert.deepEqual(await (await route.POST(req({ wav: "dGVzdA==" }))).json(), { mode: "off" });
    assert.deepEqual(calls, []);
  });

  it("the operator's EXPLICIT opt-in is the only thing that arms it — and the engine's keyOverride is the credential used", async () => {
    const override = "r8_overrideFromEngineJsonAAAAAAAAAAAAAAAA";
    await useConfig("enabled-key.json", {
      version: 1,
      providers: { replicate: { enabled: true, keyOverride: override } },
    });
    // No env token at all: if the route still works, resolution came from the
    // engine store, which is the single authoritative path.
    delete process.env.REPLICATE_API_TOKEN;
    const { impl, calls, auth } = allowedFetch();
    globalThis.fetch = impl;

    const res = await route.POST(req({ warm: true }));

    assert.equal((await res.json()).mode, "warming");
    assert.ok(calls.length >= 1, "an explicitly enabled paid provider is allowed to proceed");
    assert.ok(
      auth.every((a) => a === `Bearer ${override}`),
      "the engine keyOverride must be the credential on the wire",
    );
  });

  it("the route never reads process.env.REPLICATE_API_TOKEN directly (regression lock on the old hole)", () => {
    const src = readFileSync(
      path.join(import.meta.dirname, "..", "src", "app", "api", "lipsync", "route.ts"),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/([^:])\/\/[^\n]*/g, "$1")
      .replace(/^\/\/[^\n]*/gm, "");
    assert.ok(
      !/process\.env\.REPLICATE_API_TOKEN/.test(src),
      "the credential must be resolved through the engine, not read from env in the route",
    );
    assert.ok(
      /evaluateProvider|resolveCapability/.test(src),
      "the route must consult the engine's paid gate",
    );
  });
});
