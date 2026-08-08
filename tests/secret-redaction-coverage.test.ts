/**
 * SECRET REDACTION COVERAGE — the five LIVE provider credentials (xAI, Groq,
 * HuggingFace, Replicate, Jina) must never survive into a log line, an
 * ops-feed event, or an HTTP response.
 *
 * Division B / Security Hardening audit (2026-08-07). Two things under test:
 *
 *  1. engine/redact.ts's redactSecrets() — the deck's one scrubbing
 *     implementation (src/lib/engine/redact.ts:126) — against a realistic
 *     leak string per provider (Bearer header / URL query param / JSON body),
 *     exactly the three shapes named in the audit brief. Callers that pass
 *     the resolved key value into the `secrets` argument (as
 *     src/lib/llm/hosted.ts:321,326,355 and src/app/api/lipsync/route.ts:242,
 *     281,305 already do) get full coverage regardless of shape.
 *
 *  2. keys.ts's new redactLiveProviderSecrets()/LIVE_PROVIDER_ENV_NAMES
 *     (src/lib/keys.ts) — a single value list covering all five providers,
 *     added because three of them (HF_TOKEN, REPLICATE_API_TOKEN,
 *     JINA_API_KEY) are resolved directly from process.env at their own call
 *     sites and never touch keys.ts's own vault.
 *
 * AUDIT FINDING, pinned by the last describe block: engine/redact.ts's
 * SHAPE_RULES (src/lib/engine/redact.ts:24-35) cover xai-, gsk_, hf_ and r8_
 * prefixes but have NO pattern for Jina's `jina_` prefix (verified format:
 * https://ai-sdk.dev/providers/community-providers/jina-ai,
 * https://github.com/jina-ai/reader — "automatically read from ... JINA_API_KEY").
 * A Jina key can therefore ONLY be scrubbed by VALUE, never by shape alone —
 * any call site that doesn't pass it into `secrets` (src/lib/tools/reach.ts's
 * reachRead() currently does not call redactSecrets/safeErrorMessage at all)
 * has no net under it. Escalated to the executive; not fixable inside
 * keys.ts, since the shape rules live in src/lib/engine/redact.ts.
 *
 * Run: npx --yes tsx --test tests/*.test.ts   (package.json -> test:v2)
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { redactSecrets } from "../src/lib/engine/redact";
import {
  LIVE_PROVIDER_ENV_NAMES,
  liveProviderSecretValues,
  redactLiveProviderSecrets,
} from "../src/lib/keys";

// Realistically-shaped SYNTHETIC fakes — never real credentials. Formats
// verified against each provider's own docs/SDK examples, not memory:
//  - xAI:        xai-...            (src/lib/keys.ts:62, hint field)
//  - Groq:       gsk_...            (src/lib/keys.ts:69, hint field)
//  - HuggingFace: hf_...            (src/lib/engine/providers.ts:213 HF_TOKEN)
//  - Replicate:  r8_...             (src/lib/engine/providers.ts:225 REPLICATE_API_TOKEN)
//  - Jina:       jina_...           (ai-sdk.dev/providers/community-providers/jina-ai)
const PROVIDERS = [
  { name: "xai", env: "XAI_API_KEY", key: "xai-Synth9fK2mQ7tR4wL8sJ0nH5cV3bZ6yX1d" },
  { name: "groq", env: "GROQ_API_KEY", key: "gsk_Synth0OqkPvW3s7TnJ1mHbF4dQ8aZrY6xC2" },
  { name: "huggingface", env: "HF_TOKEN", key: "hf_SynthQwErTyUiOpAsDfGhJkLzXcVbNm1234" },
  { name: "replicate", env: "REPLICATE_API_TOKEN", key: "r8_SynthA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5" },
  { name: "jina", env: "JINA_API_KEY", key: "jina_Synth7h3f4k3k3yD03sN0t3x1st9a8b7c6d" },
] as const;

/** The three leak shapes the audit brief named. */
function leakStrings(key: string) {
  return {
    bearerHeader: `Authorization: Bearer ${key}`,
    urlQueryParam: `https://api.example.com/v1/probe?token=${key}&other=1`,
    jsonEmbedded: `{"error":"upstream 401","detail":"invalid credentials for key ${key}","apiKey":"${key}"}`,
  };
}

