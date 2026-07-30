/**
 * ERROR REDACTION — upstream failure bodies that reach the screen.
 *
 * The leak this closes (board MAJOR 3): /api/realtime read the raw xAI error
 * body and returned it verbatim as { mode:"error", message } — and that string
 * is rendered, not just logged:
 *   route body -> src/lib/voice/useVoiceCall.ts:927 handleFatalError(data.message)
 *              -> :681 setError(message)
 *              -> src/components/bridge/VoiceCallOverlay.tsx:392 rendered as text
 * Trigger is ordinary: any xAI non-2xx — a rotated key 401, a burst 429.
 *
 * The same pattern lived in /api/lipsync (the create-prediction body, the
 * upstream prediction `error` field, and the catch-all exception message).
 *
 * Every case below puts a credential in the upstream body in a DIFFERENT shape
 * and proves it cannot survive: bare, inside JSON, inside a URL query, as a
 * Bearer header echo, as an opaque value with no recognisable shape at all
 * (caught only by the engine's live secret set), and past the 200-character
 * truncation point (proving redaction runs BEFORE the slice, not after).
 *
 * No network call is made anywhere in this file — global fetch is always mocked.
 */
import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __resetEngineConfigCache } from "../src/lib/engine/config";

const CFG_ENV = "STARRA_ENGINE_CONFIG_PATH";
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL = {
  cfg: process.env[CFG_ENV],
  xai: process.env.XAI_API_KEY,
  replicate: process.env.REPLICATE_API_TOKEN,
  cap: process.env.LIPSYNC_MAX_PREDICTIONS,
};

/** Shaped like a real xAI key. */
const SHAPED_XAI = "xai-AbCdEf0123456789GhIjKlMnOp";
/** No recognisable shape — only value-based redaction can catch this one. */
const OPAQUE_XAI = "QQzz7788opaqueLiveValue";
/** Shaped like a real Replicate token. */
const SHAPED_R8 = "r8_AbCdEf0123456789GhIjKlMnOp";

function assertScrubbed(message: unknown, secrets: string[]) {
  assert.equal(typeof message, "string", "the route must still return a string message");
  const m = message as string;
  for (const s of secrets) {
    assert.ok(!m.includes(s), `credential survived redaction in: ${JSON.stringify(m)}`);
  }
  assert.ok(m.includes("[REDACTED_KEY]"), `expected a redaction marker in: ${JSON.stringify(m)}`);
}

function mockUpstream(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

function throwingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

// ── /api/realtime ──────────────────────────────────────────────────────────

describe("error redaction — /api/realtime upstream body never reaches the screen with a key in it", () => {
  let POST: () => Promise<Response>;
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "starra-redact-rt-"));
    const cfg = path.join(dir, "engine.json");
    await fs.writeFile(cfg, JSON.stringify({ version: 1, providers: { xai: { enabled: true } } }));
    process.env[CFG_ENV] = cfg;
    // The LIVE secret, opaque on purpose: the engine collects it from the env
    // and must scrub it by value even though it matches no provider key shape.
    process.env.XAI_API_KEY = OPAQUE_XAI;
    __resetEngineConfigCache();
    ({ POST } = await import("../src/app/api/realtime/route"));
  });

  after(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const [k, v] of [
      [CFG_ENV, ORIGINAL.cfg],
      ["XAI_API_KEY", ORIGINAL.xai],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetEngineConfigCache();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("401 with a bare shaped key in the body", async () => {
    globalThis.fetch = mockUpstream(401, `Incorrect API key provided: ${SHAPED_XAI}. Rotate it.`);
    const res = await POST();
    const data = (await res.json()) as { mode: string; message: string };
    assert.equal(res.status, 502);
    assert.equal(data.mode, "error");
    assertScrubbed(data.message, [SHAPED_XAI]);
  });

  it("401 with the key inside a JSON envelope AND inside a URL query value", async () => {
    globalThis.fetch = mockUpstream(
      401,
      JSON.stringify({
        error: {
          message: `auth failed for ${SHAPED_XAI}`,
          api_key: SHAPED_XAI,
          docs: `https://api.x.ai/v1/realtime?api_key=${SHAPED_XAI}&trace=1`,
        },
      }),
    );
    const res = await POST();
    const data = (await res.json()) as { mode: string; message: string };
    assert.equal(res.status, 502);
    assertScrubbed(data.message, [SHAPED_XAI]);
  });

  it("429 echoing the Authorization header back", async () => {
    globalThis.fetch = mockUpstream(
      429,
      `rate limit exceeded (request had Authorization: Bearer ${SHAPED_XAI})`,
    );
    const res = await POST();
    const data = (await res.json()) as { message: string };
    assertScrubbed(data.message, [SHAPED_XAI]);
  });

  it("403 whose body contains the LIVE opaque key — no shape rule can match it, only the engine's secret set", async () => {
    globalThis.fetch = mockUpstream(403, `account blocked: quota for ${OPAQUE_XAI} exhausted`);
    const res = await POST();
    const data = (await res.json()) as { message: string };
    assertScrubbed(data.message, [OPAQUE_XAI]);
  });

  it("redacts BEFORE truncating: a key STRADDLING the 200-char cut cannot leak its head", async () => {
    // Arithmetic: the route prefixes "xAI 500: " (9 chars), so 160 chars of
    // filler + "key=" puts the 28-char key at index 173..201 — it STRADDLES the
    // cut, and a naive slice(0, 200) keeps 27 of its 28 characters. Redaction has
    // to run first; the marker then lands at 173..187, inside the kept slice.
    const filler = "upstream detail ".repeat(10);
    const head = SHAPED_XAI.slice(0, 20);
    globalThis.fetch = mockUpstream(500, `${filler}key=${SHAPED_XAI} tail`);
    const res = await POST();
    const data = (await res.json()) as { message: string };
    assert.ok(!data.message.includes(SHAPED_XAI), "key must not survive anywhere in the message");
    assert.ok(!data.message.includes(head), `partial key leaked: ${JSON.stringify(data.message)}`);
    assert.ok(data.message.includes("[REDACTED_KEY]"), "redaction must land inside the kept slice");
    assert.ok(data.message.length <= 200, "the 200-char message contract is preserved");
  });

  it("a thrown transport error carrying the key is scrubbed too (catch path)", async () => {
    globalThis.fetch = throwingFetch(`connect ECONNREFUSED while sending ${SHAPED_XAI}`);
    const res = await POST();
    const data = (await res.json()) as { mode: string; message: string };
    assert.equal(data.mode, "error");
    assertScrubbed(data.message, [SHAPED_XAI]);
  });

  it("a clean upstream failure still says something useful (redaction must not blank the diagnosis)", async () => {
    globalThis.fetch = mockUpstream(503, "upstream unavailable");
    const res = await POST();
    const data = (await res.json()) as { message: string };
    assert.ok(data.message.length > 0);
    assert.ok(/503|unavailable/i.test(data.message), `unhelpful message: ${data.message}`);
  });
});

