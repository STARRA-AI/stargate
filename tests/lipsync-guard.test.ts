/**
 * Lip-sync fallback: spend guard + request validation (route.ts) and the
 * client seam's fail-closed behavior (lipsync.ts). NEXT_PUBLIC_LIPSYNC stays
 * "0" in .env.local — this suite only proves the guard rails hold if the
 * paid Replicate fallback is ever flipped on. No real network call is made
 * anywhere in this file: `global.fetch` is always mocked or never reached.
 */
import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import fsp from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";
import { __resetEngineConfigCache } from "../src/lib/engine/config";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_TOKEN = process.env.REPLICATE_API_TOKEN;
const ORIGINAL_CAP = process.env.LIPSYNC_MAX_PREDICTIONS;
const CFG_ENV = "STARRA_ENGINE_CONFIG_PATH";
const ORIGINAL_CFG = process.env[CFG_ENV];

function mockRequest(body: unknown): Request {
  return new Request("http://localhost/api/lipsync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A fetch mock good enough to satisfy route.ts's model-resolve + create-prediction
 * calls without ever touching the network. Records every URL it was asked to hit. */
function makeFetchMock() {
  const calls: string[] = [];
  const impl: typeof fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/v1/models/")) {
      return new Response(JSON.stringify({ latest_version: { id: "v1" } }), { status: 200 });
    }
    if (url.includes("/v1/predictions")) {
      return new Response(JSON.stringify({ id: "p1", status: "starting" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("api/lipsync route — spend guard + request validation", () => {
  // route.ts is a plain module (NextResponse works standalone outside the Next
  // runtime), so a fresh dynamic import per describe block gives each suite
  // its own module-scoped `predictionsCreated` counter.
  let POST: (req: Request) => Promise<Response>;
  let cfgDir: string;

  before(async () => {
    // The route now sits behind the engine's PAID GATE (router.ts:110-117): a
    // token is no longer consent to spend, so these spend-ceiling and
    // request-validation cases have to opt replicate in EXPLICITLY to reach the
    // code they exercise. Containment itself is proven in
    // tests/paid-containment-lipsync.test.ts.
    cfgDir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), "starra-lipsync-guard-"));
    const cfg = nodePath.join(cfgDir, "engine.json");
    await fsp.writeFile(
      cfg,
      JSON.stringify({ version: 1, providers: { replicate: { enabled: true } } }),
      "utf8",
    );
    process.env[CFG_ENV] = cfg;
    __resetEngineConfigCache();
    ({ POST } = await import("../src/app/api/lipsync/route"));
  });

  after(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_TOKEN === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = ORIGINAL_TOKEN;
    if (ORIGINAL_CAP === undefined) delete process.env.LIPSYNC_MAX_PREDICTIONS;
    else process.env.LIPSYNC_MAX_PREDICTIONS = ORIGINAL_CAP;
    if (ORIGINAL_CFG === undefined) delete process.env[CFG_ENV];
    else process.env[CFG_ENV] = ORIGINAL_CFG;
    __resetEngineConfigCache();
    await fsp.rm(cfgDir, { recursive: true, force: true });
  });

  it('returns mode:"off" when no REPLICATE_API_TOKEN is set (route.ts:51)', async () => {
    delete process.env.REPLICATE_API_TOKEN;
    const res = await POST(mockRequest({ wav: "abc" }));
    const data = (await res.json()) as { mode: string };
    assert.equal(data.mode, "off");
  });

  it("400s a POST with neither wav nor warm (route.ts:63-65)", async () => {
    process.env.REPLICATE_API_TOKEN = "fake_test_token";
    const res = await POST(mockRequest({}));
    assert.equal(res.status, 400);
    const data = (await res.json()) as { mode: string; message?: string };
    assert.equal(data.mode, "error");
  });

  it('returns mode:"off" once the per-process spend cap is hit, and makes ZERO further network calls', async () => {
    process.env.REPLICATE_API_TOKEN = "fake_test_token";
    process.env.LIPSYNC_MAX_PREDICTIONS = "1";
    const { impl, calls } = makeFetchMock();
    globalThis.fetch = impl;

    // 1st call: under the cap of 1 — proceeds, hits the mocked Replicate API,
    // and (being `warm:true`) returns immediately without polling.
    const first = await POST(mockRequest({ warm: true }));
    const firstData = (await first.json()) as { mode: string };
    assert.equal(firstData.mode, "warming");
    const callsAfterFirst = calls.length;
    assert.ok(callsAfterFirst >= 1, "expected the mock fetch to have been hit at least once");

    // 2nd call: cap is now hit — must short-circuit to mode:"off" WITHOUT
    // making any additional network call (the whole point of checking the
    // cap before touching the network).
    const second = await POST(mockRequest({ warm: true }));
    assert.equal(second.status, 200);
    const secondData = (await second.json()) as { mode: string };
    assert.equal(secondData.mode, "off");
    assert.equal(
      calls.length,
      callsAfterFirst,
      "spend guard must block the 2nd request before any fetch call",
    );
  });
});

describe("lib/voice/lipsync.ts — renderLipSync fail-closed behavior", () => {
  let renderLipSync: (wav: string, signal?: AbortSignal) => Promise<string | null>;

  before(async () => {
    ({ renderLipSync } = await import("../src/lib/voice/lipsync"));
  });

  beforeEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  after(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  const nonLiveModes = ["off", "error"] as const;
  for (const mode of nonLiveModes) {
    it(`returns null for mode:"${mode}"`, async () => {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify({ mode }), { status: 200 })) as typeof fetch;
      const result = await renderLipSync("dGVzdA==");
      assert.equal(result, null);
    });
  }

  it('returns null for mode:"live" with no video field', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ mode: "live" }), { status: 200 })) as typeof fetch;
    const result = await renderLipSync("dGVzdA==");
    assert.equal(result, null);
  });

  it('returns the URL for mode:"live" with a video field (sanity check on the happy path)', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ mode: "live", video: "https://example.invalid/clip.mp4" }), {
        status: 200,
      })) as typeof fetch;
    const result = await renderLipSync("dGVzdA==");
    assert.equal(result, "https://example.invalid/clip.mp4");
  });

  it("returns null when the underlying fetch throws (network/abort)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("simulated network failure");
    }) as typeof fetch;
    const result = await renderLipSync("dGVzdA==");
    assert.equal(result, null);
  });

  it("returns null when the server responds non-ok", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 502 })) as typeof fetch;
    const result = await renderLipSync("dGVzdA==");
    assert.equal(result, null);
  });
});