describe("secret redaction coverage — five live providers, value-based (realistic caller)", () => {
  for (const p of PROVIDERS) {
    describe(p.name, () => {
      const leaks = leakStrings(p.key);
      for (const [shape, text] of Object.entries(leaks)) {
        it(`redactSecrets scrubs the ${shape} leak down to no secret value`, () => {
          const out = redactSecrets(text, [p.key]);
          assert.ok(
            !out.includes(p.key),
            `${p.name} ${shape}: secret value survived redaction — ${out}`,
          );
        });
      }
    });
  }
});

describe("secret redaction coverage — keys.ts redactLiveProviderSecrets()", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const p of PROVIDERS) saved[p.env] = process.env[p.env];
  });

  afterEach(() => {
    for (const p of PROVIDERS) {
      if (saved[p.env] === undefined) delete process.env[p.env];
      else process.env[p.env] = saved[p.env];
    }
  });

  it("LIVE_PROVIDER_ENV_NAMES names exactly the five live provider env vars", () => {
    assert.deepEqual(
      [...LIVE_PROVIDER_ENV_NAMES].sort(),
      ["GROQ_API_KEY", "HF_TOKEN", "JINA_API_KEY", "REPLICATE_API_TOKEN", "XAI_API_KEY"],
    );
  });

  it("liveProviderSecretValues() reads only the vars that are actually set", () => {
    for (const p of PROVIDERS) delete process.env[p.env];
    assert.deepEqual(liveProviderSecretValues(), []);
    process.env.JINA_API_KEY = PROVIDERS[4].key;
    assert.deepEqual(liveProviderSecretValues(), [PROVIDERS[4].key]);
  });

  for (const p of PROVIDERS) {
    it(`scrubs a live ${p.name} key sourced from its own env var, across all three leak shapes`, () => {
      for (const other of PROVIDERS) delete process.env[other.env];
      process.env[p.env] = p.key;
      const leaks = leakStrings(p.key);
      for (const [shape, text] of Object.entries(leaks)) {
        const out = redactLiveProviderSecrets(text);
        assert.ok(
          !out.includes(p.key),
          `${p.name} ${shape}: secret value survived redactLiveProviderSecrets — ${out}`,
        );
      }
    });
  }

  it("never throws on non-string input and always returns a string", () => {
    assert.equal(typeof redactLiveProviderSecrets(undefined), "string");
    assert.equal(typeof redactLiveProviderSecrets(null), "string");
    assert.equal(typeof redactLiveProviderSecrets({ nested: { a: 1 } }), "string");
  });
});

describe("secret redaction coverage — AUDIT FINDING: shape-only gap (no value list supplied)", () => {
  // Mirrors a caller that forgets (or, like reach.ts today, never attempts) to
  // pass the resolved key into `secrets` — coverage then depends entirely on
  // engine/redact.ts's SHAPE_RULES (src/lib/engine/redact.ts:24-35).
  it("xai / groq / huggingface / replicate ARE caught by shape alone", () => {
    for (const p of PROVIDERS.filter((x) => x.name !== "jina")) {
      const out = redactSecrets(`Authorization: Bearer ${p.key}`, []);
      assert.ok(!out.includes(p.key), `${p.name}: expected shape rule to catch this — ${out}`);
    }
  });

  it("jina is NOT caught by shape alone when the leak has no Bearer/assignment wrapper", () => {
    const jina = PROVIDERS.find((p) => p.name === "jina")!;
    // A bare key value with no "Bearer " / "key=" / "token=" wrapper around it —
    // e.g. the literal value embedded mid-sentence in an upstream error body.
    const bare = `upstream rejected credential ${jina.key} for this request`;
    const out = redactSecrets(bare, []);
    assert.ok(
      out.includes(jina.key),
      "engine/redact.ts grew a Jina shape rule — great, but this test (and the " +
        "escalation note in tests/secret-redaction-coverage.test.ts) is now stale " +
        "and should be updated to reflect the closed gap",
    );
  });
});