// ── /api/lipsync ───────────────────────────────────────────────────────────

describe("error redaction — /api/lipsync upstream bodies", () => {
  let route: typeof import("../src/app/api/lipsync/route");
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "starra-redact-ls-"));
    const cfg = path.join(dir, "engine.json");
    // Replicate EXPLICITLY enabled here only so the error paths are reachable at
    // all. Paid containment itself is proven in paid-containment-lipsync.test.ts.
    await fs.writeFile(
      cfg,
      JSON.stringify({
        version: 1,
        providers: { replicate: { enabled: true, keyOverride: SHAPED_R8 } },
      }),
    );
    process.env[CFG_ENV] = cfg;
    delete process.env.REPLICATE_API_TOKEN;
    process.env.LIPSYNC_MAX_PREDICTIONS = "99";
    __resetEngineConfigCache();
    route = await import("../src/app/api/lipsync/route");
  });

  beforeEach(() => {
    __resetEngineConfigCache();
  });

  after(async () => {
    globalThis.fetch = ORIGINAL_FETCH;
    for (const [k, v] of [
      [CFG_ENV, ORIGINAL.cfg],
      ["REPLICATE_API_TOKEN", ORIGINAL.replicate],
      ["LIPSYNC_MAX_PREDICTIONS", ORIGINAL.cap],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    __resetEngineConfigCache();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const req = (body: unknown) =>
    new Request("http://localhost/api/lipsync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("a create-prediction failure body containing the token is scrubbed", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/models/")) {
        return new Response(JSON.stringify({ latest_version: { id: "v1" } }), { status: 200 });
      }
      return new Response(`unauthorized: token ${SHAPED_R8} is revoked`, { status: 401 });
    }) as unknown as typeof fetch;

    const res = await route.POST(req({ wav: "dGVzdA==" }));
    const data = (await res.json()) as { mode: string; message: string };
    assert.equal(data.mode, "error");
    assertScrubbed(data.message, [SHAPED_R8]);
  });

  it("an upstream prediction `error` field containing the token is scrubbed", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/models/")) {
        return new Response(JSON.stringify({ latest_version: { id: "v1" } }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ id: "p1", status: "failed", error: `render failed for ${SHAPED_R8}` }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const res = await route.POST(req({ wav: "dGVzdA==" }));
    const data = (await res.json()) as { mode: string; message: string };
    assert.equal(data.mode, "error");
    assertScrubbed(data.message, [SHAPED_R8]);
  });

  it("a thrown transport error carrying the token is scrubbed (catch path)", async () => {
    globalThis.fetch = throwingFetch(`socket hang up (Bearer ${SHAPED_R8})`);
    const res = await route.POST(req({ wav: "dGVzdA==" }));
    const data = (await res.json()) as { mode: string; message: string };
    assert.equal(data.mode, "error");
    assertScrubbed(data.message, [SHAPED_R8]);
  });
});
